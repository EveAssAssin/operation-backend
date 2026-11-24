// services/cashDepositReview.js —— 金流 → 銀存審核（2026-11-24 營運）
// 門市上繳資料在市場部（營運工具 → 銀存回報）；這裡：
//   ① 代理市場部 internal API（總覽、上繳清單、審核）
//   ② 自動對帳：「現金銀存專用本子」（bank_accounts.is_cash_book）匯入的存入明細 ↔ 門市上繳（AI 金額相符、待確認的）
//      同金額、銀行入帳日在「最後一次結算日前 1 天」～「上繳後 3 天」內、本子那筆沒對過、有標門市的話門市要一樣
//      → 一對一（那筆存入只符合這一筆上繳、這筆上繳也只有這一筆存入）才自動通過；有兩筆以上可能的留給會計人工選
//   ③ 會計人工審核時可以指定對到本子哪一筆（給候選清單）
// 觸發：匯入網銀明細後、每小時 :40、頁面「立即對帳」
const axios = require('axios');
const supabase = require('../config/supabase');

const MARKET_BASE = process.env.MARKET_BACKEND_URL || 'https://market-backend-0544.onrender.com';
const r0 = (n) => Math.round(Number(n) || 0);
const addDays = (d, n) => new Date(Date.parse(String(d).slice(0, 10) + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);
const tpeDateOf = (iso) => new Date(Date.parse(iso) + 8 * 3600e3).toISOString().slice(0, 10);

async function market(method, path, { params, data, actor } = {}) {
  const key = process.env.MARKET_INTERNAL_KEY;
  if (!key) throw new Error('營運部沒設 MARKET_INTERNAL_KEY');
  try {
    const r = await axios({ method, url: `${MARKET_BASE}/api/internal/cash-deposit${path}`, params, data, timeout: 90000,
      headers: { 'x-internal-key': key, 'x-actor': String((actor && actor.app) || 'operation'), 'x-actor-name': encodeURIComponent(String((actor && actor.name) || '營運部')) } });
    return r.data && r.data.data;
  } catch (e) {
    const m = e.response && e.response.data && e.response.data.message;
    throw new Error(m || `市場部：${e.message}`);
  }
}

async function cashBooks() {
  const { data } = await supabase.from('bank_accounts').select('id, alias, bank_name, account_no, is_cash_book').eq('is_cash_book', true);
  return data || [];
}
async function setCashBooks(ids) {
  const want = new Set((Array.isArray(ids) ? ids : []).map(String));
  const { data: all } = await supabase.from('bank_accounts').select('id, is_cash_book');
  for (const a of all || []) {
    const on = want.has(String(a.id));
    if (!!a.is_cash_book !== on) await supabase.from('bank_accounts').update({ is_cash_book: on }).eq('id', a.id);
  }
  return cashBooks();
}

/** 純函式：一筆上繳在本子裡可能是哪幾筆存入 */
function candidatesFor(dep, txns) {
  const lo = addDays(dep.period_to || tpeDateOf(dep.created_at), -1);
  const hi = addDays(tpeDateOf(dep.created_at), 3);
  const amt = r0(dep.expected);
  return txns.filter((t) => !t.cash_deposit_id && r0(t.in_amt) === amt && t.txn_date >= lo && t.txn_date <= hi
    && (!t.store_erpid || String(t.store_erpid) === String(dep.store_erpid)));
}
/** 純函式：一對一配對（存入只被一筆上繳想要、上繳也只有一筆存入）；回 [{ dep, txn }] */
function pairUp(deps, txns) {
  const cand = new Map(deps.map((d) => [d.id, candidatesFor(d, txns)]));
  const wanted = new Map();   // txn id → 幾筆上繳想要
  for (const list of cand.values()) for (const t of list) wanted.set(t.id, (wanted.get(t.id) || 0) + 1);
  const out = [];
  for (const d of deps) {
    const list = cand.get(d.id) || [];
    if (list.length === 1 && wanted.get(list[0].id) === 1) out.push({ dep: d, txn: list[0] });
  }
  return { pairs: out, ambiguous: deps.filter((d) => (cand.get(d.id) || []).length > 1 || ((cand.get(d.id) || []).length === 1 && wanted.get(cand.get(d.id)[0].id) > 1)).map((d) => d.id) };
}

async function bookTxns(fromDate) {
  const books = await cashBooks();
  if (!books.length) return { books, txns: [] };
  const { data } = await supabase.from('bank_txns').select('id, account_id, txn_date, txn_time, summary, memo, in_amt, store_erpid, category, cash_deposit_id')
    .in('account_id', books.map((b) => b.id)).eq('status', 'active').gt('in_amt', 0).gte('txn_date', fromDate).order('txn_date').limit(5000);
  const alias = new Map(books.map((b) => [b.id, b.alias]));
  return { books, txns: (data || []).map((t) => ({ ...t, account_alias: alias.get(t.account_id) })) };
}

async function markTxn(txn, dep, by) {
  const up = { cash_deposit_id: String(dep.id), updated_at: new Date().toISOString(), updated_by: by };
  if (!txn.store_erpid) up.store_erpid = String(dep.store_erpid);
  if (!txn.category) up.category = '現金存入';
  up.tag_source = 'manual';
  await supabase.from('bank_txns').update(up).eq('id', txn.id);
}
const bankInfo = (t) => ({ account: t.account_alias || null, date: t.txn_date, time: t.txn_time || null, amount: r0(t.in_amt), summary: [t.summary, t.memo].filter(Boolean).join(' ').slice(0, 80) });

let running = null;
/** 自動對帳；回 { matched, ambiguous, waiting, books } */
async function reconcile(by = '自動對帳') {
  if (running) return running;
  running = (async () => {
    const deps = (await market('get', '/deposits', { params: { status: 'submitted', limit: 1000 } })).filter((d) => d.ai_ok);
    if (!deps.length) return { matched: 0, ambiguous: 0, waiting: 0, books: (await cashBooks()).length };
    const from = addDays(deps.map((d) => d.period_to || tpeDateOf(d.created_at)).sort()[0], -2);
    const { books, txns } = await bookTxns(from);
    if (!books.length) return { matched: 0, ambiguous: 0, waiting: deps.length, books: 0, message: '還沒指定現金銀存專用本子' };
    const { pairs, ambiguous } = pairUp(deps, txns);
    let matched = 0;
    for (const { dep, txn } of pairs) {
      try {
        await market('post', `/deposits/${dep.id}/review`, { data: { action: 'approve', auto: true, note: `本子自動對帳：${txn.account_alias || ''} ${txn.txn_date} 存入 ${r0(txn.in_amt).toLocaleString()}`, bank_txn_id: txn.id, bank_info: bankInfo(txn) }, actor: { app: 'auto', name: by } });
        await markTxn(txn, dep, by);
        matched++;
      } catch (e) { console.warn('[cash reconcile]', dep.id, e.message); }
    }
    return { matched, ambiguous: ambiguous.length, waiting: deps.length - matched, books: books.length };
  })().finally(() => { setTimeout(() => { running = null; }, 0); });
  return running;
}

/** 會計人工審核：可指定本子那筆（bank_txn_id） */
async function review(id, b, actor) {
  let txn = null;
  if (b.action === 'approve' && b.bank_txn_id) {
    const { data: t } = await supabase.from('bank_txns').select('id, account_id, txn_date, txn_time, summary, memo, in_amt, store_erpid, category, cash_deposit_id, account:bank_accounts(alias)').eq('id', b.bank_txn_id).maybeSingle();
    if (!t) throw new Error('找不到本子那筆交易');
    if (t.cash_deposit_id && t.cash_deposit_id !== String(id)) throw new Error('本子那筆已經對到別的上繳了');
    txn = { ...t, account_alias: t.account && t.account.alias };
  }
  const res = await market('post', `/deposits/${id}/review`, { data: { action: b.action, note: b.note || null, bank_txn_id: txn ? txn.id : null, bank_info: txn ? bankInfo(txn) : null }, actor });
  if (txn) await markTxn(txn, { id, store_erpid: res.store_erpid }, actor.name);
  if (b.action === 'reject') await supabase.from('bank_txns').update({ cash_deposit_id: null }).eq('cash_deposit_id', String(id));
  return res;
}

/** 某筆上繳在本子裡的候選（金額相近 ±10%、日期前後 7 天） */
async function candidates(id) {
  const d = await market('get', `/deposits/${id}`);
  const { books, txns } = await bookTxns(addDays(d.period_from || tpeDateOf(d.created_at), -3));
  const hi = addDays(tpeDateOf(d.created_at), 7);
  const amt = r0(d.expected);
  const near = txns.filter((t) => t.txn_date <= hi && (!t.cash_deposit_id || t.cash_deposit_id === String(id)) && Math.abs(r0(t.in_amt) - amt) <= Math.max(500, amt * 0.1))
    .map((t) => ({ ...t, exact: r0(t.in_amt) === amt || (d.ai_amount != null && r0(t.in_amt) === r0(d.ai_amount)) }))
    .sort((a, b) => (b.exact - a.exact) || Math.abs(r0(a.in_amt) - amt) - Math.abs(r0(b.in_amt) - amt));
  return { books: books.length, list: near.slice(0, 20) };
}

/** 本子裡還沒對到任何上繳的存入（會計找「有存錢但沒回報」） */
async function unmatchedBook(from) {
  const { books, txns } = await bookTxns(from || addDays(new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10), -45));
  return { books, list: txns.filter((t) => !t.cash_deposit_id && (!t.category || t.category === '現金存入')).reverse().slice(0, 300) };
}

let _cron = false;
function startCron() {
  if (_cron) return; _cron = true;
  try { require('node-cron').schedule('40 * * * *', () => { reconcile().then((r) => r && r.matched && console.log('[cash reconcile]', JSON.stringify(r))).catch((e) => console.warn('[cash reconcile]', e.message)); }, { timezone: 'Asia/Taipei' }); }
  catch (e) { console.warn('[cash reconcile cron]', e.message); }
}

module.exports = { market, cashBooks, setCashBooks, candidatesFor, pairUp, reconcile, review, candidates, unmatchedBook, startCron };
