// services/ledgerPost.js — 帳單入帳月份／科目／分攤（2026-10-20）
// 規則：
//   ・預設列入月報月份＝跟資料庫 report_ym_for 一樣：費用月 M 的帳在「M 的下個月 cutoff_day（26）號」以前收到就列 M，否則往後推
//   ・會計可以手動指定月份；任何寫入都不能寫進已關帳的月份 → 自動順延到下一個沒關帳的月份（shifted_from 記原本月份）
//   ・分攤：一筆分配拆成 N 個「沒關帳」的月份，每月取整數、零頭放最後一個月，存 bill_alloc_schedule（加總＝分配金額才生效）
const supabase = require('../config/supabase');

const YM = /^\d{4}-(0[1-9]|1[0-2])$/;
const addYm = (ym, k) => { const [y, m] = ym.split('-').map(Number); return new Date(Date.UTC(y, m - 1 + k, 1)).toISOString().slice(0, 7); };
const tpeDate = (d) => new Date((d ? new Date(d) : new Date()).getTime() + 8 * 3600e3).toISOString().slice(0, 10);

async function cutoffDay() {
  const { data } = await supabase.from('report_settings').select('value').eq('key', 'cutoff_day').maybeSingle();
  const n = Number(data && data.value);
  return n >= 1 && n <= 31 ? n : 26;
}
// 同 SQL report_ym_for：費用月 feeYm、收到日 dateStr（台北 YYYY-MM-DD）
function reportYmFor(feeYm, dateStr, cut) {
  if (!YM.test(String(feeYm || ''))) return feeYm || null;
  let m = feeYm;
  for (let i = 0; i < 60; i++) {
    const nx = addYm(m, 1);
    const lim = `${nx}-${String(cut).padStart(2, '0')}`;
    if (!dateStr || dateStr <= lim) return m;
    m = nx;
  }
  return m;
}
async function closedMap(stores, fromYm, n = 40) {
  const yms = Array.from({ length: n }, (_, k) => addYm(fromYm, k));
  const { data } = await supabase.from('store_month_reports').select('store_erpid, ym').in('store_erpid', [...new Set(stores.map(String))]).in('ym', yms).eq('status', 'closed');
  const s = new Set((data || []).map((r) => `${r.store_erpid}|${r.ym}`));
  return (store, ym) => s.has(`${store}|${ym}`);
}
async function isClosed(store, ym) {
  const { data } = await supabase.from('store_month_reports').select('status').eq('store_erpid', String(store)).eq('ym', ym).maybeSingle();
  return !!(data && data.status === 'closed');
}
// 從 ym 開始找第一個沒關帳的月份
async function openYm(store, ym, closedFn) {
  const isC = closedFn || (await closedMap([store], ym));
  let m = ym;
  for (let i = 0; i < 40 && isC(String(store), m); i++) m = addYm(m, 1);
  return m;
}
// 分攤：從 startYm 起取 n 個沒關帳的月份
async function plan(store, amount, startYm, n, closedFn) {
  const isC = closedFn || (await closedMap([store], startYm, n + 40));
  const months = [];
  let m = startYm;
  for (let i = 0; months.length < n && i < n + 40; i++) { if (!isC(String(store), m)) months.push(m); m = addYm(m, 1); }
  const total = Math.round(Number(amount) * 100) / 100;
  const each = Math.trunc(total / n);
  return months.map((ym, k) => ({ seq: k + 1, report_ym: ym, amount: k === months.length - 1 ? Math.round((total - each * (months.length - 1)) * 100) / 100 : each }));
}

/**
 * 帳單產生後套用入帳設定（廠商請款：通過時建帳單 or 付款後建帳單，都走這裡）
 * acct = { report_ym, ledger_code, amort_months, fee_ym, received_at, by }
 */
async function applyToBill(billId, acct) {
  if (acct.subject_id) {
    const sj = await require('./ledgerSubjects').byId(acct.subject_id);
    if (sj) { acct.ledger_code = acct.ledger_code || sj.ledger_code; await supabase.from('bills').update({ subject_id: sj.id, ledger_code: sj.ledger_code }).eq('id', billId); }
  }
  const { data: als } = await supabase.from('bill_allocations').select('id, store_erpid, allocated_amount').eq('bill_id', billId);
  if (!als || !als.length) return { done: 0 };
  const cut = await cutoffDay();
  const want = acct.report_ym && YM.test(acct.report_ym) ? acct.report_ym : reportYmFor(acct.fee_ym, tpeDate(acct.received_at), cut);
  if (!want) return { done: 0 };
  const isC = await closedMap(als.map((a) => a.store_erpid), want, 80);
  const n = Math.max(1, Math.min(60, Number(acct.amort_months) || 1));
  const notes = [];
  for (const a of als) {
    const ym = await openYm(a.store_erpid, want, isC);
    if (ym !== want) notes.push(`${a.store_erpid} ${want} 已關帳 → 改列 ${ym}`);
    await supabase.from('bill_allocations').update({ report_ym: ym, fee_ym: acct.fee_ym || null, ledger_code: acct.ledger_code || null, updated_at: new Date().toISOString() }).eq('id', a.id);
    if (n > 1) {
      const rows = (await plan(a.store_erpid, a.allocated_amount, ym, n, isC)).map((r) => ({ ...r, allocation_id: a.id, created_by: acct.by || null, shifted_from: ym !== want ? want : null }));
      await supabase.from('bill_alloc_schedule').delete().eq('allocation_id', a.id);
      const { error } = await supabase.from('bill_alloc_schedule').insert(rows);
      if (error) console.error('[ledgerPost] 分攤寫入失敗', a.id, error.message);
    }
  }
  if (notes.length) console.log('[ledgerPost] 已關帳順延：', notes.join('；'));
  return { done: als.length, report_ym: want, shifted: notes };
}

module.exports = { YM, addYm, tpeDate, cutoffDay, reportYmFor, closedMap, isClosed, openYm, plan, applyToBill };
