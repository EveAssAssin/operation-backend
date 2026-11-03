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
      if (d.length >= 7 && kd.includes(d)) { hits.push({ id: f.id, category_id: f.category_id }); break; }
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

  // 重複：該 fact 該月已有分帳（手動輸入的也會擋）
  const factIds = [...new Set(Object.values(bindMap).map(b => b.fact_id).filter(Boolean))];
  const allocMap = {};
  if (factIds.length) {
    const { data, error } = await supabase
      .from('operational_expenses')
      .select('id, fact_id, total_amount, allocations:operational_expense_allocations(year_month, amount)')
      .in('fact_id', factIds);
    if (error) throw new Error(error.message);
    for (const e of data || []) {
      for (const a of e.allocations || []) {
        const k = `${e.fact_id}|${a.year_month}`;
        (allocMap[k] = allocMap[k] || []).push({ expense_id: e.id, amount: Number(a.amount) });
      }
    }
  }

  // 沒綁定的：撈全部 facts 猜
  let allFacts = null;
  const out = [];
  for (const it of items) {
    const b = bindMap[it.key] || null;
    const r = { key: it.key, bill_ym: it.bill_ym, binding: b, duplicate: null, guesses: [] };
    const sc = scanMap[`${it.key}|${it.bill_ym}`];
    if (sc) r.duplicate = { type: 'scanned', amount: Number(sc.amount), expense_id: sc.expense_id, at: sc.created_at };
    else if (b?.fact_id && allocMap[`${b.fact_id}|${it.bill_ym}`]) {
      const a = allocMap[`${b.fact_id}|${it.bill_ym}`];
      r.duplicate = { type: 'allocated', amount: a.reduce((s, x) => s + x.amount, 0), expense_id: a[0].expense_id };
    }
    if (!b) {
      if (!allFacts) {
        const { data } = await supabase.from('entity_facts').select('id, category_id, data');
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
      if (it.due_date) noteParts.push(`繳費期限 ${it.due_date}`);
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

      const { error: aErr } = await supabase.from('operational_expense_allocations').insert({
        operational_expense_id: exp.id,
        store_erpid: storeErpid,
        year_month:  it.bill_ym,
        amount,
      });
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
