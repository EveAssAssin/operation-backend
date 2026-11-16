// services/liveReport.js —— 店長工具「即時月報」（2026-11-17 Louis，migration 056）
// 不是真的月報：部分真實值、部分估計、部分預測；每天凌晨（jobs/liveReportDaily）算「到昨天為止」存一份 live_reports。
//
// 每一格怎麼來（status）：
//   actual   實際：本月已經有帳（月報那一格本月已經有資料：固定支出、分攤、合約、已進來的帳單…）
//   estimate 估：會隨銷售變動的成本，用 ERP 訂單反推（市場部 /api/internal/report/live-cost）
//              鏡框＝型號第 4 段成本；鏡片＝鏡片成本表 × 片數；隱眼／護理＝賣價 × 65%；代工＝有鏡片的單 ×（150＋運費 50）
//              刷卡手續費／包裝／物流＝過去 3 個月「這格 ÷ 實收」的比例 × 本月實收
//   forecast 預測：帳單晚到的格子（本月還沒有帳）＝最近 3 個已關帳月份的平均
// 收入：月報的總真實實收（沒填就用訂單業績）＋API 支付，到昨天為止。
// 月底預估：收入 ÷ 去年同月「到這一天的累計占比」（沒有去年資料就用天數比例）；估的成本跟著收入放大；實際／預測照整月。
// 校正：上個月關帳後，比較「月底那天的預估」跟「關帳的實際」（鏡框、鏡片、代工、藥拋、刷卡、包裝、物流），
//       係數＝實際 ÷ 預估，存 live_calibration；之後的估法乘上最近 3 個月係數的平均（限 0.5～2）。
const supabase = require('../config/supabase');
const MR = require('./monthlyReport');

const YM = /^\d{4}-(0[1-9]|1[0-2])$/;
const r0 = (n) => Math.round(Number(n) || 0);
const addYm = (ym, k) => { const [y, m] = ym.split('-').map(Number); return new Date(Date.UTC(y, m - 1 + k, 1)).toISOString().slice(0, 7); };
const dim = (ym) => { const [y, m] = ym.split('-').map(Number); return new Date(Date.UTC(y, m, 0)).getUTCDate(); };
const tpeDay = (d = new Date()) => new Date(d.getTime() + 8 * 3600e3).toISOString().slice(0, 10);
const DIVIDEND = ['marketing_fund', 'depreciation'];
const SALES_KEYS = { frame_hq: 'frame', lens_hq: 'lens', lens_lab: 'lens_lab', contact_hq: 'contact' };
const MERGED = ['frame_vendor', 'lens_vendor', 'contact_vendor'];   // 併進上面那一格（訂單反推不分總部出貨／廠商）
const KEY_NAME = { frame: '鏡框成本（依訂單估）', lens: '鏡片成本（依訂單估）', lens_lab: '代工費（依訂單估）', contact: '藥拋成本（賣價 65%）' };

async function settings() {
  const { data } = await supabase.from('report_settings').select('value').eq('key', 'live_report').maybeSingle();
  return { contact_ratio: 0.65, lab_fee: 150, ship_fee: 50, hist_months: 3, ratio_codes: ['card_fee', 'packaging', 'logistics'], ...((data && data.value) || {}) };
}
async function lensCosts() {
  const { data } = await supabase.from('live_lens_costs').select('bind_id, cost').not('cost', 'is', null).limit(20000);
  return Object.fromEntries((data || []).map((r) => [String(r.bind_id), Number(r.cost)]));
}
async function factors() {
  const { data } = await supabase.from('live_calibration').select('ym, key, factor').not('factor', 'is', null).order('ym', { ascending: false }).limit(200);
  const by = {};
  for (const r of data || []) { (by[r.key] = by[r.key] || []); if (by[r.key].length < 3) by[r.key].push(Number(r.factor)); }
  return Object.fromEntries(Object.entries(by).map(([k, l]) => [k, Math.min(2, Math.max(0.5, l.reduce((a, b) => a + b, 0) / l.length))]));
}

async function market(ym, body) {
  const base = (process.env.MARKET_BACKEND_URL || 'https://market-backend-0544.onrender.com').replace(/\/+$/, '');
  const key = process.env.MARKET_INTERNAL_KEY;
  if (!key) throw new Error('營運部沒設 MARKET_INTERNAL_KEY');
  const r = await fetch(`${base}/api/internal/report/live-cost`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-internal-key': key }, body: JSON.stringify({ ym, ...body }), signal: AbortSignal.timeout(300000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.success === false) throw new Error(`市場部 live-cost ${r.status}：${j.message || ''}`);
  return j.data;
}

/** 最近 n 個已關帳月份（6 個月內）的每格金額與實收 */
async function history(store, ym, n) {
  const from = addYm(ym, -6);
  const { data } = await supabase.from('store_month_reports').select('ym, snapshot').eq('store_erpid', store).eq('status', 'closed').lt('ym', ym).gte('ym', from).order('ym', { ascending: false }).limit(n);
  return (data || []).filter((r) => r.snapshot).map((r) => {
    const rows = {};
    for (const g of [...(r.snapshot.left || []), ...(r.snapshot.right || [])]) for (const x of g.rows || []) rows[x.code] = (rows[x.code] || 0) + (Number(x.amount) || 0);
    const t = r.snapshot.totals || {};
    return { ym: r.ym, rows, income: Number(t.total_in) || 0, receipt: Number(t.receipt_total) || 0 };
  });
}

function aggDays(days, upTo) {
  const o = { orders: 0, glasses_rev: 0, contact_rev: 0, frame: 0, frame_unknown: 0, lens: 0, lens_lines: 0, lens_unknown_lines: 0, contact: 0, lab_orders: 0 };
  for (const [d, x] of Object.entries(days || {})) { if (upTo && d > upTo) continue; for (const k of Object.keys(o)) o[k] += Number(x[k]) || 0; }
  return o;
}

/** 一家店 ym 到 day 為止 */
async function buildStore(store, ym, day, ctx) {
  const S = ctx.settings;
  const rep = await MR.build(ym, store, {}).catch((e) => ({ error: e.message }));
  if (rep.error) return { store, error: rep.error };
  const hist = await history(store, ym, S.hist_months);
  const mk = (ctx.market.stores || {})[store] || { days: {} };
  const ly = (ctx.lastYear && ctx.lastYear.stores && ctx.lastYear.stores[store]) || null;
  const m = aggDays(mk.days, day);
  const F = ctx.factors || {};
  const n = dim(ym), d = Number(day.slice(8, 10));

  // 收入（到昨天）：月報的實收（會計還沒填就用訂單業績）＋API 支付
  const rt = rep.totals || {};
  const orderRev = m.glasses_rev + m.contact_rev;
  const receipt = rt.receipt_total != null ? Number(rt.receipt_total) : (rt.book_receipt_total != null ? Number(rt.book_receipt_total) : orderRev);
  const incomeMtd = receipt + (Number(rt.api_in) || 0) + (Number(rt.extra_in) || 0);
  // 月底占比：去年同月到這一天的累計業績占比
  let share = d / n, curve = 'days';
  if (ly && ly.days) {
    const all = Object.entries(ly.days).reduce((s, [, x]) => s + (x.glasses_rev || 0) + (x.contact_rev || 0), 0);
    const lyDay = `${addYm(ym, -12)}-${String(d).padStart(2, '0')}`;
    const cum = Object.entries(ly.days).filter(([k]) => k <= lyDay).reduce((s, [, x]) => s + (x.glasses_rev || 0) + (x.contact_rev || 0), 0);
    if (all > 0 && cum > 0) { share = Math.min(1, cum / all); curve = 'last_year'; }
  }
  if (d >= n) share = 1;
  const scale = share > 0 ? 1 / share : 1;
  const incomeProj = r0(incomeMtd * scale);

  // 每一格
  const { data: accs } = await supabase.from('ledger_accounts').select('code, name, group_code, kind, sort_order').eq('kind', 'expense').order('sort_order');
  const cur = {}; for (const g of [...(rep.left || []), ...(rep.right || [])]) for (const x of g.rows || []) cur[x.code] = x;
  const histAvg = (code) => (hist.length ? hist.reduce((s, h) => s + (h.rows[code] || 0), 0) / hist.length : 0);
  const histRatio = (code) => { const inc = hist.reduce((s, h) => s + h.income, 0); return inc > 0 ? hist.reduce((s, h) => s + (h.rows[code] || 0), 0) / inc : 0; };
  const raw = { frame: m.frame, lens: m.lens, lens_lab: m.lab_orders * (Number(S.lab_fee) + Number(S.ship_fee)), contact: m.contact };
  const rows = [];
  for (const a of accs || []) {
    if (DIVIDEND.includes(a.code) || MERGED.includes(a.code)) continue;
    const c = cur[a.code];
    const key = SALES_KEYS[a.code];
    if (key) {
      const f = F[key] || 1;
      const mtd = r0(raw[key] * f);
      rows.push({ code: a.code, key, name: KEY_NAME[key], group: a.group_code, status: 'estimate', mtd, proj: r0(mtd * scale), raw: r0(raw[key]), factor: f,
        basis: key === 'lens_lab' ? `${m.lab_orders} 張鏡片單 ×（${S.lab_fee}＋${S.ship_fee}）` : key === 'lens' ? `${m.lens_lines} 片${m.lens_unknown_lines ? `（${m.lens_unknown_lines} 片沒有成本）` : ''}` : key === 'frame' ? `${m.frame_unknown ? `${m.frame_unknown} 支型號讀不到成本` : '型號成本'}` : `賣價 × ${Math.round(S.contact_ratio * 100)}%` });
      continue;
    }
    if ((S.ratio_codes || []).includes(a.code)) {
      const ratio = histRatio(a.code); const f = F[a.code] || 1;
      const mtd = r0(incomeMtd * ratio * f);
      if (mtd || (c && c.amount)) rows.push({ code: a.code, key: a.code, name: a.name, group: a.group_code, status: 'estimate', mtd, proj: r0(incomeProj * ratio * f), raw: r0(incomeMtd * ratio), factor: f, basis: `過去 ${hist.length} 個月占實收 ${Math.round(ratio * 1000) / 10}%` });
      continue;
    }
    if (c && c.has_data) { rows.push({ code: a.code, name: a.name, group: a.group_code, status: 'actual', mtd: r0(c.amount), proj: r0(c.amount), basis: (c.sources || []).join('、') }); continue; }
    const avg = r0(histAvg(a.code));
    if (avg) rows.push({ code: a.code, name: a.name, group: a.group_code, status: 'forecast', mtd: r0(avg * Math.min(1, d / n)), proj: avg, basis: `最近 ${hist.length} 個月平均` });
  }
  const sum = (st, k) => rows.filter((r) => !st || r.status === st).reduce((s, r) => s + r[k], 0);
  const costProj = sum(null, 'proj'), costMtd = sum(null, 'mtd');
  const notActual = sum('estimate', 'proj') + sum('forecast', 'proj');
  return {
    store, store_name: rep.store_name, ym, day, at: new Date().toISOString(), month_status: rep.status,
    income: { mtd: r0(incomeMtd), proj: incomeProj, receipt: r0(receipt), receipt_filled: rt.receipt_total != null, orders: m.orders, glasses_rev: m.glasses_rev, contact_rev: m.contact_rev },
    curve: { share: Math.round(share * 1000) / 1000, method: curve, day: d, days: n },
    rows,
    totals: { cost_mtd: costMtd, cost_proj: costProj, profit_mtd: r0(incomeMtd - costMtd), profit_proj: r0(incomeProj - costProj), est_pct: costProj ? Math.round((notActual / costProj) * 1000) / 10 : 0,
      by_status: { actual: sum('actual', 'proj'), estimate: sum('estimate', 'proj'), forecast: sum('forecast', 'proj') } },
    unknown: { lens_lines: m.lens_unknown_lines, frame: m.frame_unknown },
    daily: Object.entries(mk.days || {}).filter(([k]) => k <= day).sort().map(([k, x]) => ({ d: k, rev: (x.glasses_rev || 0) + (x.contact_rev || 0) })),
    ly_daily: ly ? Object.entries(ly.days || {}).sort().map(([k, x]) => ({ d: k, rev: (x.glasses_rev || 0) + (x.contact_rev || 0) })) : [],
    hist_months: hist.map((h) => h.ym),
  };
}

async function storeList() {
  const { data } = await supabase.from('store_month_reports').select('store_erpid').eq('status', 'closed').gte('ym', addYm(tpeDay().slice(0, 7), -6));
  return [...new Set((data || []).map((r) => String(r.store_erpid)))];
}

/** 全部門市跑一次（每天凌晨）；day＝資料算到哪一天（預設昨天） */
async function runAll({ day, stores } = {}) {
  day = day || tpeDay(new Date(Date.now() - 864e5));
  const ym = day.slice(0, 7);
  const S = await settings();
  const [lc, F] = await Promise.all([lensCosts(), factors()]);
  const mk = await market(ym, { lens_costs: lc, contact_ratio: S.contact_ratio });
  let ly = null; try { ly = await market(addYm(ym, -12), { contact_ratio: S.contact_ratio }); } catch (e) { console.warn('[liveReport] 去年同月', e.message); }
  const ctx = { settings: S, market: mk, lastYear: ly, factors: F };
  const list = stores && stores.length ? stores.map(String) : await storeList();
  const out = [];
  for (const s of list) {
    try {
      const p = await buildStore(s, ym, day, ctx);
      if (p.error) { out.push({ store: s, error: p.error }); continue; }
      await supabase.from('live_reports').upsert({ store_erpid: s, ym, day, payload: p, created_at: new Date().toISOString() }, { onConflict: 'store_erpid,ym,day' });
      out.push({ store: s, profit_proj: p.totals.profit_proj, est_pct: p.totals.est_pct });
    } catch (e) { out.push({ store: s, error: e.message }); }
  }
  await supabase.from('report_settings').upsert({ key: 'live_report_unknown', value: { ym, day, lens: mk.unknown_lens || [] }, updated_at: new Date().toISOString() }, { onConflict: 'key' });
  let cal = null; try { cal = await calibrate(addYm(ym, -1)); } catch (e) { cal = { error: e.message }; }
  return { ym, day, stores: out.length, errors: out.filter((x) => x.error), calibration: cal };
}

/** 關帳後校正：ym 的「月底那天的預估」vs 關帳實際（全部門市合計） */
async function calibrate(ym) {
  const { count } = await supabase.from('live_calibration').select('key', { count: 'exact', head: true }).eq('ym', ym);
  if (count) return { skipped: '已校正過' };
  const { data: closed } = await supabase.from('store_month_reports').select('store_erpid, snapshot').eq('ym', ym).eq('status', 'closed');
  if (!closed || !closed.length) return { skipped: '還沒關帳' };
  const keys = ['frame', 'lens', 'lens_lab', 'contact', 'card_fee', 'packaging', 'logistics'];
  const codesOf = { frame: ['frame_hq', 'frame_vendor'], lens: ['lens_hq', 'lens_vendor'], lens_lab: ['lens_lab'], contact: ['contact_hq', 'contact_vendor'], card_fee: ['card_fee'], packaging: ['packaging'], logistics: ['logistics'] };
  const acc = Object.fromEntries(keys.map((k) => [k, { est: 0, actual: 0, stores: 0 }]));
  for (const c of closed) {
    const { data: lr } = await supabase.from('live_reports').select('payload').eq('store_erpid', c.store_erpid).eq('ym', ym).order('day', { ascending: false }).limit(1);
    const p = lr && lr[0] && lr[0].payload; if (!p || !c.snapshot) continue;
    const act = {}; for (const g of [...(c.snapshot.left || []), ...(c.snapshot.right || [])]) for (const x of g.rows || []) act[x.code] = (act[x.code] || 0) + (Number(x.amount) || 0);
    const sc = p.curve && p.curve.share ? 1 / p.curve.share : 1;
    for (const k of keys) {
      const r = (p.rows || []).find((x) => x.key === k); if (!r) continue;
      acc[k].est += (r.raw || 0) * sc; acc[k].actual += codesOf[k].reduce((s, cd) => s + (act[cd] || 0), 0); acc[k].stores++;
    }
  }
  const rows = keys.filter((k) => acc[k].stores && acc[k].est > 0).map((k) => ({ ym, key: k, est: r0(acc[k].est), actual: r0(acc[k].actual), factor: Math.round((acc[k].actual / acc[k].est) * 1000) / 1000, stores: acc[k].stores }));
  if (rows.length) await supabase.from('live_calibration').upsert(rows, { onConflict: 'ym,key' });
  return { ym, rows };
}

async function latest(store, ym) {
  let q = supabase.from('live_reports').select('day, payload').eq('store_erpid', String(store)).order('day', { ascending: false }).limit(1);
  if (ym) q = q.eq('ym', ym);
  const { data } = await q;
  if (!data || !data[0]) return null;
  const p = data[0].payload;
  const { data: series } = await supabase.from('live_reports').select('day, payload->totals').eq('store_erpid', String(store)).eq('ym', p.ym).order('day');
  return { ...p, trend: (series || []).map((s) => ({ d: String(s.day).slice(0, 10), profit_proj: s.totals ? s.totals.profit_proj : null, profit_mtd: s.totals ? s.totals.profit_mtd : null })) };
}

module.exports = { settings, lensCosts, factors, runAll, buildStore, calibrate, latest, market, YM };
