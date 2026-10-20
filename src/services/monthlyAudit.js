// services/monthlyAudit.js —— 門市月報「查帳提醒」（2026-10-20）
// 目的：像人工對帳那樣，一次看全部門市，把「看起來不合理」的數字先挑出來給會計／Louis 看。
// 比較基準：上個月（有舊試算表匯入 ledger_history 就用試算表，沒有就用系統帳本）＋同月其他門市。
// 規則（每則 finding 有 key，會計按「確認沒問題」記在 ledger_audit_acks，下次不再列為待看）：
//   missing  上月有、這月沒有（房租、電費、電話、薪資、勞健保、刷卡費…）；同一科目過半門市都缺＝合併成一則「全公司還沒接／還沒填」
//   jump     跟上月比暴增／暴減
//   peer     占業績比例遠高於其他門市（例：十甲 8 月一甲一鏡片 238,255）
//   estimate 電費／水費／電話是整千＝看起來是先估的
//   negative 支出是負數
//   dup      同科目、同金額、同摘要出現兩次（可能重複請款）
//   gap      實收差超過門檻
//   ratio    成本率超過目標 1.5 倍
//   profit   盈餘跟上月差很多
//   sales    業績跟上月差 25% 以上
// AI 說明（選用）：Render 設 ANTHROPIC_API_KEY 才會開；把這家店的提醒＋關鍵數字交給模型，寫成給會計看的白話＋要問門市的問題。
const axios = require('axios');
const supabase = require('../config/supabase');
const MR = require('./monthlyReport');

const r0 = (n) => Math.round(Number(n) || 0);
const prevYm = (ym) => { const [y, m] = ym.split('-').map(Number); return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`; };
const fmt = (n) => (n == null ? '—' : r0(n).toLocaleString('zh-TW'));

const MUST = { rent: 'high', salary: 'high', labor_insurance: 'mid', electricity: 'mid', telecom: 'mid', card_fee: 'mid' };
const ESTIMATE_CODES = ['electricity', 'water', 'telecom'];
const SKIP_PEER = ['salary', 'rent', 'labor_insurance', 'marketing_fund', 'depreciation'];   // 本來就跟店的規模有關、或固定的
const SEV_ORDER = { high: 0, mid: 1, low: 2 };

async function storeList() {
  const { data: units } = await supabase.from('departments').select('store_erpid, store_name, is_active, report_kind').eq('is_active', true);
  const isStore = (u) => u.report_kind === 'store' || (u.report_kind == null && /店$/.test(String(u.store_name || '')));
  return (units || []).filter((s) => s.store_erpid && isStore(s));
}

/** 一個月全部門市的快照：codes（科目→金額）、lines、業績、實收、盈餘… */
async function systemMonth(ym, stores) {
  const [market, aimin, planning, storehouse, contracts] = await Promise.all([MR.marketMonth(ym, stores.map((s) => s.store_erpid)), MR.aiminMonth(ym), MR.planningMonth(ym), MR.storehouseMonth(ym), MR.rentContracts()]);
  const out = {};
  let i = 0;
  const worker = async () => {
    while (i < stores.length) {
      const s = stores[i++];
      try {
        const r = await MR.build(ym, s.store_erpid, { market, aimin, planning, storehouse, contracts, withLines: true });
        const codes = {}, names = {}, lines = [];
        for (const g of [...r.left, ...r.right]) for (const row of g.rows) {
          if (row.amount) codes[row.code] = row.amount;
          names[row.code] = row.name;
          for (const l of row.lines || []) lines.push({ code: row.code, amount: Number(l.amount) || 0, source: l.source, title: l.ref_title || l.reason || '', id: l.id || l.ref_id || null });
        }
        out[s.store_erpid] = {
          name: r.store_name || s.store_name, src: 'system', codes, names, lines,
          sales: r.totals.sales_total, receipt: r.totals.receipt_filled ? r.totals.receipt_total : null,
          profit: r.totals.profit, total_out: r.totals.total_out, ratio: r.totals.ratio, target: r.ratio_target, gap: r.gap,
          receipt_filled: r.totals.receipt_filled, rent: r.rent,
        };
      } catch (e) { out[s.store_erpid] = { name: s.store_name, error: e.message }; }
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  return { stores: out, market_error: market.error || null, aimin_error: aimin.error || null, planning, storehouse };
}

/** 舊試算表匯入的月份（ledger_history） */
async function sheetMonth(ym) {
  const { data } = await supabase.from('ledger_history').select('store_erpid, ledger_code, vendor, amount').eq('ym', ym);
  const out = {};
  for (const h of data || []) {
    const s = (out[h.store_erpid] = out[h.store_erpid] || { src: 'sheet', codes: {}, sums: {} });
    if (h.ledger_code.startsWith('_')) s.sums[h.ledger_code.slice(1)] = Number(h.amount);
    else s.codes[h.ledger_code] = (s.codes[h.ledger_code] || 0) + Number(h.amount);
  }
  for (const s of Object.values(out)) {
    s.sales = s.sums.glasses_sales != null ? s.sums.glasses_sales + (s.sums.contact_receipt || 0) : null;
    s.profit = s.sums.profit != null ? s.sums.profit : null;
    s.total_out = s.sums.total_out != null ? s.sums.total_out : null;
  }
  return out;
}

const cache = new Map();
async function audit(ym, opts = {}) {
  if (!MR.YM.test(ym)) throw new Error('ym 要是 YYYY-MM');
  const hit = cache.get(ym);
  if (hit && !opts.fresh && Date.now() - hit.at < 10 * 60e3) return withAcks(ym, hit.v);
  const stores = await storeList();
  const pym = prevYm(ym);
  const [cur, prevSys, prevSheet] = await Promise.all([systemMonth(ym, stores), systemMonth(pym, stores), sheetMonth(pym)]);
  const findings = [];
  const add = (f) => findings.push(f);
  const nameOf = (id) => (cur.stores[id] && cur.stores[id].name) || id;
  const codeName = {};
  for (const s of Object.values(cur.stores)) Object.assign(codeName, s.names || {});
  const cn = (c) => codeName[c] || c;
  const base = (id) => (prevSheet[id] ? prevSheet[id] : prevSys.stores[id] || null);

  // ① 上月有、這月沒有 —— 先算每個科目缺幾家，過半就合併成一則
  const missingBy = {};
  for (const [id, s] of Object.entries(cur.stores)) {
    if (s.error) continue;
    const b = base(id);
    if (!b) continue;
    for (const [code, sev] of Object.entries(MUST)) {
      const pv = b.codes[code] || 0, cv = s.codes[code] || 0;
      if (pv > 0 && !cv) (missingBy[code] = missingBy[code] || []).push({ id, pv, sev, src: b.src });
    }
  }
  const nStores = Object.values(cur.stores).filter((s) => !s.error).length;
  for (const [code, list] of Object.entries(missingBy)) {
    if (list.length >= Math.max(4, nStores / 2)) {
      add({ store: '*', store_name: '全公司', sev: 'mid', key: `missing:${code}`, code, title: `${cn(code)}：${list.length} 家門市這個月沒有`,
        detail: `上個月有、這個月系統裡沒有的門市：${list.map((x) => nameOf(x.id)).join('、')}。多半是這個科目還沒接到系統、或還沒手填，不是門市真的沒有。`,
        amount: list.reduce((t, x) => t + x.pv, 0) });
    } else {
      for (const x of list) add({ store: x.id, store_name: nameOf(x.id), sev: x.sev, key: `missing:${code}`, code,
        title: `${cn(code)}這個月沒有`, detail: `上個月${x.src === 'sheet' ? '（試算表）' : ''} ${fmt(x.pv)}，這個月系統裡是 0。帳單還沒到、還沒手填，或真的停了？`, amount: x.pv });
    }
  }

  // ② 跟上月比暴增／暴減
  for (const [id, s] of Object.entries(cur.stores)) {
    if (s.error) continue;
    const b = base(id);
    if (!b) continue;
    for (const [code, cv] of Object.entries(s.codes)) {
      const pv = b.codes[code] || 0;
      if (!pv || !cv) continue;
      const d = cv - pv, ad = Math.abs(d);
      const sev = ad >= Math.max(20000, Math.abs(pv)) ? 'high' : ad >= Math.max(5000, Math.abs(pv) * 0.5) ? 'mid' : null;
      if (!sev) continue;
      add({ store: id, store_name: s.name, sev, key: `jump:${code}`, code, title: `${cn(code)}${d > 0 ? '暴增' : '暴減'} ${fmt(ad)}`,
        detail: `上個月${b.src === 'sheet' ? '（試算表）' : ''} ${fmt(pv)} → 這個月 ${fmt(cv)}（${d > 0 ? '+' : ''}${Math.round((d / Math.abs(pv)) * 100)}%）`, amount: d });
    }
  }

  // ③ 占業績比例遠高於其他門市
  const allCodes = new Set();
  Object.values(cur.stores).forEach((s) => Object.keys(s.codes || {}).forEach((c) => allCodes.add(c)));
  for (const code of allCodes) {
    if (SKIP_PEER.includes(code)) continue;
    const pts = Object.entries(cur.stores).filter(([, s]) => !s.error && s.sales > 0 && (s.codes[code] || 0) > 0)
      .map(([id, s]) => ({ id, s, v: s.codes[code], r: s.codes[code] / s.sales }));
    if (pts.length < 6) continue;
    const sorted = pts.map((p) => p.r).sort((a, b) => a - b);
    const med = sorted[Math.floor(sorted.length / 2)];
    for (const p of pts) {
      const k = p.r / med;
      const sev = k >= 3 && p.v >= 10000 ? 'high' : k >= 2 && p.v >= 10000 ? 'mid' : null;
      if (!sev) continue;
      add({ store: p.id, store_name: p.s.name, sev, key: `peer:${code}`, code, title: `${cn(code)}比其他門市高很多（${k.toFixed(1)} 倍）`,
        detail: `${fmt(p.v)}＝業績的 ${(p.r * 100).toFixed(1)}%，其他 ${pts.length - 1} 家的中位數是 ${(med * 100).toFixed(1)}%。是不是把好幾個月的帳一起列、或分攤錯店？`, amount: p.v });
    }
  }

  // ④⑤⑥ 逐列：估計值、負數、重複
  for (const [id, s] of Object.entries(cur.stores)) {
    if (s.error) continue;
    for (const code of ESTIMATE_CODES) {
      const v = s.codes[code] || 0;
      const manual = (s.lines || []).some((l) => l.code === code && /^manual/.test(l.source));
      if (v >= 1000 && v % 1000 === 0 && manual) add({ store: id, store_name: s.name, sev: 'low', key: `estimate:${code}`, code,
        title: `${cn(code)} ${fmt(v)} 是整千`, detail: '看起來是先估的，帳單到了記得改成實際金額。', amount: v });
    }
    // 帳進來了但沒設月報科目（廠商／會計科目沒對到）→ 落在「其他」
    const unc = (s.lines || []).filter((l) => l.code === 'other' && !/^manual/.test(l.source));
    if (unc.length) add({ store: id, store_name: s.name, sev: 'mid', key: 'uncoded', code: 'other',
      title: `${unc.length} 筆帳沒設月報科目，暫時放在「其他」（${fmt(unc.reduce((a, l) => a + l.amount, 0))}）`,
      detail: `${unc.slice(0, 3).map((l) => String(l.title).slice(0, 30)).join('；')}。到「⚙ 科目與廠商」幫這個廠商／會計科目選月報上的格子，之後同一家的帳就會自動歸位。`,
      amount: unc.reduce((a, l) => a + l.amount, 0) });
    // 房租合約：沒合約、只有報稅版、合約快到期／已過期但還在付、實付比合約總額少超過扣繳範圍
    const rt = s.rent || { contracts: [] };
    if (!rt.contracts.length) add({ store: id, store_name: s.name, sev: ((s.codes || {}).rent ? 'low' : 'mid'), key: 'rent:nocontract', code: 'rent',
      title: (s.codes || {}).rent ? `房租還沒有合約（目前${rt.from_basic ? '暫用基本資料' : '用固定支出'} ${fmt((s.codes || {}).rent)}）` : '這家店沒有房租（沒合約、基本資料也沒填）',
      detail: '到「合約管理」新增房租合約並選這家門市，月報就會改用合約金額。', amount: (s.codes || {}).rent || null });
    if (rt.only_tax) add({ store: id, store_name: s.name, sev: 'mid', key: 'rent:onlytax', code: 'rent', title: '房租只有「報稅版」合約',
      detail: '月報要用實際合約；請把實際那份上傳並選「實際」。', amount: null });
    for (const c of rt.contracts) {
      if (c.end_date) { const left = (Date.parse(c.end_date) - Date.parse(`${ym}-01`)) / 864e5;
        if (left < 0 && rt.paid) add({ store: id, store_name: s.name, sev: 'high', key: `rent:expired:${c.id}`, code: 'rent', title: `房租合約 ${c.end_date} 已到期，但還在付`, detail: `「${c.name}」要續約或停付。`, amount: rt.paid });
        else if (left >= 0 && left < 90) add({ store: id, store_name: s.name, sev: 'low', key: `rent:expiring:${c.id}`, code: 'rent', title: `房租合約 ${c.end_date} 到期`, detail: `「${c.name}」剩不到 3 個月，記得談續約。`, amount: null }); }
    }
    const bref = rt.basic ? (rt.basic.contract_rent || rt.basic.actual_rent) : null;
    const dueC = rt.contracts.reduce((a, c) => a + (c.amount || 0), 0);
    if (dueC && bref && Math.abs(dueC - bref) / bref > 0.15) add({ store: id, store_name: s.name, sev: 'mid', key: 'rent:basicdiff', code: 'rent',
      title: `房租合約 ${fmt(dueC)}，基本資料寫 ${fmt(bref)}`, detail: `差很多：可能還有一份合約沒建（例如本店＋驗光所分開租），或基本資料沒更新。基本資料月報應列金額 ${fmt(rt.basic.report_amount)}。`, amount: dueC - bref });
    const due = rt.contracts.reduce((a, c) => a + (c.amount || 0), 0);
    if (due && rt.paid != null && (rt.paid > due * 1.001 || rt.paid < due * 0.85)) add({ store: id, store_name: s.name, sev: 'mid', key: 'rent:paid', code: 'rent',
      title: `房租實付 ${fmt(rt.paid)}，合約 ${fmt(due)}`, detail: `扣繳（10%＋二代健保）後通常是合約的 88～95%；差太多要看是不是金額改了沒更新${rt.paid_checks ? `（其中支票 ${fmt(rt.paid_checks)}：支票是照票面到期日算，兩個月開一張或一次開多張的店會跳這則，屬正常）` : ''}。`, amount: rt.paid - due });
    for (const b of rt.bounced || []) add({ store: id, store_name: s.name, sev: 'high', key: `rent:bounced:${b.check_no}`, code: 'rent',
      title: `房租支票退票 ${b.check_no || ''}`, detail: `票面到期 ${b.due_date}，金額 ${fmt(b.amount)}；到「支票紀錄」處理並確認房東有沒有收到。`, amount: b.amount });
    const negs = (s.lines || []).filter((l) => l.amount < 0);
    const negBy = {};
    negs.forEach((l) => { negBy[l.code] = (negBy[l.code] || 0) + l.amount; });
    for (const [code, v] of Object.entries(negBy)) add({ store: id, store_name: s.name, sev: 'low', key: `negative:${code}`, code,
      title: `${cn(code)}有負數 ${fmt(v)}`, detail: '退款、沖帳還是打錯正負號？', amount: v });
    const seen = {};
    for (const l of s.lines || []) {
      if (Math.abs(l.amount) < 1000) continue;
      const k = `${l.code}|${r0(l.amount)}|${String(l.title).replace(/\s+/g, '').slice(0, 40)}`;
      seen[k] = (seen[k] || 0) + 1;
      if (seen[k] === 2) add({ store: id, store_name: s.name, sev: 'mid', key: `dup:${l.code}:${r0(l.amount)}`, code: l.code,
        title: `${cn(l.code)}同一筆出現兩次（${fmt(l.amount)}）`, detail: `摘要：${String(l.title).slice(0, 80)}。重複請款，或本來就是兩筆？`, amount: l.amount });
    }
  }

  // ⑦⑧⑨⑩ 店的整體：實收差、成本率、盈餘、業績
  for (const [id, s] of Object.entries(cur.stores)) {
    if (s.error) { add({ store: id, store_name: s.name, sev: 'mid', key: 'error', title: '月報算不出來', detail: s.error }); continue; }
    const g = s.gap && s.gap.total;
    if (g && g.alert) add({ store: id, store_name: s.name, sev: 'high', key: 'gap', title: `實收差 ${g.pct > 0 ? '+' : ''}${g.pct}%`,
      detail: `實收 ${fmt(g.receipt)}／業績 ${fmt(g.sales)}（差 ${fmt(g.diff)}）。延遲付款、退貨，還是實收填錯？`, amount: g.diff });
    if (s.receipt_filled) {
      for (const [k, v] of Object.entries(s.ratio || {})) {
        const t = (s.target || {})[k];
        if (k === '淨利' || t == null || v == null) continue;
        if (v >= t * 1.5) add({ store: id, store_name: s.name, sev: 'mid', key: `ratio:${k}`, title: `${k}成本率 ${v}%（目標 ${t}%）`,
          detail: '超過目標 1.5 倍。', amount: null });
      }
    }
    const b = base(id);
    if (b && b.profit != null && s.receipt_filled) {
      const d = s.profit - b.profit;
      if (Math.abs(d) >= Math.max(150000, Math.abs(b.profit) * 0.5)) add({ store: id, store_name: s.name, sev: 'mid', key: 'profit',
        title: `盈餘跟上月差 ${fmt(d)}`, detail: `上個月${b.src === 'sheet' ? '（試算表）' : ''} ${fmt(b.profit)} → 這個月 ${fmt(s.profit)}`, amount: d });
    }
    if (b && b.sales > 0 && s.sales != null) {
      const p = (s.sales - b.sales) / b.sales;
      if (Math.abs(p) >= 0.25) add({ store: id, store_name: s.name, sev: 'mid', key: 'sales', title: `業績跟上月差 ${p > 0 ? '+' : ''}${Math.round(p * 100)}%`,
        detail: `上個月${b.src === 'sheet' ? '（試算表）' : ''} ${fmt(b.sales)} → 這個月 ${fmt(s.sales)}。月份還沒結束、系統沒資料（例：十甲 9/10 起 ERP 沒單），還是真的掉了？`, amount: s.sales - b.sales });
    }
  }
  // ⑪ 企劃部開帳本身的問題（開帳時選門市那張表）
  const pl = cur.planning || {};
  if (pl.error) add({ store: '*', store_name: '全公司', sev: 'mid', key: 'src:planning', title: '拿不到企劃部開帳', detail: pl.error });
  for (const i of pl.issues || []) {
    if (i.kind === 'zero') add({ store: i.store, store_name: nameOf(i.store), sev: 'mid', key: `plan:zero:${i.line.billing_id}`, code: 'planning_goods',
      title: `企劃部開帳：${i.line.item} 有數量 ${i.line.qty} 但金額 0`, detail: `單號 ${i.line.serial || i.line.expense_id}，開給${i.line.target_name}。是漏填成本分攤，還是本來就送的？`, amount: 0 });
    if (i.kind === 'cost_sum') add({ store: '*', store_name: '全公司', sev: 'mid', key: `plan:cost:${i.expense_id}`, code: 'planning_goods',
      title: `企劃部開帳：${i.e.item} 各店分攤成本加起來 ${fmt(i.e.cost)}，總成本是 ${fmt(i.e.cost_total)}`, detail: `單號 ${i.e.serial || i.expense_id}；${i.e.lines.map((l) => `${l.target_name} ${fmt(l.cost_share)}`).join('、')}`, amount: i.e.cost - i.e.cost_total });
    if (i.kind === 'qty_sum') add({ store: '*', store_name: '全公司', sev: 'low', key: `plan:qty:${i.expense_id}`, code: 'planning_goods',
      title: `企劃部開帳：${i.e.item} 各店數量加起來 ${i.e.qty}，總數量是 ${i.e.qty_total}`, detail: `單號 ${i.e.serial || i.expense_id}；${i.e.lines.map((l) => `${l.target_name} ${l.qty}`).join('、')}`, amount: null });
    if (i.kind === 'unmapped') add({ store: '*', store_name: '全公司', sev: 'mid', key: `plan:unmapped:${i.line.target_id}`, code: 'planning_goods',
      title: `企劃部開帳對象「${i.line.target_name}」對不到門市`, detail: '營運部 report_settings.planning_target_map 要補這個對象。', amount: Number(i.line.sell_amount) || 0 });
  }
  // 倉庫開帳（常備品撥補／產品出貨）
  const shm = cur.storehouse || {};
  if (shm.error) add({ store: '*', store_name: '全公司', sev: 'mid', key: 'src:storehouse', title: '拿不到倉庫開帳', detail: shm.error });
  const shUn = {};
  for (const i of shm.issues || []) {
    if (i.kind === 'unmapped') { const k = i.line.store || '（空白）'; (shUn[k] = shUn[k] || { n: 0, amt: 0 }); shUn[k].n += 1; shUn[k].amt += Number(i.line.amount) || 0; }
    if (i.kind === 'zero') add({ store: i.store, store_name: nameOf(i.store), sev: 'mid', key: `sh:zero:${i.line.id}`, code: i.line.ledger_code,
      title: `倉庫出貨 ${i.line.date} 有數量沒金額`, detail: `${(i.line.items || []).map((x) => `${x.name}×${x.qty}`).join('、')}：售價是 0，要到倉庫產品資料庫補售價。`, amount: 0 });
  }
  for (const [k, v] of Object.entries(shUn)) add({ store: '*', store_name: '全公司', sev: 'mid', key: `sh:unmapped:${k}`,
    title: `倉庫出貨門市「${k}」對不到門市`, detail: `${v.n} 筆、${Math.round(v.amt).toLocaleString('zh-TW')} 元沒進任何門市月報；營運部 report_settings.storehouse_store_map 要補「${k}」→ ERP 門市編號。`, amount: v.amt });
  if (pl.unbilled) add({ store: '*', store_name: '全公司', sev: 'low', key: 'plan:unbilled', title: `企劃部這個月還有 ${pl.unbilled} 筆沒開帳`, detail: '沒開帳的不會進門市月報（舊的文字開帳、二次開帳都在這裡）。', amount: null });

  if (cur.market_error) add({ store: '*', store_name: '全公司', sev: 'mid', key: 'src:market', title: '拿不到 ERP 業績／門市費用單', detail: cur.market_error });
  if (cur.aimin_error) add({ store: '*', store_name: '全公司', sev: 'mid', key: 'src:aimin', title: '拿不到愛民系統資料', detail: cur.aimin_error });

  findings.sort((a, b) => SEV_ORDER[a.sev] - SEV_ORDER[b.sev] || Math.abs(b.amount || 0) - Math.abs(a.amount || 0));
  const today = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 7);
  const v = {
    ym, prev_ym: pym, base: Object.keys(prevSheet).length ? `上月比較：${Object.keys(prevSheet).length} 家用會計試算表，其他用系統帳本` : '上月比較：系統帳本',
    month_open: ym >= today, findings, stores_checked: nStores,
  };
  cache.set(ym, { at: Date.now(), v });
  return withAcks(ym, v);
}

async function withAcks(ym, v) {
  const { data } = await supabase.from('ledger_audit_acks').select('*').eq('ym', ym);
  const m = Object.fromEntries((data || []).map((a) => [`${a.store_erpid}|${a.rule_key}`, a]));
  const findings = v.findings.map((f) => ({ ...f, ack: m[`${f.store}|${f.key}`] || null }));
  const open = findings.filter((f) => !f.ack);
  return { ...v, findings, counts: { high: open.filter((f) => f.sev === 'high').length, mid: open.filter((f) => f.sev === 'mid').length, low: open.filter((f) => f.sev === 'low').length, acked: findings.length - open.length } };
}

/** AI 說明：把一家店的提醒寫成給會計看的白話＋要問門市的問題（要 ANTHROPIC_API_KEY） */
async function explain(ym, store) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return { enabled: false, text: null };
  const a = await audit(ym);
  const fs = a.findings.filter((f) => f.store === store || f.store === '*');
  if (!fs.length) return { enabled: true, text: '這家店這個月沒有被挑出的異常。' };
  const r = await MR.build(ym, store, {});
  const facts = {
    門市: r.store_name, 月份: ym, 總業績: r.totals.sales_total, 總實收: r.totals.receipt_filled ? r.totals.receipt_total : '還沒填',
    總支出: r.totals.total_out, 盈餘: r.totals.profit, 成本率: r.totals.ratio,
    提醒: fs.map((f) => ({ 嚴重度: f.sev, 標題: f.title, 說明: f.detail, 已確認: f.ack ? f.ack.note || f.ack.status : null })),
  };
  const res = await axios.post('https://api.anthropic.com/v1/messages', {
    model: process.env.AUDIT_AI_MODEL || 'claude-haiku-4-5', max_tokens: 700,
    system: '你是眼鏡連鎖門市的會計助理。根據提供的月報數字與系統挑出的提醒，用繁體中文寫給會計看：先一句總結，再列出最值得先查的 3 件事（每件一行，說明為什麼可疑、可能原因），最後列 2～3 個要問門市或廠商的具體問題。只根據提供的資料，不要編造數字；資料不足就說不知道。',
    messages: [{ role: 'user', content: JSON.stringify(facts) }],
  }, { headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, timeout: 30000 });
  const text = (res.data.content || []).map((c) => c.text || '').join('').trim();
  return { enabled: true, text };
}

module.exports = { audit, explain, prevYm };
