// services/billScanService.js
// 營運費用「掃碼入帳」
//   前端負責把條碼分組成一張張帳單（key / bill_ym / amount / due_date）
//   這裡負責：
//     resolve(items) → 每張帳單對到哪個 fact / 門市、是否重複
//     commit(items)  → 建立營運費用 + 分帳（year_month = 帳單年月）+ 記住條碼對應

const supabase = require('../config/supabase');

const YM_RE = /^\d{4}-\d{2}$/;

function prevMonthRange(ym) {
  const [y, m] = ym.split('-').map(Number);
  const py = m === 1 ? y - 1 : y;
  const pm = m === 1 ? 12 : m - 1;
  const last = new Date(Date.UTC(py, pm, 0)).getUTCDate();
  const mm = String(pm).padStart(2, '0');
  return { from: `${py}-${mm}-01`, to: `${py}-${mm}-${String(last).padStart(2, '0')}` };
}

function digitsOf(s) { return String(s || '').replace(/\D/g, ''); }

// 沒有綁定時，猜一個：fact.data 裡的號碼（≥7 碼）出現在條碼識別碼裡
function guessFacts(key, facts) {
  const kd = digitsOf(key);
  if (kd.length < 7) return [];
  const hits = [];
  for (const f of facts) {
    for (const v of Object.values(f.data || {})) {
      const d = digitsOf(v);
      if (d.length >= 7 && kd.includes(d)) { hits.push({ id: f.id, category_id: f.category_id, store_name: f.store_name, data: f.data }); break; }
    }
  }
  return hits;
}

async function resolve(items = []) {
  const keys = [...new Set(items.map(i => i.key).filter(Boolean))];
  const bindMap = {};
  if (keys.length) {
    const { data, error } = await supabase
      .from('bill_barcode_bindings')
      .select('barcode_key, category_id, fact_id, store_erpid, label, fact:entity_facts!fact_id ( id, store_erpid, store_name, data, category_id )')
      .in('barcode_key', keys);
    if (error) throw new Error(error.message);
    for (const b of data || []) bindMap[b.barcode_key] = b;
  }

  // 重複：同 key + 年月已掃過
  const scanMap = {};
  if (keys.length) {
    const { data, error } = await supabase
      .from('bill_scans')
      .select('barcode_key, bill_ym, amount, expense_id, created_at')
      .in('barcode_key', keys);
    if (error) throw new Error(error.message);
    for (const s of data || []) scanMap[`${s.barcode_key}|${s.bill_ym}`] = s;
  }

  // 每個帳號已入帳到哪個月（掛帳接下一個月）＋疑似重複（同金額已入帳過）
  //   會計習慣：這張帳單接在這個帳號「最後入帳月份」的下一個月，不看條碼上的年月
  const addYm = (ym, k) => { const [y, m] = ym.split('-').map(Number); return new Date(Date.UTC(y, m - 1 + k, 1)).toISOString().slice(0, 7); };
  const factIds = [...new Set([
    ...Object.values(bindMap).map(b => b.fact_id),
    ...items.map(i => i.fact_id),
  ].filter(Boolean).map(String))];
  const histMap = {};   // fact_id → [{ expense_id, total, months[] }]
  if (factIds.length) {
    const { data, error } = await supabase
      .from('operational_expenses')
      .select('id, fact_id, total_amount, allocations:operational_expense_allocations(year_month)')
      .in('fact_id', factIds);
    if (error) throw new Error(error.message);
    for (const e of data || []) {
      (histMap[String(e.fact_id)] = histMap[String(e.fact_id)] || []).push({
        expense_id: e.id, total: Number(e.total_amount), months: (e.allocations || []).map(a => a.year_month).filter(Boolean).sort(),
      });
    }
  }

  // 沒綁定的：撈全部 facts 猜
  let allFacts = null;
  const out = [];
  for (const it of items) {
    const b = bindMap[it.key] || null;
    const r = { key: it.key, bill_ym: it.bill_ym, binding: b, duplicate: null, guesses: [], last_ym: null, next_ym: null };
    const sc = scanMap[`${it.key}|${it.bill_ym}`];
    if (sc) r.duplicate = { type: 'scanned', amount: Number(sc.amount), expense_id: sc.expense_id, at: sc.created_at };
    const factId = it.fact_id ? String(it.fact_id) : (b?.fact_id ? String(b.fact_id) : null);
    if (factId) {
      const hist = histMap[factId] || [];
      const months = hist.flatMap(h => h.months).sort();
      if (months.length) { r.last_ym = months[months.length - 1]; r.next_ym = addYm(r.last_ym, 1); }
      // 疑似重複：最近 6 個月內有同金額的費用（例：之前手動輸入過這張）
      const amt = Number(it.amount);
      if (!r.duplicate && amt > 0 && r.last_ym) {
        const since = addYm(r.last_ym, -5);
        const same = hist.find(h => Math.abs(h.total - amt) < 0.5 && h.months.some(m => m >= since));
        if (same) r.duplicate = { type: 'similar', amount: same.total, expense_id: same.expense_id, months: same.months };
      }
    }
    if (!b) {
      if (!allFacts) {
        const { data } = await supabase.from('entity_facts').select('id, category_id, store_name, data');
        allFacts = data || [];
      }
      r.guesses = guessFacts(it.key, allFacts);
    }
    out.push(r);
  }
  return out;
}

async function commit(items = [], actor) {
  const results = [];
  const entryDate = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' });

  for (const it of items) {
    const res = { key: it.key, bill_ym: it.bill_ym, ok: false };
    try {
      if (!it.key) throw new Error('缺識別碼');
      if (!YM_RE.test(it.bill_ym || '')) throw new Error('帳單年月格式錯誤');
      const amount = Number(it.amount);
      if (!amount || amount <= 0) throw new Error('金額需大於 0');
      if (!it.fact_id) throw new Error('未選擇對應的帳號/電號');

      // 分帳：沒給就整筆掛帳單年月；有給（雙月帳單分兩個月）要加總等於金額
      let allocs = [{ year_month: it.bill_ym, amount }];
      if (Array.isArray(it.allocations) && it.allocations.length) {
        allocs = it.allocations.map(a => ({ year_month: String(a.year_month || ''), amount: Number(a.amount) || 0 }));
        if (allocs.some(a => !YM_RE.test(a.year_month) || a.amount <= 0)) throw new Error('分帳月份或金額有誤');
        const sum = allocs.reduce((s, a) => s + a.amount, 0);
        if (Math.abs(sum - amount) > 0.5) throw new Error(`分帳合計 ${sum} 不等於金額 ${amount}`);
      }

      const { data: fact, error: fErr } = await supabase
        .from('entity_facts').select('id, category_id, store_erpid, store_name').eq('id', it.fact_id).single();
      if (fErr || !fact) throw new Error('找不到對應資料');
      const storeErpid = it.store_erpid || fact.store_erpid;
      if (!storeErpid) throw new Error('該帳號沒有對應門市');

      // 重複檢查（伺服器端再擋一次）
      const { data: dup } = await supabase
        .from('bill_scans').select('id').eq('barcode_key', it.key).eq('bill_ym', it.bill_ym).maybeSingle();
      if (dup) throw new Error('此帳單已入帳過');

      const range = (it.period_from && it.period_to)
        ? { from: it.period_from, to: it.period_to }
        : prevMonthRange(it.bill_ym);

      const noteParts = ['掃碼入帳'];
      if (it.due_date) noteParts.push(`代收期限 ${it.due_date}`);
      if (it.notes) noteParts.push(String(it.notes).trim());

      const { data: exp, error: eErr } = await supabase
        .from('operational_expenses')
        .insert({
          entry_date:   entryDate,
          period_from:  range.from,
          period_to:    range.to,
          category_id:  fact.category_id,
          fact_id:      fact.id,
          store_erpid:  storeErpid,
          total_amount: amount,
          notes:        noteParts.join('・'),
          created_by:   actor || null,
        })
        .select('id').single();
      if (eErr) throw new Error(eErr.message);

      const { error: aErr } = await supabase.from('operational_expense_allocations').insert(
        allocs.map(a => ({ operational_expense_id: exp.id, store_erpid: storeErpid, year_month: a.year_month, amount: a.amount }))
      );
      if (aErr) {
        await supabase.from('operational_expenses').delete().eq('id', exp.id);
        throw new Error('分帳寫入失敗：' + aErr.message);
      }

      const { error: sErr } = await supabase.from('bill_scans').insert({
        barcode_key: it.key,
        bill_ym:     it.bill_ym,
        amount,
        due_date:    it.due_date || null,
        raw_codes:   it.raw || null,
        expense_id:  exp.id,
        created_by:  actor || null,
      });
      if (sErr) {
        await supabase.from('operational_expenses').delete().eq('id', exp.id);
        throw new Error(sErr.code === '23505' ? '此帳單已入帳過' : sErr.message);
      }

      // 記住條碼 → fact
      await supabase.from('bill_barcode_bindings').upsert({
        barcode_key: it.key,
        category_id: fact.category_id,
        fact_id:     fact.id,
        store_erpid: storeErpid,
        label:       it.label || null,
        created_by:  actor || null,
        updated_at:  new Date().toISOString(),
      }, { onConflict: 'barcode_key' });

      res.ok = true;
      res.expense_id = exp.id;
      res.store_name = fact.store_name;
    } catch (e) {
      res.message = e.message;
    }
    results.push(res);
  }
  return results;
}

async function listBindings() {
  const { data, error } = await supabase
    .from('bill_barcode_bindings')
    .select('*, fact:entity_facts!fact_id ( id, store_erpid, store_name, data )')
    .order('updated_at', { ascending: false });
  if (error) throw new Error(error.message);
  return data || [];
}

async function deleteBinding(id) {
  const { error } = await supabase.from('bill_barcode_bindings').delete().eq('id', id);
  if (error) throw new Error(error.message);
  return { id, deleted: true };
}

module.exports = { resolve, commit, listBindings, deleteBinding, prevMonthRange, guessFacts };
