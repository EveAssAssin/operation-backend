// services/bankLedgerService.js —— 金流 → 銀存彙整（2026-11）
//   匯入：解析網銀檔 → 找帳戶（檔案有帳號就自動對；沒有就請使用者選）→ 指紋去重
//         同一段期間重匯：檔案裡沒有、但系統有的 → 標「已校正（removed）」；之前校正掉、這次又出現 → 還原
//         每次匯入都記錄，可整筆撤銷
//   分類：規則（bank_rules，使用者設的）優先 → 內建關鍵字（現金存入／刷卡撥款／LINE Pay／一卡通…）→ 內部轉帳（對方帳號是自己的帳戶）
//   門市：現金存入的備註以門市名稱開頭（例：郵局無摺存款「新左營吳雨霖」）→ 自動帶門市
const supabase = require('../config/supabase');
const { parseBankFile, fingerprints } = require('./bankParsers');

const r2 = (n) => Math.round(Number(n || 0) * 100) / 100;
const now = () => new Date().toISOString();

async function fetchAll(build, size = 1000) {
  const out = [];
  for (let from = 0; ; from += size) {
    const { data, error } = await build().range(from, from + size - 1);
    if (error) throw new Error(error.message);
    out.push(...(data || []));
    if (!data || data.length < size) break;
  }
  return out;
}

// ── 門市清單（departments）＋名稱比對 ──
let storeCache = null;
async function stores() {
  if (storeCache && Date.now() - storeCache.at < 10 * 60e3) return storeCache.v;
  const { data } = await supabase.from('departments').select('store_erpid, store_name, report_kind, is_active');
  const v = (data || []).filter((d) => d.store_erpid && d.store_name && d.is_active !== false)
    .map((d) => ({ store_erpid: String(d.store_erpid), store_name: d.store_name, kind: d.report_kind === 'store' ? 'store' : 'dept' }));
  storeCache = { at: Date.now(), v };
  return v;
}
function storeFromText(text, list) {
  const t = String(text || '').replace(/\s/g, '');
  if (!t) return null;
  const names = [];
  for (const s of list.filter((x) => x.kind === 'store')) {
    names.push({ n: s.store_name, id: s.store_erpid });
    const short = s.store_name.replace(/(門市|店)$/, '');
    if (short.length >= 2 && short !== s.store_name) names.push({ n: short, id: s.store_erpid });
  }
  names.sort((a, b) => b.n.length - a.n.length);
  const hit = names.find((x) => t.startsWith(x.n)) || names.find((x) => x.n.length >= 2 && t.includes(x.n));
  return hit ? hit.id : null;
}

// ── 分類 ──
const CATS = ['現金存入', '刷卡撥款', 'LINE Pay', '一卡通/iPASS', '票據存入', '內部轉帳', '手續費', '貨款/付款', '其他存入', '其他支出'];
function autoCategory(t, accTails) {
  const text = [t.summary, t.memo, t.memo2, t.counter_account].filter(Boolean).join(' ');
  const isIn = Number(t.in_amt) > 0;
  const digits = text.replace(/[^\d]/g, ' ').split(/\s+/).filter((x) => x.length >= 8);
  if (accTails.length && digits.some((d) => accTails.some((tail) => d.endsWith(tail)))) return '內部轉帳';
  if (/手續費|跨轉費|轉帳費|匯費/.test(text)) return '手續費';
  if (isIn) {
    if (/無摺存款|現金存|存現|ＡＴＭ存|ATM存款/.test(text)) return '現金存入';
    if (/LINE\s*Pay/i.test(text)) return 'LINE Pay';
    if (/連加|連支|ipass|ｉｐａ|一卡通/i.test(text)) return '一卡通/iPASS';
    if (/特店款|聯合信用|XML轉入|國泰世華|0000107520000000/.test(text)) return '刷卡撥款';
    if (/存票|票據|交換/.test(text)) return '票據存入';
    return '其他存入';
  }
  if (/EDI\s*提|企網付款|貨款/.test(text)) return '貨款/付款';
  return '其他支出';
}
function applyRules(t, rules) {
  const text = [t.summary, t.memo, t.memo2, t.counter_account].filter(Boolean).join(' ');
  const dir = Number(t.in_amt) > 0 ? 'in' : 'out';
  for (const r of rules) {
    if (r.account_id && r.account_id !== t.account_id) continue;
    if (r.direction && r.direction !== dir) continue;
    if (r.pattern && text.includes(r.pattern)) return r;
  }
  return null;
}
async function loadRules() {
  const { data } = await supabase.from('bank_rules').select('*').order('priority').order('created_at', { ascending: false });
  return data || [];
}
async function accountTails(excludeId) {
  const { data } = await supabase.from('bank_accounts').select('id, account_no');
  return (data || []).filter((a) => a.id !== excludeId && a.account_no && /^\d{8,}$/.test(a.account_no)).map((a) => a.account_no.slice(-10));
}
async function tag(t, ctx) {
  const rule = applyRules(t, ctx.rules);
  let category = rule && rule.category ? rule.category : autoCategory(t, ctx.tails);
  let store = rule && rule.store_erpid ? rule.store_erpid : null;
  if (!store && category === '現金存入') store = storeFromText(t.memo || t.memo2, ctx.stores);
  return { category, store_erpid: store, tag_source: rule ? 'rule' : 'auto' };
}

// ── 帳戶 ──
async function listAccounts() {
  const { data: accs, error } = await supabase.from('bank_accounts').select('*').order('is_active', { ascending: false }).order('sort_order', { ascending: true, nullsFirst: false }).order('bank_name').order('alias');
  if (error) throw new Error(error.message);
  const out = [];
  const { data: imps } = await supabase.from('bank_imports').select('account_id, created_at, created_by').is('undone_at', null).order('created_at', { ascending: false }).limit(1000);
  const lastImp = {};
  for (const i of imps || []) if (!lastImp[i.account_id]) lastImp[i.account_id] = i;
  for (const a of accs || []) {
    const v = await verifyAccount(a);
    const { cred_enc, ...safe } = a;   // 加密帳密不回前端
    out.push({ ...safe, has_cred: !!cred_enc, last_date: v.last_date, balance: v.reported_end, computed_balance: v.computed_end,
      txn_count: v.count, verify: { status: v.status, mismatches: v.mismatches.length, first: v.mismatches[0] || null },
      last_import_at: lastImp[a.id] ? lastImp[a.id].created_at : null, last_import_by: lastImp[a.id] ? lastImp[a.id].created_by : null });
  }
  return out;
}
async function saveAccount(id, b, by) {
  const row = {};
  for (const k of ['bank_name', 'account_no', 'alias', 'holder', 'note', 'bank_url']) if (b[k] !== undefined) row[k] = String(b[k] || '').trim() || null;
  if (row.bank_url && !/^https?:\/\//i.test(row.bank_url)) row.bank_url = 'https://' + row.bank_url;
  if (b.opening_date !== undefined) {
    if (b.opening_date && !/^\d{4}-\d{2}-\d{2}$/.test(b.opening_date)) throw new Error('期初日期格式不對');
    row.opening_date = b.opening_date || null;
  }
  if (b.opening_balance !== undefined) {
    const n = b.opening_balance === '' || b.opening_balance === null ? null : Number(String(b.opening_balance).replace(/,/g, ''));
    if (n !== null && !Number.isFinite(n)) throw new Error('期初餘額要是數字');
    row.opening_balance = n;
  }
  if (b.is_active !== undefined) row.is_active = !!b.is_active;
  if (b.sort_order !== undefined) row.sort_order = b.sort_order === '' || b.sort_order === null ? null : Number(b.sort_order);
  if (!id) {
    if (!row.bank_name) throw new Error('請填銀行');
    row.alias = row.alias || `${row.bank_name}${row.account_no ? ' ' + row.account_no.slice(-4) : ''}`;
    const { data, error } = await supabase.from('bank_accounts').insert({ ...row, created_by: by }).select().single();
    if (error) throw new Error(error.message);
    delete data.cred_enc;
    return data;
  }
  if (row.alias === null) throw new Error('名稱不能空白');
  const { data, error } = await supabase.from('bank_accounts').update({ ...row, updated_at: now() }).eq('id', id).select().single();
  if (error) throw new Error(error.message);
  delete data.cred_enc;
  return data;
}
// 檔案帳號（可能遮罩 526376***1110）對系統帳戶
function accountMatches(fileNo, accNo) {
  if (!fileNo || !accNo) return false;
  const a = String(fileNo), b = String(accNo);
  if (a === b) return true;
  const strip0 = (s) => s.replace(/^0+/, '');
  if (!a.includes('*') && !b.includes('*')) return strip0(a) === strip0(b) || a.endsWith(b) || b.endsWith(a);
  const mask = a.includes('*') ? a : b, full = a.includes('*') ? b : a;
  const [pre, ...rest] = mask.split(/\*+/); const post = rest.pop() || '';
  return full.startsWith(pre) && full.endsWith(post) && full.length >= pre.length + post.length;
}

// ── 匯入 ──
async function importFile({ buffer, fileName, account_id, by }) {
  const p = parseBankFile(buffer, fileName);
  const { data: accs } = await supabase.from('bank_accounts').select('*');
  let acc = account_id ? (accs || []).find((a) => a.id === account_id) : null;
  if (account_id && !acc) throw new Error('找不到選的帳戶');
  if (!acc && p.account_no) acc = (accs || []).find((a) => accountMatches(p.account_no, a.account_no));
  if (!acc && p.account_no) {
    acc = await saveAccount(null, { bank_name: p.bank, account_no: p.account_no, holder: p.holder, alias: `${p.bank} ${p.account_no.replace(/\*/g, '').slice(-4)}` }, by);
  }
  if (!acc) {
    // 檔案沒帳號（中信、高銀）→ 請使用者選帳戶
    return { need_account: true, bank: p.bank, period_from: p.period_from, period_to: p.period_to, rows: p.rows.length,
      candidates: (accs || []).filter((a) => a.bank_name === p.bank && a.is_active !== false).map((a) => ({ id: a.id, alias: a.alias, account_no: a.account_no })) };
  }
  if (acc.account_no && p.account_no && !accountMatches(p.account_no, acc.account_no)) {
    throw new Error(`檔案帳號 ${p.account_no} 跟選的帳戶「${acc.alias}」（${acc.account_no}）對不起來`);
  }

  const fps = fingerprints(p.rows);
  const existing = await fetchAll(() => supabase.from('bank_txns').select('id, fingerprint, status, ord')
    .eq('account_id', acc.id).gte('txn_date', p.period_from).lte('txn_date', p.period_to));
  const byFp = new Map(existing.map((e) => [e.fingerprint, e]));
  const fileFps = new Set(fps);

  const { data: imp, error: iErr } = await supabase.from('bank_imports').insert({
    account_id: acc.id, file_name: fileName, bank_name: p.bank, period_from: p.period_from, period_to: p.period_to,
    rows_total: p.rows.length, created_by: by,
  }).select().single();
  if (iErr) throw new Error(iErr.message);

  const ctx = { rules: await loadRules(), tails: await accountTails(acc.id), stores: await stores() };
  const base = Date.now() * 1000;   // 排序：同一天裡照檔案順序
  const toInsert = [];
  const restoreIds = [];
  let dup = 0;
  for (let i = 0; i < p.rows.length; i++) {
    const t = p.rows[i]; const fp = fps[i];
    const ex = byFp.get(fp);
    if (ex) { if (ex.status === 'removed') restoreIds.push(ex.id); else dup++; continue; }
    const tg = await tag({ ...t, account_id: acc.id }, ctx);
    toInsert.push({
      account_id: acc.id, import_id: imp.id, fingerprint: fp, txn_date: t.txn_date, txn_time: t.txn_time, value_date: t.value_date,
      ord: base + i, summary: t.summary, out_amt: t.out_amt, in_amt: t.in_amt, balance: t.balance,
      memo: t.memo, memo2: t.memo2, counter_account: t.counter_account, branch: t.branch, cheque_no: t.cheque_no, raw: t.raw,
      ...tg,
    });
  }
  // 自動校正：同期間系統有、這次檔案沒有
  const removeIds = existing.filter((e) => e.status === 'active' && !fileFps.has(e.fingerprint)).map((e) => e.id);

  for (let i = 0; i < toInsert.length; i += 500) {
    const { error } = await supabase.from('bank_txns').insert(toInsert.slice(i, i + 500));
    if (error) { await undoImport(imp.id, by, true); throw new Error('寫入失敗：' + error.message); }
  }
  if (restoreIds.length) await supabase.from('bank_txns').update({ status: 'active', removed_import_id: null, updated_at: now() }).in('id', restoreIds);
  if (removeIds.length) await supabase.from('bank_txns').update({ status: 'removed', removed_import_id: imp.id, updated_at: now() }).in('id', removeIds);

  const breaks = await balanceBreaks(acc.id, p.period_from, p.period_to);
  const verify = await verifyAccount({ ...acc, ...(await supabase.from('bank_accounts').select('opening_date, opening_balance').eq('id', acc.id).single()).data });
  await supabase.from('bank_imports').update({
    rows_new: toInsert.length, rows_dup: dup, rows_removed: removeIds.length, rows_restored: restoreIds.length, balance_breaks: breaks,
  }).eq('id', imp.id);
  return { import_id: imp.id, account: { id: acc.id, alias: acc.alias }, bank: p.bank, period_from: p.period_from, period_to: p.period_to,
    rows_total: p.rows.length, rows_new: toInsert.length, rows_dup: dup, rows_removed: removeIds.length, rows_restored: restoreIds.length, balance_breaks: breaks,
    verify: { status: verify.status, mismatches: verify.mismatches.slice(0, 5), reported_end: verify.reported_end, computed_end: verify.computed_end, last_date: verify.last_date } };
}

// 餘額核對：期初餘額（期初日期那天開始前）＋之後每筆存入－支出 → 跟銀行檔案上的「當下餘額」逐筆比
//   status：ok（全部對得上）／mismatch（有對不上）／no_opening（沒設期初，只能檢查前後筆接不接得起來）／empty
async function verifyAccount(acc) {
  const a = typeof acc === 'string' ? (await supabase.from('bank_accounts').select('*').eq('id', acc).single()).data : acc;
  const rows = await fetchAll(() => supabase.from('bank_txns').select('id, txn_date, summary, memo, in_amt, out_amt, balance')
    .eq('account_id', a.id).eq('status', 'active').order('txn_date').order('ord'));
  const hasOpening = a.opening_date && a.opening_balance != null;
  const use = hasOpening ? rows.filter((t) => t.txn_date >= a.opening_date) : rows;
  const mismatches = [];
  let running = hasOpening ? Number(a.opening_balance) : null;
  for (const t of use) {
    const delta = Number(t.in_amt) - Number(t.out_amt);
    if (running === null) { running = t.balance != null ? Number(t.balance) : delta; continue; }   // 沒期初：第一筆當起點
    running = r2(running + delta);
    if (t.balance != null && Math.abs(running - Number(t.balance)) > 0.5) {
      mismatches.push({ txn_id: t.id, date: t.txn_date, summary: t.summary, memo: t.memo, expected: running, reported: Number(t.balance), diff: r2(Number(t.balance) - running) });
      running = Number(t.balance);   // 從銀行餘額重新接，下一處差異另外算
    }
  }
  const last = rows[rows.length - 1];
  const computedEnd = hasOpening ? r2(Number(a.opening_balance) + use.reduce((s, t) => s + Number(t.in_amt) - Number(t.out_amt), 0)) : null;
  const status = !rows.length ? 'empty' : mismatches.length ? 'mismatch' : hasOpening ? 'ok' : 'no_opening';
  return { status, mismatches: mismatches.slice(0, 50), count: rows.length, last_date: last ? last.txn_date : null,
    reported_end: last && last.balance != null ? Number(last.balance) : null, computed_end: computedEnd,
    opening_date: a.opening_date || null, opening_balance: a.opening_balance != null ? Number(a.opening_balance) : null,
    before_opening: hasOpening ? rows.length - use.length : 0 };
}

// 餘額接不起來的地方（上一筆餘額＋存入－支出≠這筆餘額）→ 可能漏匯某段期間
async function balanceBreaks(accountId, from, to) {
  const rows = await fetchAll(() => supabase.from('bank_txns').select('id, txn_date, summary, in_amt, out_amt, balance')
    .eq('account_id', accountId).eq('status', 'active').gte('txn_date', from).lte('txn_date', to)
    .order('txn_date').order('ord'));
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const a = rows[i - 1], b = rows[i];
    if (a.balance == null || b.balance == null) continue;
    const diff = r2(Number(a.balance) + Number(b.in_amt) - Number(b.out_amt) - Number(b.balance));
    if (Math.abs(diff) > 0.5) out.push({ date: b.txn_date, summary: b.summary, txn_id: b.id, diff: -diff });
  }
  return out.slice(0, 50);
}

async function undoImport(importId, by, silent) {
  const { data: imp } = await supabase.from('bank_imports').select('*').eq('id', importId).maybeSingle();
  if (!imp) throw new Error('找不到這次匯入');
  if (imp.undone_at && !silent) throw new Error('已經撤銷過了');
  await supabase.from('bank_txns').update({ status: 'active', removed_import_id: null, updated_at: now() }).eq('removed_import_id', importId);
  const { error } = await supabase.from('bank_txns').delete().eq('import_id', importId);
  if (error) throw new Error(error.message);
  await supabase.from('bank_imports').update({ undone_at: now(), undone_by: by }).eq('id', importId);
  return { undone: importId };
}

async function listImports(accountId) {
  let q = supabase.from('bank_imports').select('*, account:bank_accounts(alias)').order('created_at', { ascending: false }).limit(100);
  if (accountId) q = q.eq('account_id', accountId);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return data || [];
}

// ── 明細 ──
async function listTxns(f = {}) {
  const build = () => {
    let q = supabase.from('bank_txns').select('*, account:bank_accounts(alias, bank_name)');
    if (f.account_id) q = q.eq('account_id', f.account_id);
    if (f.from) q = q.gte('txn_date', f.from);
    if (f.to) q = q.lte('txn_date', f.to);
    q = q.eq('status', f.status === 'removed' ? 'removed' : 'active');
    if (f.category) q = f.category === '__none' ? q.is('category', null) : q.eq('category', f.category);
    if (f.store_erpid) q = f.store_erpid === '__none' ? q.is('store_erpid', null) : q.eq('store_erpid', f.store_erpid);
    if (f.direction === 'in') q = q.gt('in_amt', 0);
    if (f.direction === 'out') q = q.gt('out_amt', 0);
    return q.order('txn_date', { ascending: false }).order('ord', { ascending: false });
  };
  let rows = await fetchAll(build);
  const k = String(f.keyword || '').trim();
  if (k) rows = rows.filter((t) => [t.summary, t.memo, t.memo2, t.counter_account, t.note].some((v) => String(v || '').includes(k)) || String(t.in_amt) === k || String(t.out_amt) === k);
  const limit = Math.min(Number(f.limit) || 2000, 5000);
  return { rows: rows.slice(0, limit), total: rows.length,
    sum_in: r2(rows.reduce((s, t) => s + Number(t.in_amt), 0)), sum_out: r2(rows.reduce((s, t) => s + Number(t.out_amt), 0)) };
}

async function updateTxn(id, b, by) {
  const up = { updated_at: now(), updated_by: by, tag_source: 'manual' };
  if (b.category !== undefined) up.category = b.category || null;
  if (b.store_erpid !== undefined) up.store_erpid = b.store_erpid || null;
  if (b.note !== undefined) up.note = b.note || null;
  const { data: t, error } = await supabase.from('bank_txns').update(up).eq('id', id).select().single();
  if (error) throw new Error(error.message);
  let rule = null;
  if (b.remember && b.pattern) {   // 「以後備註含這段字都這樣」
    rule = await addRule({ pattern: b.pattern, account_id: b.rule_all_accounts ? null : t.account_id,
      direction: Number(t.in_amt) > 0 ? 'in' : 'out', category: up.category ?? t.category, store_erpid: up.store_erpid ?? t.store_erpid }, by);
    const n = await reapply({ rule_id: rule.id });
    rule.applied = n;
  }
  return { txn: t, rule };
}
async function bulkUpdate(ids, b, by) {
  if (!Array.isArray(ids) || !ids.length) throw new Error('沒有選交易');
  const up = { updated_at: now(), updated_by: by, tag_source: 'manual' };
  if (b.category !== undefined) up.category = b.category || null;
  if (b.store_erpid !== undefined) up.store_erpid = b.store_erpid || null;
  const { error } = await supabase.from('bank_txns').update(up).in('id', ids);
  if (error) throw new Error(error.message);
  return { updated: ids.length };
}

// ── 規則 ──
async function listRules() {
  const { data, error } = await supabase.from('bank_rules').select('*, account:bank_accounts(alias)').order('priority').order('created_at', { ascending: false });
  if (error) throw new Error(error.message);
  return data || [];
}
async function addRule(b, by) {
  const pattern = String(b.pattern || '').trim();
  if (pattern.length < 2) throw new Error('比對文字至少 2 個字');
  if (!b.category && !b.store_erpid) throw new Error('要設類別或門市');
  const { data, error } = await supabase.from('bank_rules').insert({
    pattern, account_id: b.account_id || null, direction: b.direction || null, category: b.category || null,
    store_erpid: b.store_erpid || null, priority: Number(b.priority) || 100, created_by: by,
  }).select().single();
  if (error) throw new Error(error.message);
  return data;
}
async function deleteRule(id) {
  const { error } = await supabase.from('bank_rules').delete().eq('id', id);
  if (error) throw new Error(error.message);
  return { deleted: id };
}
// 重新套用規則：只動「自動／規則」標的，手動改過的不動
async function reapply({ rule_id } = {}) {
  const ctx = { rules: await loadRules(), stores: await stores() };
  const rows = await fetchAll(() => supabase.from('bank_txns').select('id, account_id, summary, memo, memo2, counter_account, in_amt, out_amt, category, store_erpid, tag_source')
    .eq('status', 'active').neq('tag_source', 'manual'));
  const tailsBy = {};
  let n = 0;
  for (const t of rows) {
    if (!tailsBy[t.account_id]) tailsBy[t.account_id] = await accountTails(t.account_id);
    const tg = await tag(t, { ...ctx, tails: tailsBy[t.account_id] });
    if (rule_id && tg.tag_source !== 'rule') continue;
    if (tg.category !== t.category || tg.store_erpid !== t.store_erpid || tg.tag_source !== t.tag_source) {
      await supabase.from('bank_txns').update({ ...tg, updated_at: now() }).eq('id', t.id);
      n++;
    }
  }
  return n;
}

// ── 彙整 ──
// 門市存入：某月每家門市每天的存入（預設只看現金存入；可選類別）
async function storeDeposits({ ym, categories }) {
  if (!/^\d{4}-\d{2}$/.test(ym || '')) throw new Error('月份要是 YYYY-MM');
  const [y, m] = ym.split('-').map(Number);
  const from = `${ym}-01`, to = `${ym}-${String(new Date(y, m, 0).getDate()).padStart(2, '0')}`;
  const cats = categories && categories.length ? categories : ['現金存入'];
  const rows = await fetchAll(() => supabase.from('bank_txns').select('id, txn_date, in_amt, store_erpid, category, memo, account_id')
    .eq('status', 'active').gte('txn_date', from).lte('txn_date', to).gt('in_amt', 0).in('category', cats));
  const st = await stores();
  const name = Object.fromEntries(st.map((s) => [s.store_erpid, s.store_name]));
  const by = {};
  let unassigned = { total: 0, n: 0 };
  for (const t of rows) {
    if (!t.store_erpid) { unassigned.total += Number(t.in_amt); unassigned.n++; continue; }
    const s = (by[t.store_erpid] = by[t.store_erpid] || { store_erpid: t.store_erpid, store_name: name[t.store_erpid] || t.store_erpid, days: {}, total: 0, n: 0 });
    s.days[t.txn_date] = r2((s.days[t.txn_date] || 0) + Number(t.in_amt));
    s.total = r2(s.total + Number(t.in_amt)); s.n++;
  }
  unassigned.total = r2(unassigned.total);
  return { ym, from, to, categories: cats, stores: Object.values(by).sort((a, b) => String(a.store_name).localeCompare(String(b.store_name), 'zh-Hant')), unassigned };
}

// 帳戶日報：每個帳戶每天存入／支出／當日餘額
async function dailySummary({ from, to }) {
  if (!from || !to) throw new Error('要有起訖日期');
  const rows = await fetchAll(() => supabase.from('bank_txns').select('account_id, txn_date, in_amt, out_amt, balance, ord')
    .eq('status', 'active').gte('txn_date', from).lte('txn_date', to).order('txn_date').order('ord'));
  const by = {};
  for (const t of rows) {
    const k = `${t.account_id}|${t.txn_date}`;
    const d = (by[k] = by[k] || { account_id: t.account_id, date: t.txn_date, in: 0, out: 0, balance: null, n: 0 });
    d.in = r2(d.in + Number(t.in_amt)); d.out = r2(d.out + Number(t.out_amt)); d.n++;
    if (t.balance != null) d.balance = Number(t.balance);
  }
  return Object.values(by);
}

module.exports = {
  CATS, stores, listAccounts, verifyAccount, saveAccount, importFile, undoImport, listImports, listTxns, updateTxn, bulkUpdate,
  listRules, addRule, deleteRule, reapply, storeDeposits, dailySummary, storeFromText, autoCategory, accountMatches,
};
