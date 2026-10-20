// services/processingCenter.js — 加工中心開帳（2026-10-20）
//
// 資料來源：加工站 lohastracking-php GET billingFeed/orders（第一次到 sid 22 品管消毒完待返回的單，含 erp_bind_ids）
// 金額：proc_price_items（主管設定，bind_id × 生效月份）；一張單同品項只算一次（營運 10-20）
// 開帳：每家店每月一筆 proc_month_store ＋ 一張帳單（來源「加工中心」、lens_lab 代工中心代工費）→ 門市月報
// 跨月去重：開帳過的單號記在 proc_billed_orders，重工又到 sid 22 也不再算
const supabase = require('../config/supabase');

const YM = /^\d{4}-(0[1-9]|1[0-2])$/;
const FEED_URL = () => (process.env.PROC_FEED_URL || 'https://lohastracking.realtime.tw').replace(/\/+$/, '');
const LEDGER_CODE = 'lens_lab';
const addYm = (ym, k) => { const [y, m] = ym.split('-').map(Number); return new Date(Date.UTC(y, m - 1 + k, 1)).toISOString().slice(0, 7); };
const r2 = (n) => Math.round(Number(n || 0) * 100) / 100;
const tpe = (ts) => new Date(ts * 1000 + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' ');

async function feedGet(path, params) {
  const key = process.env.PROC_FEED_KEY || '';
  if (key.length < 32) throw new Error('營運部後端還沒設定 PROC_FEED_KEY（加工站資料金鑰）');
  const qs = new URLSearchParams(params || {}).toString();
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 90000);
  try {
    const r = await fetch(`${FEED_URL()}/${path}${qs ? '?' + qs : ''}`, { headers: { 'X-Feed-Key': key }, signal: ctl.signal });
    const txt = await r.text();
    if (r.status === 404) throw new Error('加工站還沒有這支資料介面（lohastracking 新版還沒部署）');
    let j; try { j = JSON.parse(txt); } catch { throw new Error(`加工站回應不是 JSON（HTTP ${r.status}）：${txt.slice(0, 120)}`); }
    if (!r.ok || !j.ok) throw new Error(`加工站 ${path} 失敗（HTTP ${r.status}）：${j.error || ''}`);
    return j;
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(`加工站 ${path} 逾時（90 秒）`);
    throw e;
  } finally { clearTimeout(t); }
}

const cache = new Map();   // ym -> {at, data}
async function feedMonth(ym, fresh) {
  const c = cache.get(ym);
  if (!fresh && c && Date.now() - c.at < 120000) return c.data;
  const data = await feedGet('billingFeed/orders', { from: `${ym}-01`, to: `${addYm(ym, 1)}-01` });
  cache.set(ym, { at: Date.now(), data });
  return data;
}

async function priceTable() {
  const { data, error } = await supabase.from('proc_price_items').select('*').eq('is_active', true).order('effective_from', { ascending: false });
  if (error) throw error;
  const by = new Map();
  for (const p of data || []) { const k = String(p.bind_id); if (!by.has(k)) by.set(k, []); by.get(k).push(p); }
  return {
    rows: data || [],
    of(bind, ym) { const l = by.get(String(bind)); if (!l) return null; return l.find((p) => p.effective_from <= ym) || null; },
  };
}

async function storeNames() {
  const { data } = await supabase.from('departments').select('store_erpid, store_name');
  return Object.fromEntries((data || []).filter((d) => d.store_erpid).map((d) => [String(d.store_erpid), d.store_name]));
}

// 算一個月：回 { stores: { erpid: {...} }, feed }
async function compute(ym, { fresh } = {}) {
  if (!YM.test(ym)) throw new Error('月份要 YYYY-MM');
  const [feed, prices, names, openedQ, extrasQ] = await Promise.all([
    feedMonth(ym, fresh), priceTable(), storeNames(),
    supabase.from('proc_month_store').select('*').eq('ym', ym).is('voided_at', null),
    supabase.from('proc_order_extra').select('*').eq('ym', ym).is('voided_at', null).order('created_at'),
  ]);
  const orders = feed.orders || [];
  const products = feed.products || {};
  const nums = orders.map((o) => o.order_number);
  const billed = new Map();
  for (let i = 0; i < nums.length; i += 500) {
    const { data } = await supabase.from('proc_billed_orders').select('order_number, ym, store_erpid').in('order_number', nums.slice(i, i + 500));
    for (const b of data || []) billed.set(b.order_number, b);
  }
  const opened = Object.fromEntries((openedQ.data || []).map((m) => [m.store_erpid, m]));
  const stores = {};
  const S = (id) => (stores[id] = stores[id] || { store_erpid: id, store_name: names[id] || id, orders: [], extras: [],
    counted: 0, zero: 0, canceled: 0, other_month: 0, unsynced: 0, order_amount: 0, extra_amount: 0, total: 0, opened: opened[id] || null });
  for (const o of orders) {
    const s = S(String(o.store_id));
    const lines = (o.bind_ids || []).map((b) => {
      const p = prices.of(b, ym); const pr = products[b] || {};
      return { bind_id: String(b), name: pr.name || (p && p.name) || '', brand: pr.brand || '', catena: pr.catena || '', price: p ? Number(p.amount) : null };
    });
    const amount = r2(lines.reduce((t, l) => t + (l.price || 0), 0));
    const b = billed.get(o.order_number);
    let state = 'count';
    if (o.canceled) state = 'canceled';
    else if (b && b.ym !== ym) state = 'other_month';
    const row = { order_number: o.order_number, client_id: o.client_id, done_at: tpe(o.done_at), label: o.label,
      lines, amount: state === 'count' ? amount : 0, calc_amount: amount, state, bind_synced: o.bind_synced, other_month: b && b.ym !== ym ? b.ym : null };
    s.orders.push(row);
    if (state === 'canceled') s.canceled++;
    else if (state === 'other_month') s.other_month++;
    else { s.counted++; if (!amount) s.zero++; s.order_amount = r2(s.order_amount + amount); if (!o.bind_synced) s.unsynced++; }
  }
  for (const e of extrasQ.data || []) {
    const s = S(String(e.store_erpid));
    s.extras.push(e); s.extra_amount = r2(s.extra_amount + Number(e.amount));
  }
  for (const s of Object.values(stores)) {
    s.total = r2(s.order_amount + s.extra_amount);
    s.orders.sort((a, b) => (a.done_at < b.done_at ? -1 : 1));
    if (s.opened) s.diff = r2(s.total - Number(s.opened.amount));
  }
  for (const [id, m] of Object.entries(opened)) if (!stores[id]) { S(id); stores[id].diff = r2(-Number(m.amount)); }
  return { ym, stores, feed: { count: orders.length, ms: feed.ms, without_order: (feed.logs_without_order || []).length },
    priced_items: prices.rows.length };
}

async function summary(ym, opts) {
  const c = await compute(ym, opts);
  const list = Object.values(c.stores).map(({ orders, extras, ...s }) => s).sort((a, b) => (a.store_name > b.store_name ? 1 : -1));
  return { ym, feed: c.feed, priced_items: c.priced_items, stores: list,
    total: r2(list.reduce((t, s) => t + (s.opened ? Number(s.opened.amount) : s.total), 0)) };
}

async function storeDetail(ym, store, opts) {
  const c = await compute(ym, opts);
  const s = c.stores[String(store)];
  if (!s) return { ym, store_erpid: String(store), store_name: (await storeNames())[String(store)] || String(store), orders: [], extras: [], total: 0, counted: 0, order_amount: 0, extra_amount: 0, opened: null };
  return { ym, ...s };
}

async function closedReport(store, ym) {
  const { data } = await supabase.from('store_month_reports').select('status').eq('store_erpid', String(store)).eq('ym', ym).maybeSingle();
  return !!(data && data.status === 'closed');
}

async function sourceId() {
  const { data } = await supabase.from('billing_sources').select('id').eq('code', 'PROC_CENTER').maybeSingle();
  if (!data) throw new Error('找不到帳單來源「加工中心」（migration 036）');
  return data.id;
}

async function open(ym, store, actor) {
  store = String(store);
  const { data: ex } = await supabase.from('proc_month_store').select('id').eq('ym', ym).eq('store_erpid', store).is('voided_at', null).maybeSingle();
  if (ex) throw Object.assign(new Error('這家店這個月已經開帳了，要改請先「重新開帳」'), { status: 409 });
  const s = await storeDetail(ym, store, { fresh: true });
  const counted = s.orders.filter((o) => o.state === 'count');
  const total = r2(s.total);
  const snapshot = { at: new Date().toISOString(), orders: counted, skipped: s.orders.filter((o) => o.state !== 'count'),
    extras: s.extras.map((e) => ({ id: e.id, order_number: e.order_number, amount: Number(e.amount), reason: e.reason, by: e.created_by })),
    order_amount: s.order_amount, extra_amount: s.extra_amount };

  let billId = null; let reportYm = null;
  if (total !== 0) {
    const items = counted.filter((o) => o.amount).map((o, i) => ({ type: 'completion', seq_no: i + 1, item_date: o.done_at.slice(0, 10), doc_number: o.order_number,
      product_spec: o.lines.filter((l) => l.price).map((l) => `${l.name || l.bind_id} ${l.price}`).join('／'), quantity: 1, unit_price: o.amount, total: o.amount,
      store_erpid: store, store_name: s.store_name }))
      .concat(s.extras.map((e, i) => ({ type: Number(e.amount) < 0 ? 'return' : 'completion', seq_no: counted.length + i + 1, doc_number: e.order_number || null,
        product_spec: `追加：${e.reason}`, quantity: 1, unit_price: Math.abs(Number(e.amount)), total: Number(e.amount), store_erpid: store, store_name: s.store_name })));
    const now = new Date().toISOString();
    const { data: bill, error } = await supabase.from('bills').insert({
      source_id: await sourceId(), period: ym, title: `加工中心開帳 ${ym}｜${s.store_name}`,
      description: `加工中心開帳系統：${counted.length} 張單（${s.order_amount}）＋追加 ${s.extras.length} 筆（${s.extra_amount}）`,
      total_amount: total, status: 'confirmed', items, source_ref: `PROC-${ym}-${store}`, submitted_at: now, confirmed_at: now,
      created_by_type: 'system', notes: `開帳人：${actor}`, ledger_code: LEDGER_CODE,
    }).select('id').single();
    if (error) throw error;
    billId = bill.id;
    const { error: e2 } = await supabase.from('bill_allocations').insert({ bill_id: billId, store_erpid: store, store_name: s.store_name,
      allocated_amount: total, allocation_note: `加工中心開帳 ${ym}` });
    if (e2) { await supabase.from('bills').update({ status: 'void' }).eq('id', billId); throw e2; }
    const res = await require('./ledgerPost').applyToBill(billId, { report_ym: ym, ledger_code: LEDGER_CODE, fee_ym: ym, by: actor });
    const { data: al } = await supabase.from('bill_allocations').select('report_ym').eq('bill_id', billId).maybeSingle();
    reportYm = (al && al.report_ym) || ym;
    snapshot.ledger_note = res && res.notes;
  }
  const { data: ms, error: e3 } = await supabase.from('proc_month_store').insert({ ym, store_erpid: store, store_name: s.store_name, amount: total,
    order_count: counted.length, snapshot, bill_id: billId, report_ym: reportYm, opened_by: actor }).select('*').single();
  if (e3) { if (billId) await supabase.from('bills').update({ status: 'void' }).eq('id', billId); throw e3; }
  const rows = counted.map((o) => ({ order_number: o.order_number, month_store_id: ms.id, ym, store_erpid: store, amount: o.amount }));
  for (let i = 0; i < rows.length; i += 500) {
    const { error: e4 } = await supabase.from('proc_billed_orders').upsert(rows.slice(i, i + 500), { onConflict: 'order_number' });
    if (e4) console.error('[processing] billed_orders', e4.message);
  }
  cache.delete(ym);
  return ms;
}

async function reopen(ym, store, actor, reason) {
  if (!String(reason || '').trim()) throw Object.assign(new Error('重新開帳要寫原因'), { status: 400 });
  const { data: ms } = await supabase.from('proc_month_store').select('*').eq('ym', ym).eq('store_erpid', String(store)).is('voided_at', null).maybeSingle();
  if (!ms) throw Object.assign(new Error('這個月還沒開帳'), { status: 404 });
  const rym = ms.report_ym || ym;
  if (ms.bill_id && await closedReport(store, rym)) {
    throw Object.assign(new Error(`門市月報 ${rym} 已關帳，不能重新開帳；差額請在下個月用「追加金額」補`), { status: 409 });
  }
  if (ms.bill_id) await supabase.from('bills').update({ status: 'void', notes: `加工中心重新開帳作廢：${actor}｜${reason}` }).eq('id', ms.bill_id);
  await supabase.from('proc_billed_orders').delete().eq('month_store_id', ms.id);
  await supabase.from('proc_month_store').update({ voided_at: new Date().toISOString(), voided_by: actor, void_reason: String(reason).trim() }).eq('id', ms.id);
  cache.delete(ym);
  return { ok: true };
}

module.exports = { feedGet, compute, summary, storeDetail, open, reopen, priceTable, YM, addYm, closedReport };
