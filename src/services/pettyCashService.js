// services/pettyCashService.js —— 零用金管理（2026-11）
//   金庫（可多個）＋收入／支出流水；餘額＝收入合計－支出合計（作廢的不算）
//   支出可「同步開帳」：依分配（門市×會計科目×金額）寫 ledger_manual_entries（entry_type='petty'），列入門市月報
//     入帳月份遇到已關帳 → 自動順延到下一個沒關帳的月份
//   作廢：零用金那筆標作廢；開帳的月報列一起作廢（月份已關帳就不能作廢，請用月報調帳）

const supabase = require('../config/supabase');
const LS = require('./ledgerSubjects');
const LP = require('./ledgerPost');

const YM = /^\d{4}-\d{2}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const r2 = (n) => Math.round(Number(n) * 100) / 100;
const now = () => new Date().toISOString();

// ── 金庫 ──
async function listFunds({ all } = {}) {
  let q = supabase.from('petty_cash_funds').select('*').order('is_active', { ascending: false }).order('sort_order', { ascending: true, nullsFirst: false }).order('created_at');
  if (!all) q = q.eq('is_active', true);
  const { data: funds, error } = await q;
  if (error) throw new Error(error.message);
  const ids = (funds || []).map((f) => f.id);
  const bal = {};
  if (ids.length) {
    const { data: tx, error: e2 } = await supabase.from('petty_cash_txns').select('fund_id, direction, amount, txn_date').in('fund_id', ids).is('void_at', null);
    if (e2) throw new Error(e2.message);
    for (const t of tx || []) {
      const b = (bal[t.fund_id] = bal[t.fund_id] || { balance: 0, total_in: 0, total_out: 0, last_date: null, count: 0 });
      const a = Number(t.amount);
      if (t.direction === 'in') { b.balance += a; b.total_in += a; } else { b.balance -= a; b.total_out += a; }
      b.count++;
      if (!b.last_date || t.txn_date > b.last_date) b.last_date = t.txn_date;
    }
  }
  return (funds || []).map((f) => {
    const b = bal[f.id] || { balance: 0, total_in: 0, total_out: 0, last_date: null, count: 0 };
    return { ...f, balance: r2(b.balance), total_in: r2(b.total_in), total_out: r2(b.total_out), last_date: b.last_date, txn_count: b.count };
  });
}

async function saveFund(id, b, by) {
  const row = {};
  for (const k of ['name', 'keeper_name', 'store_erpid', 'note']) if (b[k] !== undefined) row[k] = String(b[k] || '').trim() || null;
  if (b.is_active !== undefined) row.is_active = !!b.is_active;
  if (b.sort_order !== undefined) row.sort_order = b.sort_order === null || b.sort_order === '' ? null : Number(b.sort_order);
  if (!id) {
    if (!row.name) throw new Error('請填金庫名稱');
    const { data, error } = await supabase.from('petty_cash_funds').insert({ ...row, created_by: by }).select().single();
    if (error) throw new Error(error.message);
    return data;
  }
  if (row.name === null) throw new Error('金庫名稱不能空白');
  const { data, error } = await supabase.from('petty_cash_funds').update({ ...row, updated_at: now() }).eq('id', id).select().single();
  if (error) throw new Error(error.message);
  return data;
}

// ── 流水 ──
async function listTxns({ fund_id, from, to, direction, keyword, include_void } = {}) {
  if (!fund_id) throw new Error('缺金庫');
  let q = supabase.from('petty_cash_txns').select('*').eq('fund_id', fund_id).order('txn_date').order('created_at');
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  // 先算整本的累計餘額，再篩選（篩選後餘額欄仍是當時的真實餘額）
  let bal = 0;
  const rows = (data || []).map((t) => {
    if (!t.void_at) bal += t.direction === 'in' ? Number(t.amount) : -Number(t.amount);
    return { ...t, balance_after: t.void_at ? null : r2(bal) };
  });
  const k = String(keyword || '').trim().toLowerCase();
  const opening = r2(rows.filter((t) => !t.void_at && from && t.txn_date < from).reduce((s, t) => s + (t.direction === 'in' ? 1 : -1) * Number(t.amount), 0));
  const list = rows.filter((t) =>
    (include_void || !t.void_at) &&
    (!from || t.txn_date >= from) && (!to || t.txn_date <= to) &&
    (!direction || t.direction === direction) &&
    (!k || [t.description, t.payee, t.category, t.receipt_no, t.handled_by].some((v) => String(v || '').toLowerCase().includes(k))));
  // 開帳狀態：每一筆支出對應的月報列
  const ids = list.filter((t) => t.post_to_ledger).map((t) => t.id);
  if (ids.length) {
    const { data: les } = await supabase.from('ledger_manual_entries').select('id, petty_txn_id, store_erpid, report_ym, ledger_code, subject_id, amount, void_at').in('petty_txn_id', ids);
    const by = {};
    for (const e of les || []) (by[e.petty_txn_id] = by[e.petty_txn_id] || []).push(e);
    for (const t of list) if (by[t.id]) t.ledger_entries = by[t.id];
  }
  return { rows: list.reverse(), opening_balance: from ? opening : 0, balance: r2(bal) };
}

async function cleanAllocations(allocs, total) {
  if (!Array.isArray(allocs) || !allocs.length) throw new Error('開帳要至少一列分配（門市＋科目＋金額）');
  const { data: deps } = await supabase.from('departments').select('store_erpid, store_name');
  const dep = new Map((deps || []).map((d) => [String(d.store_erpid), d.store_name]));
  const out = [];
  for (let i = 0; i < allocs.length; i++) {
    const a = allocs[i] || {};
    const store = String(a.store_erpid || '');
    if (!dep.has(store)) throw new Error(`第 ${i + 1} 列門市不對`);
    let s; try { s = await LS.mustGet(a.subject_id); } catch (e) { throw new Error(`第 ${i + 1} 列：${e.message}`); }
    if (!(await LS.needsSubject(s.ledger_code))) throw new Error(`第 ${i + 1} 列：只能選支出的會計科目`);
    const amt = r2(a.amount);
    if (!(amt > 0)) throw new Error(`第 ${i + 1} 列金額不對`);
    out.push({ store_erpid: store, store_name: dep.get(store), subject_id: s.id, ledger_code: s.ledger_code, amount: amt });
  }
  const sum = r2(out.reduce((s, a) => s + a.amount, 0));
  if (Math.abs(sum - Number(total)) > 0.5) throw new Error(`分配合計 ${sum} 不等於支出金額 ${total}`);
  return out;
}

// 寫月報列（已關帳的月份自動順延）
async function postLedger(txn, fund, allocs, reportYm, by) {
  const isC = await LP.closedMap(allocs.map((a) => a.store_erpid), reportYm, 24);
  const rows = [];
  const shifted = [];
  for (const a of allocs) {
    const ym = await LP.openYm(a.store_erpid, reportYm, isC);
    if (ym !== reportYm) shifted.push(`${a.store_name} ${reportYm} 已關帳 → 改列 ${ym}`);
    rows.push({
      entry_type: 'petty', store_erpid: a.store_erpid, report_ym: ym, fee_ym: String(txn.txn_date).slice(0, 7),
      ledger_code: a.ledger_code, subject_id: a.subject_id, amount: a.amount,
      vendor: txn.payee || null,
      reason: `零用金｜${fund.name}｜${txn.description || txn.category || ''}`.slice(0, 300),
      files: [], created_by: by, petty_txn_id: txn.id,
    });
  }
  const { error } = await supabase.from('ledger_manual_entries').insert(rows);
  if (error) throw new Error('列入月報失敗：' + error.message);
  try { require('./monthlyReport').clearBookCache && require('./monthlyReport').clearBookCache(); } catch { /* ignore */ }
  return { count: rows.length, shifted };
}

async function createTxn(b, by) {
  const { data: fund } = await supabase.from('petty_cash_funds').select('*').eq('id', b.fund_id).maybeSingle();
  if (!fund) throw new Error('找不到金庫');
  if (!fund.is_active) throw new Error('這個金庫已停用');
  const direction = b.direction === 'in' ? 'in' : b.direction === 'out' ? 'out' : null;
  if (!direction) throw new Error('請選收入或支出');
  const amount = r2(b.amount);
  if (!(amount > 0)) throw new Error('金額要大於 0');
  if (!DATE.test(String(b.txn_date || ''))) throw new Error('日期格式不對');
  const post = direction === 'out' && !!b.post_to_ledger;
  let allocs = null, reportYm = null;
  if (post) {
    reportYm = String(b.report_ym || '');
    if (!YM.test(reportYm)) throw new Error('請選入帳月份');
    allocs = await cleanAllocations(b.allocations, amount);
  }
  const row = {
    fund_id: fund.id, txn_date: b.txn_date, direction, amount,
    category: String(b.category || '').trim() || null,
    description: String(b.description || '').trim() || null,
    payee: String(b.payee || '').trim() || null,
    receipt_no: String(b.receipt_no || '').trim() || null,
    handled_by: String(b.handled_by || '').trim() || null,
    post_to_ledger: post, report_ym: reportYm,
    allocations: allocs ? allocs.map(({ store_erpid, subject_id, amount: a }) => ({ store_erpid, subject_id, amount: a })) : null,
    created_by: by,
  };
  if (direction === 'out' && !row.description && !row.category) throw new Error('支出請寫用途');
  const { data: txn, error } = await supabase.from('petty_cash_txns').insert(row).select().single();
  if (error) throw new Error(error.message);
  let posting = null;
  if (post) {
    try { posting = await postLedger(txn, fund, allocs, reportYm, by); }
    catch (e) {
      await supabase.from('petty_cash_txns').delete().eq('id', txn.id);   // 開帳失敗：整筆不建，避免半套
      throw e;
    }
  }
  return { ...txn, posting };
}

// 修改：只改說明類欄位；金額／收支／開帳要改＝作廢重建
async function updateTxn(id, b) {
  const { data: t } = await supabase.from('petty_cash_txns').select('*').eq('id', id).maybeSingle();
  if (!t) throw new Error('找不到這筆');
  if (t.void_at) throw new Error('已作廢的不能改');
  const up = { updated_at: now() };
  for (const k of ['category', 'description', 'payee', 'receipt_no', 'handled_by']) if (b[k] !== undefined) up[k] = String(b[k] || '').trim() || null;
  if (b.txn_date !== undefined) { if (!DATE.test(String(b.txn_date))) throw new Error('日期格式不對'); up.txn_date = b.txn_date; }
  if (b.amount !== undefined && r2(b.amount) !== Number(t.amount)) {
    if (t.post_to_ledger) throw new Error('已開帳的支出不能改金額，請作廢後重新登記');
    if (!(r2(b.amount) > 0)) throw new Error('金額要大於 0');
    up.amount = r2(b.amount);
  }
  const { data, error } = await supabase.from('petty_cash_txns').update(up).eq('id', id).select().single();
  if (error) throw new Error(error.message);
  return data;
}

async function voidTxn(id, reason, by) {
  if (!String(reason || '').trim()) throw new Error('作廢要寫原因');
  const { data: t } = await supabase.from('petty_cash_txns').select('*').eq('id', id).maybeSingle();
  if (!t) throw new Error('找不到這筆');
  if (t.void_at) throw new Error('已經作廢了');
  if (t.post_to_ledger) {
    const { data: les } = await supabase.from('ledger_manual_entries').select('id, store_erpid, report_ym').eq('petty_txn_id', id).is('void_at', null);
    for (const e of les || []) {
      if (await LP.isClosed(e.store_erpid, e.report_ym)) throw new Error(`這筆已列入 ${e.store_erpid} ${e.report_ym} 月報且已關帳，不能作廢；請在月報用調帳沖回`);
    }
    if ((les || []).length) {
      const { error } = await supabase.from('ledger_manual_entries').update({ void_at: now(), void_by: by }).eq('petty_txn_id', id).is('void_at', null);
      if (error) throw new Error(error.message);
      try { require('./monthlyReport').clearBookCache && require('./monthlyReport').clearBookCache(); } catch { /* ignore */ }
    }
  }
  const { data, error } = await supabase.from('petty_cash_txns').update({ void_at: now(), void_by: by, void_reason: String(reason).trim() }).eq('id', id).select().single();
  if (error) throw new Error(error.message);
  return data;
}

module.exports = { listFunds, saveFund, listTxns, createTxn, updateTxn, voidTxn };
