// services/monthlyReport.js —— 門市月報 v1（2026-10-20，P1）
// 規劃：app/pet-feature/PLAN_門市月報與開帳_20261020.md
// 版型照「後甲月報」試算表：上方業績／實收、左＝營運支出、右＝費用支出（依廠商分列）、下＝盈餘與分紅。
// 數字一律從帳本 ledger_lines(ym) 來（開帳帳單、部門開帳、營運費用拆月、固定支出、固定金額、手填／調帳），
// 再加市場部內部 API 的 ERP 帳上業績（參考）與 ERP 門市費用單（分店支出雜項）。
const axios = require('axios');
const supabase = require('../config/supabase');

const YM = /^\d{4}-(0[1-9]|1[0-2])$/;

// 版面：左欄（營運支出）與右欄（費用支出，依廠商分列）用哪些大類
const LEFT_GROUPS = ['opex', 'planning', 'ads'];
const RIGHT_GROUPS = ['misc', 'frame', 'lens', 'contact'];
const GROUP_NAME = { opex: '營運支出', planning: '企劃品', ads: '廣告費', misc: '雜費', frame: '鏡框', lens: '鏡片', contact: '藥拋' };
// 不算進總支出、放在分紅區塊扣的
// 成本率目標（後甲月報下方那張表）
const RATIO_TARGET = { 人事: 23, 包裝: 10, 鏡片: 15, 鏡框: 12, 營運費用: 30, 藥拋: 90, 淨利: 30 };
const DIVIDEND_CODES = ['marketing_fund', 'depreciation'];
const SOURCE_NAME = {
  bill: '開帳單', billing_order: '部門開帳', opex: '營運費用', recurring: '固定支出', fixed: '固定金額',
  manual_value: '手填', manual_adjust: '調帳', erp_cost: 'ERP 費用單', aimin_expense: '愛民支出', planning_bill: '企劃部開帳', storehouse: '倉庫開帳', contract: '合約', basic: '基本資料', check: '支票', card_fee: '刷卡費率', lefthand_salary: '左手薪資',
};

const MARKET_BASE = process.env.MARKET_BACKEND_URL || 'https://market-backend-0544.onrender.com';

async function marketMonth(ym, stores) {
  const key = process.env.MARKET_INTERNAL_KEY;
  if (!key) return { error: '營運部沒設 MARKET_INTERNAL_KEY', stores: {} };
  try {
    const { data } = await axios.get(`${MARKET_BASE}/api/internal/report/store-month`, {
      params: { ym, stores: stores && stores.length ? stores.join(',') : undefined },
      headers: { 'x-internal-key': key }, timeout: 90000,
    });
    return { stores: data.stores || {}, cats: data.cost_cats || {}, errors: data.errors || [], end: data.end };
  } catch (e) {
    const msg = e.response ? `${e.response.status} ${JSON.stringify(e.response.data).slice(0, 120)}` : e.message;
    return { error: `市場部月資料：${msg}`, stores: {} };
  }
}

// ── 愛民（IMING 系統，Supabase suvsaycdiyvofzaudpkg）：眼鏡業績、收款、結帳、門市支出 ──
// 愛民門市（後甲、北屯、十甲、高應大…）的眼鏡不走 ERP；IMING 開了只讀函式 report_store_month(p_key, p_ym)
// 金鑰存在營運部 report_settings.aimin_report_key（IMING 只存 sha256）；門市對照 report_settings.aimin_store_map（IMING 門市 id → ERP 門市編號）
const AIMIN_URL = process.env.AIMIN_SUPABASE_URL || 'https://suvsaycdiyvofzaudpkg.supabase.co';
const AIMIN_PUB = process.env.AIMIN_PUBLISHABLE_KEY || 'sb_publishable_s9iUEJn9i5c0TB_ViJBtcg_izwVlnPH'; // 公開金鑰（前端也用），權限靠 p_key
const aiminCache = new Map();
async function aiminMonth(ym) {
  const hit = aiminCache.get(ym);
  if (hit && Date.now() - hit.at < 5 * 60e3) return hit.v;
  const { data: rows } = await supabase.from('report_settings').select('key, value').in('key', ['aimin_report_key', 'aimin_store_map']);
  const o = Object.fromEntries((rows || []).map((r) => [r.key, r.value]));
  if (!o.aimin_report_key) return { error: '營運部沒設愛民金鑰（report_settings.aimin_report_key）', byStore: {} };
  let v;
  try {
    const { data } = await axios.post(`${AIMIN_URL}/rest/v1/rpc/report_store_month`, { p_key: o.aimin_report_key, p_ym: ym },
      { headers: { apikey: AIMIN_PUB, 'Content-Type': 'application/json' }, timeout: 30000 });
    const map = o.aimin_store_map || {};
    const byStore = {};
    for (const st of (data && data.stores) || []) { const erp = map[st.id]; if (erp) byStore[String(erp)] = st; }
    v = { byStore };
  } catch (e) {
    const msg = e.response ? `${e.response.status} ${JSON.stringify(e.response.data).slice(0, 120)}` : e.message;
    return { error: `愛民系統月資料：${msg}`, byStore: {} };
  }
  aiminCache.set(ym, { at: Date.now(), v });
  return v;
}

// ── 企劃部開帳（業績系統 Supabase gyhmfbclljkgmqeqbbxh，2026-10-20）──
// 企劃部開帳時就選好門市（planning_expense_billing，每筆 → 對象＋成本分攤＋加成後開帳金額）；業績系統開了只讀函式
// report_planning_month(p_key, p_year, p_month)。金鑰 report_settings.planning_report_key（對方只存 sha256），
// 對象 → 門市 report_settings.planning_target_map（planning_bill_target.id → ERP 門市編號；部門不在表裡＝不進門市月報）。
// 只收「開帳時有選門市」的；舊的文字開帳（bill_target_text）與「二次開帳」（倉庫出貨時才開）不在這裡。
const PLAN_URL = process.env.PLANNING_SUPABASE_URL || 'https://gyhmfbclljkgmqeqbbxh.supabase.co';
const PLAN_PUB = process.env.PLANNING_PUBLISHABLE_KEY || 'sb_publishable_8suC8kak9B60yiyhdiAu2A_gtWx-gpA'; // 公開金鑰，權限靠 p_key
const planCache = new Map();
async function planningMonth(ym) {
  const hit = planCache.get(ym);
  if (hit && Date.now() - hit.at < 5 * 60e3) return hit.v;
  const { data: rows } = await supabase.from('report_settings').select('key, value').in('key', ['planning_report_key', 'planning_target_map']);
  const o = Object.fromEntries((rows || []).map((r) => [r.key, r.value]));
  if (!o.planning_report_key) return { error: '營運部沒設企劃部開帳金鑰（report_settings.planning_report_key）', byStore: {}, issues: [] };
  const [y, m] = ym.split('-').map(Number);
  let v;
  try {
    const { data } = await axios.post(`${PLAN_URL}/rest/v1/rpc/report_planning_month`, { p_key: o.planning_report_key, p_year: y, p_month: m },
      { headers: { apikey: PLAN_PUB, 'Content-Type': 'application/json' }, timeout: 30000 });
    const map = o.planning_target_map || {};
    const byStore = {}, issues = [], perExp = {};
    for (const l of (data && data.lines) || []) {
      const erp = map[String(l.target_id)];
      const e = (perExp[l.expense_id] = perExp[l.expense_id] || { item: l.item, serial: l.serial, cost_total: Number(l.cost_total) || 0, qty_total: Number(l.qty_total) || 0, cost: 0, qty: 0, lines: [] });
      e.cost += Number(l.cost_share) || 0; e.qty += Number(l.qty) || 0; e.lines.push(l);
      if (l.status !== '已開帳') continue;
      if (!erp) { if (l.category !== 'dept' && l.category !== 'planning') issues.push({ kind: 'unmapped', line: l }); continue; }
      (byStore[erp] = byStore[erp] || []).push(l);
      if (Number(l.qty) > 0 && !Number(l.sell_amount)) issues.push({ kind: 'zero', store: erp, line: l });
    }
    for (const [id, e] of Object.entries(perExp)) {
      if (e.cost_total && Math.abs(e.cost - e.cost_total) > 1) issues.push({ kind: 'cost_sum', expense_id: id, e });
      if (e.qty_total && e.qty && Math.abs(e.qty - e.qty_total) > 0.001) issues.push({ kind: 'qty_sum', expense_id: id, e });
    }
    v = { byStore, issues, unbilled: data ? data.unbilled : null };
  } catch (e) {
    const msg = e.response ? `${e.response.status} ${JSON.stringify(e.response.data).slice(0, 120)}` : e.message;
    return { error: `企劃部開帳：${msg}`, byStore: {}, issues: [] };
  }
  planCache.set(ym, { at: Date.now(), v });
  return v;
}

// ── 倉庫開帳（倉管部 storehouse，Supabase icomlbtatqujabxgylxj，2026-10-20）──
// 倉庫系統「開帳系統」兩種出貨：常備品撥補（supply_replen_log，送 ERP 調撥單時存；金額＝售價×數量）、
// 產品出貨（product_shipments，產品資料庫勾選出貨＝企劃部訂製常備品的「二次開帳」）。
// 對方開了只讀函式 report_storehouse_month(p_key, p_ym)，期間＝上月 26 日～本月 25 日（跟倉庫月報同）。
// 金鑰 report_settings.storehouse_report_key（對方只存 sha256）；門市是文字（「新竹」「文化中心」），
// 依 departments 名稱自動對（去掉「店」「愛民眼鏡」），對不到的用 report_settings.storehouse_store_map 補。
// 科目 report_settings.storehouse_ledger {replen, ship}，沒設＝都進企劃品 planning_goods（待會計確認）。
const SH_URL = process.env.STOREHOUSE_SUPABASE_URL || 'https://icomlbtatqujabxgylxj.supabase.co';
const SH_PUB = process.env.STOREHOUSE_PUBLISHABLE_KEY || 'sb_publishable_zqzDJEb3hpTvSkAqMnniew_BG99Sw6S'; // 公開金鑰，權限靠 p_key
const shCache = new Map();
const shNorm = (t) => String(t || '').replace(/^愛民眼鏡/, '').replace(/店$/, '').replace(/\s/g, '');
// 2026-10-20：會計可以依「撥補區塊」（店用商品／護理產品／配件組合…）或「出貨倉別」各自選月報格子：
// storehouse_ledger = { replen: 預設, ship: 預設, sections: { '<撥補區塊>': code }, warehouses: { '<出貨倉別>': code } }
// 一筆出貨裡不同區塊要進不同格子時照品項（數量×單價）拆開；拆完差額（四捨五入等）留在預設那格。
const SH_DEFAULT = 'planning_goods';
function shSplit(r, ledger) {
  const def = ledger[r.src] || SH_DEFAULT;
  const pick = r.src === 'ship' ? (ledger.warehouses || {}) : (ledger.sections || {});
  const keyOf = (i) => (r.src === 'ship' ? i.warehouse : i.section) || '';
  const items = r.items || [];
  const groups = {};
  for (const i of items) {
    const code = pick[keyOf(i)] || def;
    const g = (groups[code] = groups[code] || { amount: 0, items: [], keys: new Set() });
    g.amount += (Number(i.qty) || 0) * (Number(i.price) || 0);
    g.items.push(i); if (keyOf(i)) g.keys.add(keyOf(i));
  }
  const codes = Object.keys(groups);
  if (codes.length <= 1) return [{ ...r, ledger_code: codes[0] || def, part: codes.length ? [...groups[codes[0]].keys].join('、') : '' }];
  const total = Number(r.amount) || 0;
  let rest = total;
  const out = [];
  for (const c of codes.filter((x) => x !== def)) {
    const amt = Math.round(groups[c].amount);
    rest -= amt;
    out.push({ ...r, id: `${r.id}:${c}`, ledger_code: c, amount: amt, items: groups[c].items, part: [...groups[c].keys].join('、') });
  }
  out.push({ ...r, id: `${r.id}:${def}`, ledger_code: def, amount: rest, items: (groups[def] || { items: [] }).items, part: groups[def] ? [...groups[def].keys].join('、') : '' });
  return out.filter((l) => Number(l.amount) || (l.items || []).length);
}
function clearStorehouseCache() { shCache.clear(); }
async function storehouseMonth(ym) {
  const hit = shCache.get(ym);
  if (hit && Date.now() - hit.at < 5 * 60e3) return hit.v;
  const [{ data: rows }, { data: units }] = await Promise.all([
    supabase.from('report_settings').select('key, value').in('key', ['storehouse_report_key', 'storehouse_store_map', 'storehouse_ledger']),
    supabase.from('departments').select('store_erpid, store_name').eq('is_active', true),
  ]);
  const o = Object.fromEntries((rows || []).map((r) => [r.key, r.value]));
  if (!o.storehouse_report_key) return { error: '營運部沒設倉庫開帳金鑰（report_settings.storehouse_report_key）', byStore: {}, issues: [] };
  const byName = {};
  for (const u of units || []) if (u.store_erpid) byName[shNorm(u.store_name)] = String(u.store_erpid);
  const map = { ...byName, ...(o.storehouse_store_map || {}) };
  const ledger = { replen: SH_DEFAULT, ship: SH_DEFAULT, sections: {}, warehouses: {}, ...(o.storehouse_ledger || {}) };
  let v;
  try {
    const { data } = await axios.post(`${SH_URL}/rest/v1/rpc/report_storehouse_month`, { p_key: o.storehouse_report_key, p_ym: ym },
      { headers: { apikey: SH_PUB, 'Content-Type': 'application/json' }, timeout: 30000 });
    const byStore = {}, issues = [];
    for (const r of (data && data.rows) || []) {
      const erp = map[r.store] || map[shNorm(r.store)];
      const lines = shSplit(r, ledger);
      if (!erp) { for (const line of lines) issues.push({ kind: 'unmapped', line }); continue; }
      (byStore[erp] = byStore[erp] || []).push(...lines);
      if (Number(r.qty) > 0 && !Number(r.amount)) issues.push({ kind: 'zero', store: erp, line: lines[0] });
    }
    v = { byStore, issues, from: data && data.from, to: data && data.to };
  } catch (e) {
    const msg = e.response ? `${e.response.status} ${JSON.stringify(e.response.data).slice(0, 120)}` : e.message;
    return { error: `倉庫開帳：${msg}`, byStore: {}, issues: [] };
  }
  shCache.set(ym, { at: Date.now(), v });
  return v;
}

// ── 房租從合約來（2026-10-20 營運定案：月報用合約總額＝含扣繳；有「實際」與「報稅」兩份時用實際那份）──
// contracts.type=rent、store_erpid、status 不是 archived；金額照 type_data.rent_schedule 分段，跨月照天數拆

// 基本資料「房租」（entity_facts，營運部「基本資料」頁維護；26 家都有）：合約租金／實付租金／月報應列金額／租賃稅／二代健保
// 月報：有房租合約用合約；沒有合約才用這裡的「合約租金」（沒填用「實付租金」）當暫代，查帳提醒會標「還沒有合約」
let basicsCache = { at: 0, v: null };
async function rentBasics() {
  if (basicsCache.v && Date.now() - basicsCache.at < 5 * 60e3) return basicsCache.v;
  const { data: cats } = await supabase.from('entity_fact_categories').select('id, name').eq('name', '房租');
  const ids = (cats || []).map((c) => c.id);
  const { data } = ids.length ? await supabase.from('entity_facts').select('store_erpid, store_name, data, updated_at').in('category_id', ids) : { data: [] };
  const num = (v) => { const n = Number(String(v == null ? '' : v).replace(/,/g, '')); return Number.isFinite(n) && String(v).trim() !== '' ? n : null; };
  const v = {};
  for (const r of data || []) {
    if (!r.store_erpid) continue;
    const d = r.data || {};
    v[String(r.store_erpid)] = { contract_rent: num(d.contract_rent), actual_rent: num(d.actual_rent), report_amount: num(d.report_amount),
      rent_tax: num(d.rent_tax), health_insurance: num(d.health_insurance), optical_rent: num(d.optical_rent), check_amount: d.check_amount || null, note: d.note || null, updated_at: r.updated_at };
  }
  basicsCache = { at: Date.now(), v };
  return v;
}

async function rentContracts() {
  const { data } = await supabase.from('contracts').select('id, name, store_erpid, purpose, status, start_date, end_date, monthly_amount, type_data, party_name')
    .eq('type', 'rent').not('store_erpid', 'is', null).neq('status', 'archived');
  return data || [];
}
// ── 房租支票（既有「支票紀錄」系統，2026-10-20）：check_subjects.store_erpid（「房租／中清」→ 中清店）或 check_batches.contract_id
// 當月票面到期的支票＝這個月實付（作廢不算、退票另列）；10 分鐘快取
const checkCache = new Map();
async function rentChecks(ym) {
  const hit = checkCache.get(ym);
  if (hit && Date.now() - hit.at < 10 * 60e3) return hit.data;
  const [y, m] = ym.split('-').map(Number);
  const end = `${ym}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`;
  const { data, error } = await supabase.from('checks')
    .select('id, check_no, amount, due_date, status, paid_at, batch_id, check_batches!inner(id, batch_no, drawer_name, contract_id, subject_id, check_subjects!inner(name, store_erpid, parent_id))')
    .gte('due_date', `${ym}-01`).lte('due_date', end).neq('status', 'voided');
  const byStore = {};
  if (error) { const r = { byStore, error: `支票紀錄讀取失敗：${error.message}` }; return r; }
  let cmap = null;
  for (const c of data || []) {
    const b = c.check_batches || {}, sj = b.check_subjects || {};
    let store = sj.store_erpid || null;
    if (!store && b.contract_id) {
      if (!cmap) { const { data: cs } = await supabase.from('contracts').select('id, store_erpid'); cmap = new Map((cs || []).map((x) => [x.id, x.store_erpid])); }
      store = cmap.get(b.contract_id) || null;
    }
    if (!store) continue;
    (byStore[store] = byStore[store] || []).push({ id: c.id, check_no: c.check_no, amount: Number(c.amount) || 0, due_date: c.due_date, status: c.status,
      subject: sj.name, drawer: b.drawer_name, batch_no: b.batch_no, contract_id: b.contract_id || null });
  }
  const out = { byStore };
  checkCache.set(ym, { at: Date.now(), data: out });
  return out;
}

function rentForMonth(c, ym) {
  const [y, m] = ym.split('-').map(Number);
  const dim = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const sched = (((c.type_data || {}).rent_schedule) || []).filter((x) => x && x.from_date).sort((a, b) => String(a.from_date).localeCompare(String(b.from_date)));
  let total = 0, days = 0;
  for (let d = 1; d <= dim; d++) {
    const ds = `${ym}-${String(d).padStart(2, '0')}`;
    if ((c.start_date && ds < c.start_date) || (c.end_date && ds > c.end_date)) continue;
    let amt = Number(c.monthly_amount) || 0;
    for (const sg of sched) if (sg.from_date <= ds) amt = Number(sg.monthly_amount) || 0;
    total += amt / dim; days += 1;
  }
  return { amount: Math.round(total), days, dim };
}

// ── 帳上業績（業績系統 report_sales_month，2026-10-20 營運定案）──
// 總業績＝ERP 開單日（台北）實收金額合計（含退貨）；隱眼業績＝物料「隐形眼镜」＋「护理产品」（物料自動帶，比人工選標籤準）；
// 眼鏡業績＝總業績 − API PAY（ERP 現金流 payway 140，市場部 cashflow.apipay）− 隱眼業績。金鑰同企劃部開帳 planning_report_key。
const salesCache = new Map();
async function salesMonth(ym) {
  const hit = salesCache.get(ym);
  if (hit && Date.now() - hit.at < 10 * 60e3) return hit.v;
  const { data: row } = await supabase.from('report_settings').select('value').eq('key', 'planning_report_key').maybeSingle();
  if (!row || !row.value) return { error: '營運部沒設業績系統金鑰（report_settings.planning_report_key）', stores: {} };
  try {
    const { data } = await axios.post(`${PLAN_URL}/rest/v1/rpc/report_sales_month`, { p_key: row.value, p_ym: ym },
      { headers: { apikey: PLAN_PUB, 'Content-Type': 'application/json' }, timeout: 60000 });
    const v = { stores: (data && data.stores) || {}, synced_max: data && data.synced_max };
    salesCache.set(ym, { at: Date.now(), v });
    return v;
  } catch (e) {
    const msg = e.response ? `${e.response.status} ${JSON.stringify(e.response.data).slice(0, 120)}` : e.message;
    return { error: `帳上業績（業績系統）：${msg}`, stores: {} };
  }
}

const splitTitle = (t) => { const s = String(t || ''); const i = s.indexOf('｜'); return i < 0 ? [s, ''] : [s.slice(0, i), s.slice(i + 1)]; };
const r0 = (n) => Math.round(Number(n) || 0);
const monthsBetween = (a, b) => { const [y1, m1] = a.split('-').map(Number); const [y2, m2] = b.split('-').map(Number); return (y2 - y1) * 12 + (m2 - m1) + 1; };

async function settings() {
  const { data } = await supabase.from('report_settings').select('key, value');
  const o = Object.fromEntries((data || []).map((r) => [r.key, r.value]));
  return { cutoff_day: Number(o.cutoff_day) || 26, retained_rate: o.retained_rate == null ? 0.1 : Number(o.retained_rate),
    gap_alert_pct: o.gap_alert_pct == null ? 10 : Number(o.gap_alert_pct),
    card_fee_rates: o.card_fee_rates && typeof o.card_fee_rates === 'object' ? o.card_fee_rates : {} };
}

async function accounts() {
  const { data, error } = await supabase.from('ledger_accounts').select('*').eq('is_active', true).order('sort_order');
  if (error) throw error;
  return data || [];
}

/**
 * 算一家店一個月的月報
 * @returns {object} { ym, store, revenue, left, right, totals, dividend, shareholders, warnings, report }
 */
async function build(ym, store, opts = {}) {
  if (!YM.test(ym)) throw new Error('ym 要是 YYYY-MM');
  store = String(store || '');
  if (!store) throw new Error('缺門市');
  const [accs, st, linesR, mkt, aimin, rep, fixed, holders, dept, plan, sh, rcs, rbs, smo, chk, sal] = await Promise.all([
    accounts(),
    settings(),
    supabase.rpc('ledger_lines', { p_ym: ym }).eq('store_erpid', store),
    opts.market || marketMonth(ym, [store]),
    opts.aimin || aiminMonth(ym),
    supabase.from('store_month_reports').select('*').eq('store_erpid', store).eq('ym', ym).maybeSingle(),
    supabase.from('store_fixed_items').select('*').eq('store_erpid', store),
    supabase.from('store_shareholders').select('*').eq('store_erpid', store),
    supabase.from('departments').select('store_erpid, store_name').eq('store_erpid', store).maybeSingle(),
    opts.planning || planningMonth(ym),
    opts.storehouse || storehouseMonth(ym),
    opts.contracts || rentContracts(),
    rentBasics(),
    opts.sales || salesMonth(ym),
    opts.checks || rentChecks(ym),
    opts.salary || require('./salaryMonth').salaryMonth(ym),
  ]);
  if (linesR.error) throw linesR.error;
  const lines = linesR.data || [];
  const byCode = {};
  for (const l of lines) (byCode[l.ledger_code] = byCode[l.ledger_code] || []).push(l);
  const warnings = [];
  if (mkt.error) warnings.push(mkt.error);
  (mkt.errors || []).forEach((e) => warnings.push(e));
  const m = (mkt.stores || {})[store] || {};
  const am = (aimin.byStore || {})[store] || null;   // 愛民門市才有
  if (aimin.error && am === null && /愛民|後甲|北屯|十甲/.test((dept.data && dept.data.store_name) || '')) warnings.push(aimin.error);

  // ERP 門市費用單 → 分店支出雜項（有手填值就以手填為準）
  if (!(byCode.store_misc || []).some((l) => l.source === 'manual_value') && m.costs) {
    // 結帳資料（2026-10-21）：門市有寄出過本月結帳資料 → 只算會計核對通過的費用單；還沒走新流程的月份照舊全算
    const useVerified = ['submitted', 'reviewing', 'approved', 'returned'].includes(m.costs.closing_status);
    const src = useVerified ? m.costs.items.filter((x) => x.receipt_status === 'approved') : m.costs.items;
    if (useVerified && m.costs.pending_count > 0) warnings.push(`分店支出雜項：${m.costs.pending_count} 筆費用單憑證還沒核對通過，先不算進來（結帳資料頁核對）`);
    byCode.store_misc = (byCode.store_misc || []).concat(src.map((x) => ({
      store_erpid: store, ledger_code: 'store_misc', amount: x.amount, fee_ym: ym, source: 'erp_cost',
      ref_id: String(x.pay_id), ref_title: `ERP 費用單｜${x.date ? String(x.date).slice(0, 10) : ''} ${x.remark || ''}`.trim(),
      receipt_photos: x.receipt_photos || [], receipt_status: x.receipt_status || 'none', receipt_reviewed_by: x.receipt_reviewed_by || null,
    })));
  } else if (!m.costs && !am) warnings.push('分店支出雜項：這次拿不到 ERP 門市費用單');
  // 愛民門市的門市支出記在 IMING expenses（後甲 8 月 1,797＝試算表）
  if (am && !(byCode.store_misc || []).some((l) => l.source === 'manual_value')) {
    byCode.store_misc = (byCode.store_misc || []).concat((am.expenses || []).map((x) => ({
      store_erpid: store, ledger_code: 'store_misc', amount: Number(x.amount) || 0, fee_ym: ym, source: 'aimin_expense',
      ref_id: String(x.id), ref_title: `愛民支出｜${x.date ? String(x.date).slice(0, 10) : ''} ${x.category || ''} ${x.note || ''}`.trim(),
    })));
  }

  // 企劃部開帳（開帳時選好門市的）→ 企劃品；有手填值就以手填為準
  if (plan.error) warnings.push(plan.error);
  const pl = (plan.byStore || {})[store] || [];
  if (pl.length && !(byCode.planning_goods || []).some((l) => l.source === 'manual_value')) {
    byCode.planning_goods = (byCode.planning_goods || []).concat(pl.map((l) => ({
      store_erpid: store, ledger_code: 'planning_goods', amount: Number(l.sell_amount) || 0, fee_ym: ym, source: 'planning_bill',
      ref_id: `pe-${l.expense_id}-${l.billing_id}`,
      ref_title: `${l.vendor || '企劃部'}｜${l.serial || ''} ${l.item || ''}（數量 ${l.qty ?? '—'}、成本 ${r0(l.cost_share)} × ${l.markup_rate}）${l.is_settled ? '' : '［企劃部還沒月結］'}`,
    })));
  }
  // 房租：有合約就用合約（實際那份優先），固定支出的付款改當「實付」參考；沒有合約照舊用固定支出
  const myRc = (rcs || []).filter((c) => String(c.store_erpid) === store);
  const useRc = myRc.some((c) => c.purpose === 'actual') ? myRc.filter((c) => c.purpose === 'actual') : myRc;
  let rentInfo = { contracts: [], paid: null, only_tax: false };
  if (useRc.length && !(byCode.rent || []).some((l) => l.source === 'manual_value')) {
    const paidLines = (byCode.rent || []).filter((l) => l.source === 'recurring');
    const rest = (byCode.rent || []).filter((l) => l.source !== 'recurring');
    const cl = [];
    for (const c of useRc) {
      const r = rentForMonth(c, ym);
      rentInfo.contracts.push({ id: c.id, name: c.name, purpose: c.purpose, amount: r.amount, days: r.days, end_date: c.end_date, party: c.party_name });
      if (!r.days) continue;
      cl.push({ store_erpid: store, ledger_code: 'rent', amount: r.amount, fee_ym: ym, source: 'contract', ref_id: `ct-${c.id}`,
        ref_title: `${c.party_name || '房東'}｜合約「${c.name}」${r.days < r.dim ? `（本月 ${r.days}/${r.dim} 天）` : ''}${c.purpose === 'tax' ? '［只有報稅版合約］' : ''}` });
    }
    rentInfo.paid = paidLines.length ? Math.round(paidLines.reduce((a, l) => a + Number(l.amount || 0), 0)) : null;
    rentInfo.only_tax = useRc.every((c) => c.purpose === 'tax');
    byCode.rent = rest.concat(cl);
  }
  // 沒有合約：用基本資料的房租暫代（合約租金→沒填用實付租金），固定支出付款照樣當實付參考
  const rb = (rbs || {})[store] || null;
  rentInfo.basic = rb;
  if (!useRc.length && rb && (rb.contract_rent || rb.actual_rent) && !(byCode.rent || []).some((l) => l.source === 'manual_value')) {
    const paidLines = (byCode.rent || []).filter((l) => l.source === 'recurring');
    rentInfo.paid = paidLines.length ? Math.round(paidLines.reduce((a, l) => a + Number(l.amount || 0), 0)) : null;
    const amt = rb.contract_rent || rb.actual_rent;
    byCode.rent = (byCode.rent || []).filter((l) => l.source !== 'recurring').concat([{ store_erpid: store, ledger_code: 'rent', amount: amt, fee_ym: ym, source: 'basic',
      ref_id: `basic-rent-${store}`, ref_title: `基本資料｜${rb.contract_rent ? '合約租金' : '實付租金'}（還沒有房租合約，暫用基本資料）` }]);
    rentInfo.from_basic = amt;
  }
  // 房租支票（既有支票紀錄）：算進實付；退票另列。既沒合約、沒基本資料、固定支出也沒有房租時，才拿支票當房租金額
  if (chk && chk.error) warnings.push(chk.error);
  const myChecks = ((chk && chk.byStore) || {})[store] || [];
  rentInfo.checks = myChecks;
  if (myChecks.length) {
    const ok = myChecks.filter((c) => c.status !== 'bounced');
    const sumC = Math.round(ok.reduce((a, c) => a + c.amount, 0));
    rentInfo.paid = (rentInfo.paid || 0) + sumC;
    rentInfo.paid_checks = sumC;
    rentInfo.bounced = myChecks.filter((c) => c.status === 'bounced').map((c) => ({ check_no: c.check_no, amount: c.amount, due_date: c.due_date }));
    if (!useRc.length && !rentInfo.from_basic && !(byCode.rent || []).length && sumC) {
      byCode.rent = ok.map((c) => ({ store_erpid: store, ledger_code: 'rent', amount: c.amount, fee_ym: ym, source: 'check', ref_id: `chk-${c.id}`,
        ref_title: `支票 ${c.check_no || ''}｜房租／${c.subject}｜到期 ${c.due_date}（沒有合約，暫用支票金額）` }));
      rentInfo.from_checks = sumC;
    }
  }
  // 倉庫開帳（常備品撥補＋產品出貨）→ 科目照 storehouse_ledger；那一格有手填值就以手填為準
  if (sh.error) warnings.push(sh.error);
  for (const l of (sh.byStore || {})[store] || []) {
    const code = l.ledger_code;
    if ((byCode[code] || []).some((x) => x.source === 'manual_value')) continue;
    const what = (l.src === 'ship' ? `產品出貨 ${l.no || ''}` : '常備品撥補') + (l.part ? `（${l.part}）` : '');
    const items = (l.items || []).slice(0, 4).map((i) => `${i.name}×${i.qty}`).join('、') + ((l.items || []).length > 4 ? '…' : '');
    (byCode[code] = byCode[code] || []).push({
      store_erpid: store, ledger_code: code, amount: Number(l.amount) || 0, fee_ym: ym, source: 'storehouse',
      ref_id: `sh-${l.src}-${l.id}`,
      ref_title: `倉庫｜${l.date} ${what}：${items}${l.src === 'ship' && l.cost ? `（總部成本 ${r0(l.cost)}）` : ''}${l.stamped ? '［倉庫已標開帳］' : ''}`,
    });
  }
  const planIssues = (plan.issues || []).filter((i) => i.store === store || (i.e && i.e.lines.some((l) => ((plan.byStore || {})[store] || []).some((x) => x.expense_id === l.expense_id))));

  const rowOf = (a) => {
    const ls = byCode[a.code] || [];
    const amount = ls.reduce((s, l) => s + Number(l.amount || 0), 0);
    const sources = [...new Set(ls.map((l) => l.source))];
    const vendors = {};
    for (const l of ls) {
      let [v] = splitTitle(l.ref_title);
      if (['opex', 'recurring', 'erp_cost', 'aimin_expense', 'billing_order'].includes(l.source)) v = '';
      if (l.source === 'planning_bill') v = '企劃部';
      if (l.source === 'storehouse') v = '倉庫';
      if (l.source === 'contract') v = splitTitle(l.ref_title)[0];
      vendors[v] = (vendors[v] || 0) + Number(l.amount || 0);
    }
    const crossMonth = ls.filter((l) => l.fee_ym && l.fee_ym !== ym).map((l) => l.fee_ym);
    return {
      code: a.code, name: a.name, group: a.group_code, ratio_group: a.ratio_group,
      amount: r0(amount), has_data: ls.length > 0, sources: sources.map((s) => SOURCE_NAME[s] || s),
      adjust_count: ls.filter((l) => l.source === 'manual_adjust').length,
      fee_months: [...new Set(crossMonth)].sort(),
      vendors: Object.entries(vendors).filter(([k]) => k).map(([k, v]) => ({ vendor: k, amount: r0(v) })),
      lines: opts.withLines ? ls.map((l) => ({ ...l, source_name: SOURCE_NAME[l.source] || l.source })) : undefined,
    };
  };

  const acc = Object.fromEntries(accs.map((a) => [a.code, a]));
  const val = (code) => (byCode[code] || []).reduce((s, l) => s + Number(l.amount || 0), 0);
  const filled = (code) => (byCode[code] || []).length > 0;

  // ── 業績／實收 ──
  const erp = m.sales || null;
  // 參考值：ERP 帳上（業績系統）＋愛民系統（IMING 訂單／收款）；愛民門市的眼鏡主要在 IMING
  const aSales = am ? Number(am.sales) || 0 : null;
  const aPaid = am ? Number(am.paid) || 0 : null;
  const plus = (a, b) => (a == null && b == null ? null : r0((a || 0) + (b || 0)));
  // 業績＝系統帶入（ERP＋愛民系統），有手填「改成」就用手填、有「調帳」就加上去；實收＝會計手填
  const sysOr = (code, sys) => {
    const ls = byCode[code] || [];
    if (ls.some((l) => l.source === 'manual_value')) return { amount: r0(val(code)), from: 'manual' };
    const adj = ls.filter((l) => l.source === 'manual_adjust').reduce((s, l) => s + Number(l.amount || 0), 0);
    if (sys == null) return { amount: ls.length ? r0(adj) : null, from: ls.length ? 'manual' : 'none' };
    return { amount: r0(sys + adj), from: adj ? 'system_adjusted' : 'system' };
  };
  // 新口徑（營運 10-20）：業績系統拿不到才退回舊的標籤口徑
  const so = (smo && smo.stores || {})[store] || null;
  const cf = m.cashflow || null;
  const apiSys = cf ? r0(cf.apipay) : null;
  let erpGlasses = erp ? erp.glasses : null, cSys = erp ? r0(erp.contact) : null, salesBasis = 'label';
  if (so) {
    cSys = r0((Number(so.contact_lens) || 0) + (Number(so.care) || 0));
    erpGlasses = r0((Number(so.total) || 0) - (apiSys || 0) - cSys);
    salesBasis = 'material';
    if (apiSys == null) warnings.push('拿不到 ERP 現金流的 API PAY，眼鏡業績（帳上）先沒扣 API PAY');
  } else if (smo && smo.error) warnings.push(`${smo.error}；業績暫用舊口徑（訂單標籤）`);
  // ── 刷卡手續費（2026-10-20）：ERP 現金流依付款方式 × 費率（report_settings.card_fee_rates：{ 付款方式代碼: {name, rate(%), per_txn(每筆元)} }）
  //    那一格有手填值就以手填為準；有金額但沒設費率的付款方式 → 提醒（設 0 就不再提醒）
  const cardFee = { lines: [], unset: [] };
  if (cf && Array.isArray(cf.by) && !(byCode.card_fee || []).some((l) => l.source === 'manual_value')) {
    const rates = st.card_fee_rates || {};
    for (const x of cf.by) {
      if (!x.amount) continue;
      const r = rates[String(x.code)];
      if (!r) { cardFee.unset.push({ code: x.code, name: x.name, amount: x.amount }); continue; }
      const fee = Math.round(((Number(x.amount) || 0) * (Number(r.rate) || 0)) / 100 + (Number(x.n) || 0) * (Number(r.per_txn) || 0));
      if (!fee) continue;
      cardFee.lines.push({ store_erpid: store, ledger_code: 'card_fee', amount: fee, fee_ym: ym, source: 'card_fee', ref_id: `cf-${x.code}`,
        ref_title: `${r.name || x.name}｜${Number(x.amount).toLocaleString()} 元 × ${Number(r.rate) || 0}%${r.per_txn ? `＋${x.n} 筆 × ${r.per_txn}` : ''}` });
    }
    byCode.card_fee = (byCode.card_fee || []).filter((l) => l.source !== 'card_fee').concat(cardFee.lines);
    if (cardFee.unset.length) warnings.push(`刷卡手續費：${cardFee.unset.map((u) => `${u.name}（${Number(u.amount).toLocaleString()}）`).join('、')} 還沒設費率`);
  }
  // ── 薪資（2026-10-20）：左手 hrm 薪資明細，依算薪門市加總；手填值優先。勞健保（公司負擔）、二代健保左手沒有 → 手填
  const salaryInfo = sal && sal.byStore ? sal.byStore[store] || null : null;
  if (sal && sal.error) warnings.push(sal.error);
  if (salaryInfo && !(byCode.salary || []).some((l) => l.source === 'manual_value')) {
    byCode.salary = (byCode.salary || []).filter((l) => l.source !== 'lefthand_salary').concat([{ store_erpid: store, ledger_code: 'salary', amount: salaryInfo.gross, fee_ym: ym,
      source: 'lefthand_salary', ref_id: `sal-${ym}`, ref_title: `左手薪資｜${salaryInfo.people} 人：實發 ${salaryInfo.net.toLocaleString()}＋員工自付健保 ${salaryInfo.emp_health.toLocaleString()}` }]);
  } else if (sal && !sal.error && !salaryInfo && !(byCode.salary || []).length) {
    warnings.push('左手這個月還沒有這家店的薪資（還沒算薪，或門市名稱對不上）');
  }
  const gSys = plus(erpGlasses, aSales);
  const gS = sysOr('glasses_sales', gSys);
  const cS = sysOr('contact_sales', cSys);
  const revenue = {
    glasses_sales: { name: '眼鏡業績（帳上）', kind: 'sales', amount: gS.amount, from: gS.from, erp: gSys, basis: salesBasis,
      refs: [so ? { label: `ERP 總業績 ${r0(so.total).toLocaleString()} − API PAY ${apiSys == null ? '?' : apiSys.toLocaleString()} − 隱眼 ${cSys.toLocaleString()}`, amount: r0(erpGlasses) } : (erp ? { label: 'ERP 帳上（標籤）', amount: r0(erp.glasses) } : null),
        am ? { label: '愛民系統訂單', amount: r0(aSales) } : null].filter(Boolean) },
    contact_sales: { name: '隱眼業績（帳上）', kind: 'sales', amount: cS.amount, from: cS.from, erp: cSys, basis: salesBasis,
      refs: so ? [{ label: '隱形眼鏡物料', amount: r0(so.contact_lens) }, { label: '護理產品物料', amount: r0(so.care) }] : (erp ? [{ label: 'ERP 帳上（標籤）', amount: cSys }] : []) },
    glasses_receipt: { name: '眼鏡真實實收', kind: 'receipt', amount: filled('glasses_receipt') ? r0(val('glasses_receipt')) : null, from: 'manual', erp: plus(erp ? erp.glasses : null, aPaid),
      refs: [erp ? { label: 'ERP 帳上', amount: r0(erp.glasses) } : null, am ? { label: '愛民系統收款', amount: r0(aPaid) } : null].filter(Boolean) },
    contact_receipt: { name: '隱眼真實實收', kind: 'receipt', amount: filled('contact_receipt') ? r0(val('contact_receipt')) : null, from: 'manual', erp: cSys,
      refs: erp ? [{ label: 'ERP 帳上', amount: cSys }] : [] },
    api_pay: { name: 'API 支付（儲值金消費）', kind: 'other', amount: filled('api_pay') ? r0(val('api_pay')) : apiSys, from: filled('api_pay') ? 'manual' : (apiSys == null ? 'none' : 'system'), erp: apiSys,
      refs: cf ? [{ label: 'ERP 現金流 apiPay', amount: apiSys }, { label: 'ERP 現金流合計（帳上實收）', amount: r0(cf.total) }] : [] },
    stored_value: { name: '儲值收款（不列業績）', kind: 'other', amount: filled('stored_value') ? r0(val('stored_value')) : null, from: 'manual', erp: null, no_source: true },
  };
  // 會計自訂的收入科目（2026-10-20）：kind=revenue、不是內建那三個 → 手填，算進獲利用的實收
  const FIXED_REV = ['glasses_receipt', 'contact_receipt', 'api_pay'];
  let extraIn = 0;
  for (const a of accs.filter((x) => x.kind === 'revenue' && !FIXED_REV.includes(x.code))) {
    const amt = filled(a.code) ? r0(val(a.code)) : null;
    revenue[a.code] = { name: a.name, kind: 'other', amount: amt, from: 'manual', erp: null, custom: true };
    extraIn += amt || 0;
  }
  if (gS.amount == null) warnings.push('眼鏡業績系統拿不到（ERP／愛民系統都沒資料）');
  ['glasses_receipt', 'contact_receipt'].forEach((k) => { if (revenue[k].amount == null) warnings.push(`${revenue[k].name}還沒填（參考 ${revenue[k].erp == null ? '—' : revenue[k].erp.toLocaleString()}）`); });
  const glassesIn = revenue.glasses_receipt.amount || 0;
  const contactIn = revenue.contact_receipt.amount || 0;
  const apiIn = revenue.api_pay.amount || 0;
  const totalIn = glassesIn + contactIn + apiIn + extraIn;   // 算獲利用（含 API 支付、自訂收入）

  // 總業績、總實收（眼鏡＋藥拋）與實收差：會計確認收到的錢 vs 帳上業績；差到 gap_alert_pct（預設 10%）要特別關注
  const salesTotal = gS.amount == null && cS.amount == null ? null : r0((gS.amount || 0) + (cS.amount || 0));
  const receiptFilled = revenue.glasses_receipt.amount != null && revenue.contact_receipt.amount != null;
  const receiptTotal = revenue.glasses_receipt.amount == null && revenue.contact_receipt.amount == null ? null : r0(glassesIn + contactIn);
  const gapOf = (label, sales, receipt) => {
    if (sales == null || receipt == null) return { label, sales, receipt, diff: null, pct: null, alert: false };
    const diff = r0(receipt - sales);
    const pct = sales ? Math.round((diff / sales) * 1000) / 10 : null;
    return { label, sales, receipt, diff, pct, alert: pct != null && Math.abs(pct) >= st.gap_alert_pct };
  };
  const gap = {
    alert_pct: st.gap_alert_pct,
    glasses: gapOf('眼鏡', gS.amount, revenue.glasses_receipt.amount),
    contact: gapOf('藥拋', cS.amount, revenue.contact_receipt.amount),
    total: gapOf('合計', salesTotal, receiptFilled ? receiptTotal : null),
  };
  ['glasses', 'contact', 'total'].forEach((k) => { const g = gap[k]; if (g.alert) warnings.push(`${g.label}實收差 ${g.pct > 0 ? '+' : ''}${g.pct}%（實收 ${g.receipt.toLocaleString()}／業績 ${g.sales.toLocaleString()}），超過 ${st.gap_alert_pct}%`); });

  // ── 支出 ──
  const section = (groups) => groups.map((g) => {
    const rows = accs.filter((a) => a.group_code === g && a.kind === 'expense' && !DIVIDEND_CODES.includes(a.code))
      .map(rowOf).filter((r) => r.has_data || acc[r.code].auto_source !== 'manual' || opts.allRows);
    return { group: g, name: GROUP_NAME[g], rows, total: rows.reduce((s, r) => s + r.amount, 0) };
  });
  const left = section(LEFT_GROUPS);
  const right = section(RIGHT_GROUPS);
  const leftTotal = left.reduce((s, g) => s + g.total, 0);
  const rightTotal = right.reduce((s, g) => s + g.total, 0);
  const totalOut = leftTotal + rightTotal;
  const contactOut = (right.find((g) => g.group === 'contact') || { total: 0 }).total;
  const glassesOut = totalOut - contactOut;
  const profit = totalIn - totalOut;

  // ── 分紅區塊 ──
  const fixedRows = (fixed.data || []);
  const fixedThis = (code) => fixedRows.filter((f) => f.ledger_code === code && f.from_ym <= ym && (!f.to_ym || f.to_ym >= ym)).reduce((s, f) => s + Number(f.amount), 0);
  const fixedCum = (code) => fixedRows.filter((f) => f.ledger_code === code && f.from_ym <= ym)
    .reduce((s, f) => s + Number(f.amount) * monthsBetween(f.from_ym, f.to_ym && f.to_ym < ym ? f.to_ym : ym), 0);
  const marketing = r0(val('marketing_fund'));
  const depr = r0(val('depreciation'));
  const report = rep.data || null;
  const retainedAuto = profit > 0 ? r0(profit * st.retained_rate) : 0;
  const retained = report && report.retained_amount != null ? r0(report.retained_amount) : retainedAuto;
  const distributable = profit - marketing - depr - retained;
  const hs = (holders.data || []).filter((h) => h.from_ym <= ym && (!h.to_ym || h.to_ym >= ym));
  const shares = hs.reduce((s, h) => s + h.shares, 0);
  if (shares > 100) warnings.push(`股東股數合計 ${shares}，超過 100`);
  const [y, mo] = ym.split('-').map(Number);

  return {
    ym, store, store_name: dept.data ? dept.data.store_name : null,
    status: report ? report.status : 'draft', report,
    revenue,
    totals: {
      glasses_in: glassesIn, contact_in: contactIn, api_in: apiIn, extra_in: extraIn, total_in: totalIn,
      sales_total: salesTotal, receipt_total: receiptTotal, receipt_filled: receiptFilled,
      left_total: leftTotal, right_total: rightTotal, total_out: totalOut,
      glasses_out: glassesOut, contact_out: contactOut,
      glasses_profit: glassesIn - glassesOut, contact_profit: contactIn + apiIn - contactOut, profit,
      // 成本率：藥拋 ÷ 藥拋實收（含 API 支付），其他 ÷ 總實收；淨利率＝盈餘 ÷ 總實收
      ratio: (() => {
        const sum = [...left, ...right].flatMap((g) => g.rows).reduce((o, r) => { if (r.ratio_group) o[r.ratio_group] = (o[r.ratio_group] || 0) + r.amount; return o; }, {});
        const pct = (v, base) => (base ? Math.round((v / base) * 1000) / 10 : null);
        const o = Object.fromEntries(Object.entries(sum).map(([k, v]) => [k, pct(v, k === '藥拋' ? contactIn + apiIn : totalIn)]));
        o['淨利'] = pct(profit, totalIn);
        return o;
      })(),
    },
    gap,
    ratio_target: RATIO_TARGET,
    left, right,
    dividend: {
      marketing_fund: marketing, marketing_fund_cum: r0(fixedCum('marketing_fund')),
      depreciation: depr, depreciation_cum: r0(fixedCum('depreciation')),
      retained, retained_auto: retainedAuto, retained_rate: st.retained_rate, retained_set: !!(report && report.retained_amount != null),
      distributable, total_shares: shares,
      cash_month: mo % 2 === 1, // 奇數月發現金（上月＋本月）
      cash_label: mo % 2 === 1 ? `現金分紅（${mo === 1 ? 12 : mo - 1}–${mo} 月）` : null,
      fixed_this: { marketing_fund: fixedThis('marketing_fund'), depreciation: fixedThis('depreciation') },
    },
    shareholders: hs.map((h) => ({ id: h.id, name: h.name, erpid: h.erpid, shares: h.shares, amount: r0(distributable * h.shares / 100) })),
    rent: rentInfo,
    card_fee: cardFee, salary: salaryInfo,
    storehouse_issues: (sh.issues || []).filter((i) => i.store === store).map((i) => ({ kind: i.kind, line: i.line })),
    planning_issues: planIssues.map((i) => ({ kind: i.kind, expense_id: i.expense_id || (i.line && i.line.expense_id), item: (i.e && i.e.item) || (i.line && i.line.item), detail: i })),
    aimin: am ? { name: am.name, sales: r0(am.sales), orders: am.order_count, paid: r0(am.paid), paid_by_method: am.paid_by_method, closings: am.closings } : null,
    warnings, settings: st, market_end: mkt.end || null, year: y,
  };
}

/** 全部門市一覽（每店一列：實收、總支出、盈餘） */
async function overview(ym) {
  if (!YM.test(ym)) throw new Error('ym 要是 YYYY-MM');
  // 只出「門市」：departments.report_kind＝store（migration 020；NULL＝名稱「…店」當門市）
  const { data: units } = await supabase.from('departments').select('store_erpid, store_name, is_active, report_kind').eq('is_active', true).order('store_name');
  const isStore = (u) => u.report_kind === 'store' || (u.report_kind == null && /店$/.test(String(u.store_name || '')));
  const list = (units || []).filter((s) => s.store_erpid && isStore(s));
  const [mkt, aimin, planning, storehouse, contracts, sales] = await Promise.all([marketMonth(ym, list.map((s) => s.store_erpid)), aiminMonth(ym), planningMonth(ym), storehouseMonth(ym), rentContracts(), salesMonth(ym)]);
  const out = [];
  let i = 0;
  const worker = async () => {
    while (i < list.length) {
      const s = list[i++];
      try {
        const r = await build(ym, s.store_erpid, { market: mkt, aimin, planning, storehouse, contracts, sales });
        out.push({ store: s.store_erpid, store_name: s.store_name, status: r.status, total_in: r.totals.total_in, total_out: r.totals.total_out, profit: r.totals.profit,
          sales_total: r.totals.sales_total, receipt_total: r.totals.receipt_filled ? r.totals.receipt_total : null, gap_pct: r.gap.total.pct, gap_alert: r.gap.total.alert,
          erp_total: r.revenue.glasses_receipt.erp == null ? null : r.revenue.glasses_receipt.erp + (r.revenue.contact_receipt.erp || 0),
          filled: r.revenue.glasses_receipt.amount != null && r.revenue.contact_receipt.amount != null, warnings: r.warnings.length });
      } catch (e) { out.push({ store: s.store_erpid, store_name: s.store_name, error: e.message }); }
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  out.sort((a, b) => String(a.store_name).localeCompare(String(b.store_name), 'zh-Hant'));

  // 不是門市、但這個月帳本上有費用的單位（董事長室、營運部、加工部…）：另列，免得錢「不見」
  const storeSet = new Set(list.map((s) => String(s.store_erpid)));
  const { data: lines } = await supabase.rpc('ledger_lines', { p_ym: ym });
  const other = {};
  for (const l of lines || []) {
    const id = String(l.store_erpid || '');
    if (!id || storeSet.has(id)) continue;
    const o = (other[id] = other[id] || { store: id, total: 0, lines: 0, codes: {} });
    o.total += Number(l.amount || 0); o.lines += 1; o.codes[l.ledger_code] = (o.codes[l.ledger_code] || 0) + Number(l.amount || 0);
  }
  const ids = Object.keys(other);
  if (ids.length) {
    const nameOf = Object.fromEntries((units || []).map((u) => [String(u.store_erpid), u.store_name]));
    // 名稱就是代碼的佔位單位（000000、00099…）→ 用營運部系統基本資料登記的單位名稱
    const { data: facts } = await supabase.from('entity_facts').select('store_erpid, store_name').in('store_erpid', ids);
    const factName = Object.fromEntries((facts || []).filter((f) => f.store_name).map((f) => [String(f.store_erpid), f.store_name]));
    for (const id of ids) {
      const n = nameOf[id];
      other[id].name = n && n !== id ? n : (factName[id] || n || id);
      other[id].total = r0(other[id].total);
      other[id].codes = Object.fromEntries(Object.entries(other[id].codes).map(([k, v]) => [k, r0(v)]));
    }
  }
  return { ym, stores: out, others: Object.values(other).sort((a, b) => b.total - a.total), market_error: mkt.error || null, aimin_error: aimin.error || null };
}

module.exports = {
  rentChecks, salesMonth, rentBasics, rentContracts, rentForMonth, storehouseMonth, clearStorehouseCache, SH_DEFAULT, planningMonth, aiminMonth, build, overview, accounts, settings, marketMonth, YM, GROUP_NAME, SOURCE_NAME };
