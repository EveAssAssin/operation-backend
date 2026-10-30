// services/processingCenter.js — 加工中心開帳（2026-10-20；2026-10-30 改回舊方式）
//
// 2026-10-30 營運：沿用舊開帳方式＝依「下單日期」，週期上月 21 日～本月 20 日（例：2026-10 期＝9/21～10/20，列入 10 月門市月報）；
//   舊方式開到 2026-08-20，新系統第一期＝2026-09（8/21～9/20）。設定 report_settings.proc_cycle。
// 資料來源：加工站 lohastracking-php GET billingFeed/cycle（同加工後台「報表統計」有鏡片那頁的單，含已取消的單＋加工做完了沒）
// 規則：
//   · 已取消：加工做完了（到過「加工已交貨」狀態）照算、沒做完不算
//   · 開帳後才取消、加工沒做完 → 下一期自動沖回（proc_billed_orders.credit_ym）
//   · ERP 晚送進來：下單日期在「已開帳的期別」、這家店那期已開帳、這張還沒開過 → 這一期補開（state late）
//   · ERP 不能改單（只能退貨重建），所以不處理改單差額
// 金額：proc_price_items（主管設定，bind_id × 生效月份＝期別）；一張單同品項只算一次；鏡框不計價
// 開帳：每家店每期一筆 proc_month_store ＋ 一張帳單（來源「加工中心」、lens_lab 代工中心代工費）→ 門市月報
const supabase = require('../config/supabase');

const YM = /^\d{4}-(0[1-9]|1[0-2])$/;
const FEED_URL = () => (process.env.PROC_FEED_URL || 'https://lohastracking.realtime.tw').replace(/\/+$/, '');
const LEDGER_CODE = 'lens_lab';
const addYm = (ym, k) => { const [y, m] = ym.split('-').map(Number); return new Date(Date.UTC(y, m - 1 + k, 1)).toISOString().slice(0, 7); };
// 鏡框（ERP 物料 镜架／太阳镜）不是加工中心的費用：不列入待設金額、不計價（營運 10-20）
const FRAME_MATERIEL = /^(镜架|鏡架|太阳镜|太陽鏡|太陽眼鏡)$/;
const isFrame = (pr) => FRAME_MATERIEL.test(String((pr && pr.materiel) || '').trim());
const r2 = (n) => Math.round(Number(n || 0) * 100) / 100;
const tpe = (ts) => new Date(ts * 1000 + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' ');
const tpeDate = (ts) => new Date(ts * 1000 + 8 * 3600e3).toISOString().slice(0, 10);
const addDays = (d, k) => new Date(Date.parse(d + 'T00:00:00Z') + k * 86400e3).toISOString().slice(0, 10);

// exclude_stores：不列入加工中心開帳的門市（ERP 門市編號；營運 10-30：SUBANG SS15＝120069）
const CYCLE_DEF = { start: '2026-08-21', end_day: 20, lookback_days: 90, include_no_lens: false, credit_months: 6, exclude_stores: ['120069'] };
let cfgCache = null;
async function cycleCfg() {
  if (cfgCache && Date.now() - cfgCache.at < 60000) return cfgCache.v;
  const { data } = await supabase.from('report_settings').select('value').eq('key', 'proc_cycle').maybeSingle();
  const v = { ...CYCLE_DEF, ...((data && data.value) || {}) };
  cfgCache = { at: Date.now(), v };
  return v;
}
// 期別 ym ＝ (上月 end_day+1) ～ (本月 end_day)；回 { from, to(不含), label }
function cycleRange(ym, endDay) {
  const d = Number(endDay) || 20;
  const pad = (n) => String(n).padStart(2, '0');
  const from = `${addYm(ym, -1)}-${pad(d + 1)}`;
  const to = `${ym}-${pad(d + 1)}`;
  const [, fm, fd] = from.split('-'); const [, tm] = to.split('-');
  return { from, to, label: `${Number(fm)}/${Number(fd)}～${Number(tm)}/${d}` };
}
// 下單日期（YYYY-MM-DD）屬於哪一期
function cycleOf(date, endDay) {
  const ym = date.slice(0, 7); const day = Number(date.slice(8, 10));
  return day > (Number(endDay) || 20) ? addYm(ym, 1) : ym;
}

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

async function feedPost(path, body) {
  const key = process.env.PROC_FEED_KEY || '';
  if (key.length < 32) throw new Error('營運部後端還沒設定 PROC_FEED_KEY（加工站資料金鑰）');
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 90000);
  try {
    const r = await fetch(`${FEED_URL()}/${path}`, { method: 'POST', headers: { 'X-Feed-Key': key, 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body || {}), signal: ctl.signal });
    const txt = await r.text();
    if (r.status === 404 || r.status === 405) throw new Error('加工站還沒有這支資料介面（lohastracking 新版還沒部署）');
    let j; try { j = JSON.parse(txt); } catch { throw new Error(`加工站回應不是 JSON（HTTP ${r.status}）：${txt.slice(0, 120)}`); }
    if (!r.ok || !j.ok) throw new Error(`加工站 ${path} 失敗（HTTP ${r.status}）：${j.error || ''}`);
    return j;
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(`加工站 ${path} 逾時（90 秒）`);
    throw e;
  } finally { clearTimeout(t); }
}

const cache = new Map();   // key -> {at, data}
async function cached(key, fresh, fn) {
  const c = cache.get(key);
  if (!fresh && c && Date.now() - c.at < 120000) return c.data;
  const data = await fn();
  cache.set(key, { at: Date.now(), data });
  return data;
}
// 這一期要看的單：下單日期 [max(新制起點, 期初 − lookback), 期末)
async function feedCycle(ym, cfg, fresh) {
  const cr = cycleRange(ym, cfg.end_day);
  let from = addDays(cr.from, -(Number(cfg.lookback_days) || 0));
  if (from < cfg.start) from = cfg.start;
  return cached(`cycle:${ym}`, fresh, () => feedGet('billingFeed/cycle', { from, to: cr.to }));
}
// 已開帳、還沒沖回的單：現在取消了沒、加工做完了沒
async function creditCandidates(ym, cfg, fresh) {
  return cached(`credit:${ym}`, fresh, async () => {
    const since = addYm(ym, -(Number(cfg.credit_months) || 6));
    const rows = [];
    for (let off = 0; ; off += 1000) {
      const { data, error } = await supabase.from('proc_billed_orders').select('order_number, ym, store_erpid, amount, order_date, credit_ym, month_store_id')
        .lt('ym', ym).gte('ym', since).is('credit_ym', null).neq('amount', 0).range(off, off + 999);
      if (error) throw error;
      rows.push(...(data || []));
      if (!data || data.length < 1000) break;
    }
    const { data: mine } = await supabase.from('proc_billed_orders').select('order_number, ym, store_erpid, amount, order_date, credit_ym, month_store_id').eq('credit_ym', ym);
    const status = {};
    for (let i = 0; i < rows.length; i += 3000) {
      const j = await feedPost('billingFeed/status', { numbers: rows.slice(i, i + 3000).map((r) => r.order_number) });
      Object.assign(status, j.orders || {});
    }
    const out = rows.filter((r) => { const st = status[r.order_number]; return st && st.canceled && st.processed === false; });
    return out.concat(mine || []);
  });
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

// 算一期：回 { stores: { erpid: {...} }, items, cycle }
async function compute(ym, { fresh } = {}) {
  if (!YM.test(ym)) throw new Error('期別要 YYYY-MM');
  const cfg = await cycleCfg();
  const firstYm = cycleOf(cfg.start, cfg.end_day);
  const cr = cycleRange(ym, cfg.end_day);
  if (ym < firstYm) throw Object.assign(new Error(`加工中心開帳從 ${firstYm} 期（${cycleRange(firstYm, cfg.end_day).label}）開始；之前用舊方式開到 ${addDays(cfg.start, -1)}`), { status: 400 });
  const [feed, credits, prices, names, openedQ, extrasQ] = await Promise.all([
    feedCycle(ym, cfg, fresh), creditCandidates(ym, cfg, fresh), priceTable(), storeNames(),
    supabase.from('proc_month_store').select('*').eq('ym', ym).is('voided_at', null),
    supabase.from('proc_order_extra').select('*').eq('ym', ym).is('voided_at', null).order('created_at'),
  ]);
  const products = feed.products || {};
  const excluded = new Set((cfg.exclude_stores || []).map(String));
  const orders = (feed.orders || []).filter((o) => (cfg.include_no_lens || !o.no_lens) && !excluded.has(String(o.store_id)));
  const nums = orders.map((o) => o.order_number);
  const billed = new Map();
  for (let i = 0; i < nums.length; i += 500) {
    const { data } = await supabase.from('proc_billed_orders').select('order_number, ym, store_erpid').in('order_number', nums.slice(i, i + 500));
    for (const b of data || []) billed.set(b.order_number, b);
  }
  // 之前的期別哪些店已開帳（晚到的單只在「那一期那家店已開帳」時補開，沒開帳的等它自己那一期）
  const prevYms = [...new Set(orders.map((o) => cycleOf(tpeDate(o.order_date), cfg.end_day)).filter((y) => y < ym))];
  const prevOpened = new Set();
  if (prevYms.length) {
    const { data } = await supabase.from('proc_month_store').select('ym, store_erpid').in('ym', prevYms).is('voided_at', null);
    for (const m of data || []) prevOpened.add(`${m.ym}|${m.store_erpid}`);
  }
  const opened = Object.fromEntries((openedQ.data || []).map((m) => [m.store_erpid, m]));
  const stores = {};
  const items = new Map();
  const S = (id) => (stores[id] = stores[id] || { store_erpid: id, store_name: names[id] || id, orders: [], extras: [], credits: [],
    counted: 0, late: 0, zero: 0, canceled: 0, canceled_done: 0, other_month: 0, unsynced: 0,
    order_amount: 0, credit_amount: 0, extra_amount: 0, total: 0, opened: opened[id] || null });
  const linesOf = (o) => (o.bind_ids || []).filter((b) => !isFrame(products[b])).map((b) => {
    const p = prices.of(b, ym); const pr = products[b] || {};
    return { bind_id: String(b), name: pr.name || (p && p.name) || '', brand: pr.brand || '', catena: pr.catena || '',
      materiel: pr.materiel || '', model: pr.model || '', price: p ? Number(p.amount) : null };
  });
  for (const o of orders) {
    const od = tpeDate(o.order_date);
    const own = cycleOf(od, cfg.end_day);
    const store = String(o.store_id);
    const b = billed.get(o.order_number);
    let state = 'count';
    if (own < ym) {
      if (b) continue;                                     // 之前的期別開過了
      if (!prevOpened.has(`${own}|${store}`)) continue;    // 那一期這家店還沒開帳 → 等那一期
      state = 'late';
    } else if (b && b.ym !== ym) state = 'other_month';
    if (o.canceled && !o.processed) state = 'canceled';
    const s = S(store);
    const lines = linesOf(o);
    const amount = r2(lines.reduce((t, l) => t + (l.price || 0), 0));
    const counts = state === 'count' || state === 'late';
    const row = { order_number: o.order_number, client_id: o.client_id, order_date: od, done_at: tpe(o.order_date), own_ym: own, label: o.label,
      lines, amount: counts ? amount : 0, calc_amount: amount, state, canceled: !!o.canceled, canceled_done: !!(o.canceled && o.processed),
      bind_synced: o.bind_synced, other_month: b && b.ym !== ym ? b.ym : null };
    s.orders.push(row);
    if (state === 'canceled') { s.canceled++; continue; }
    if (state === 'other_month') { s.other_month++; continue; }
    s.counted++; if (state === 'late') s.late++; if (row.canceled_done) s.canceled_done++;
    if (!amount) s.zero++; s.order_amount = r2(s.order_amount + amount); if (!o.bind_synced) s.unsynced++;
    // 這一期實際收到的品項（給主管直接填金額，不用自己搜尋主檔）
    for (const l of lines) {
      let it = items.get(l.bind_id);
      if (!it) { it = { bind_id: l.bind_id, name: l.name, brand: l.brand, catena: l.catena, materiel: l.materiel, model: l.model, price: l.price, orders: 0, stores: new Set(), sample: [] }; items.set(l.bind_id, it); }
      it.orders++; it.stores.add(s.store_name);
      if (it.sample.length < 3) it.sample.push(o.order_number);
    }
  }
  // 沖回：之前開帳過、現在取消了且加工沒做完
  for (const c of credits || []) {
    if (excluded.has(String(c.store_erpid))) continue;
    const s = S(String(c.store_erpid));
    const amt = -Math.abs(Number(c.amount));
    s.credits.push({ order_number: c.order_number, billed_ym: c.ym, order_date: c.order_date, amount: amt });
    s.credit_amount = r2(s.credit_amount + amt);
  }
  for (const e of extrasQ.data || []) {
    if (excluded.has(String(e.store_erpid))) continue;
    const s = S(String(e.store_erpid));
    s.extras.push(e); s.extra_amount = r2(s.extra_amount + Number(e.amount));
  }
  for (const s of Object.values(stores)) {
    s.total = r2(s.order_amount + s.credit_amount + s.extra_amount);
    s.orders.sort((a, b) => (a.done_at < b.done_at ? -1 : 1));
    if (s.opened) s.diff = r2(s.total - Number(s.opened.amount));
  }
  for (const [id, m] of Object.entries(opened)) if (!stores[id]) { S(id); stores[id].diff = r2(-Number(m.amount)); }
  const itemList = [...items.values()].map((it) => ({ ...it, stores: [...it.stores].sort(), store_count: it.stores.size }))
    .sort((a, b) => b.orders - a.orders || (a.name > b.name ? 1 : -1));
  return { ym, cycle: { ...cr, first_ym: firstYm, include_no_lens: !!cfg.include_no_lens, exclude_stores: [...excluded] }, stores, items: itemList,
    feed: { count: orders.length, ms: feed.ms, filter_tags: feed.filter_tags || [] }, priced_items: prices.rows.length };
}

async function summary(ym, opts) {
  const c = await compute(ym, opts);
  const list = Object.values(c.stores).map(({ orders, extras, credits, ...s }) => ({ ...s, credit_count: credits.length })).sort((a, b) => (a.store_name > b.store_name ? 1 : -1));
  return { ym, cycle: c.cycle, feed: c.feed, priced_items: c.priced_items, stores: list,
    unpriced: c.items.filter((i) => i.price == null), priced_here: c.items.filter((i) => i.price != null),
    total: r2(list.reduce((t, s) => t + (s.opened ? Number(s.opened.amount) : s.total), 0)) };
}

async function storeDetail(ym, store, opts) {
  const c = await compute(ym, opts);
  const s = c.stores[String(store)];
  if (!s) return { ym, cycle: c.cycle, store_erpid: String(store), store_name: (await storeNames())[String(store)] || String(store), orders: [], extras: [], credits: [], total: 0, counted: 0, order_amount: 0, credit_amount: 0, extra_amount: 0, opened: null };
  return { ym, cycle: c.cycle, ...s };
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
  if (ex) throw Object.assign(new Error('這家店這一期已經開帳了，要改請先「重新開帳」'), { status: 409 });
  const cfg0 = await cycleCfg();
  if ((cfg0.exclude_stores || []).map(String).includes(store)) throw Object.assign(new Error('這家門市不列入加工中心開帳'), { status: 400 });
  const s = await storeDetail(ym, store, { fresh: true });
  const counted = s.orders.filter((o) => o.state === 'count' || o.state === 'late');
  const credits = s.credits || [];
  const total = r2(s.total);
  const snapshot = { at: new Date().toISOString(), cycle: s.cycle, orders: counted, skipped: s.orders.filter((o) => o.state !== 'count' && o.state !== 'late'),
    credits, extras: s.extras.map((e) => ({ id: e.id, order_number: e.order_number, amount: Number(e.amount), reason: e.reason, by: e.created_by })),
    order_amount: s.order_amount, credit_amount: s.credit_amount || 0, extra_amount: s.extra_amount };

  let billId = null; let reportYm = null;
  if (total !== 0) {
    const items = counted.filter((o) => o.amount).map((o) => ({ type: o.amount < 0 ? 'return' : 'completion', item_date: o.order_date, doc_number: o.order_number,
      product_spec: (o.state === 'late' ? `（${o.own_ym} 期晚到補開）` : '') + (o.canceled_done ? '（已取消・加工已完成）' : '') + o.lines.filter((l) => l.price).map((l) => `${l.name || l.bind_id} ${l.price}`).join('／'),
      quantity: 1, unit_price: Math.abs(o.amount), total: o.amount, store_erpid: store, store_name: s.store_name }))
      .concat(credits.map((c) => ({ type: 'return', item_date: c.order_date || null, doc_number: c.order_number,
        product_spec: `沖回：${c.billed_ym} 期已開帳、之後取消且加工沒做完`, quantity: 1, unit_price: Math.abs(c.amount), total: c.amount, store_erpid: store, store_name: s.store_name })))
      .concat(s.extras.map((e) => ({ type: Number(e.amount) < 0 ? 'return' : 'completion', doc_number: e.order_number || null,
        product_spec: `追加：${e.reason}`, quantity: 1, unit_price: Math.abs(Number(e.amount)), total: Number(e.amount), store_erpid: store, store_name: s.store_name })))
      .map((it, i) => ({ ...it, seq_no: i + 1 }));
    const now = new Date().toISOString();
    const { data: bill, error } = await supabase.from('bills').insert({
      source_id: await sourceId(), period: ym, title: `加工中心開帳 ${ym}（${s.cycle.label}）｜${s.store_name}`,
      description: `加工中心開帳系統（依下單日期 ${s.cycle.label}）：${counted.length} 張單（${s.order_amount}）${credits.length ? `＋沖回 ${credits.length} 張（${s.credit_amount}）` : ''}＋追加 ${s.extras.length} 筆（${s.extra_amount}）`,
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
  const rows = counted.map((o) => ({ order_number: o.order_number, month_store_id: ms.id, ym, store_erpid: store, amount: o.amount, order_date: o.order_date }));
  for (let i = 0; i < rows.length; i += 500) {
    const { error: e4 } = await supabase.from('proc_billed_orders').upsert(rows.slice(i, i + 500), { onConflict: 'order_number' });
    if (e4) console.error('[processing] billed_orders', e4.message);
  }
  for (let i = 0; i < credits.length; i += 500) {
    const { error: e5 } = await supabase.from('proc_billed_orders').update({ credit_ym: ym, credit_month_store_id: ms.id })
      .in('order_number', credits.slice(i, i + 500).map((c) => c.order_number)).is('credit_ym', null);
    if (e5) console.error('[processing] credit', e5.message);
  }
  clearCache();
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
  const { data: cr } = await supabase.from('proc_billed_orders').select('order_number, credit_ym').eq('month_store_id', ms.id).not('credit_ym', 'is', null).limit(3);
  if (cr && cr.length) throw Object.assign(new Error(`這一期有單已經在 ${cr[0].credit_ym} 期沖回（${cr.map((x) => x.order_number).join('、')}），要先重新開帳 ${cr[0].credit_ym} 期`), { status: 409 });
  if (ms.bill_id) await supabase.from('bills').update({ status: 'void', notes: `加工中心重新開帳作廢：${actor}｜${reason}` }).eq('id', ms.bill_id);
  await supabase.from('proc_billed_orders').update({ credit_ym: null, credit_month_store_id: null }).eq('credit_month_store_id', ms.id);
  await supabase.from('proc_billed_orders').delete().eq('month_store_id', ms.id);
  await supabase.from('proc_month_store').update({ voided_at: new Date().toISOString(), voided_by: actor, void_reason: String(reason).trim() }).eq('id', ms.id);
  clearCache();
  return { ok: true };
}

function clearCache() { cache.clear(); cfgCache = null; }
module.exports = { isFrame, clearCache, feedGet, feedPost, cycleCfg, cycleRange, cycleOf, compute, summary, storeDetail, open, reopen, priceTable, YM, addYm, closedReport };
