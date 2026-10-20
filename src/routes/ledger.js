// routes/ledger.js —— 門市月報帳本（P0 2026-10-20；P1 月報同日）
// 規劃：app/pet-feature/PLAN_門市月報與開帳_20261020.md
//   GET  /api/ledger/accounts                         科目表
//   POST /api/ledger/accounts、PATCH /accounts/:code   新增／改科目（新科目自動排進月報那一區）
//   POST /api/ledger/shareholders、PATCH|DELETE /shareholders/:id   股東（門市基礎設定裡設；只能挑左手「股東」部門的人）
//   GET /api/ledger/shareholder-roster、PUT /shareholder-roster/group   左手股東部門名單／部門編號
//   GET  /api/ledger/store-profile?store=&ym=          門市基礎設定（基本資料＋合約＋固定支出付款＋行銷基金折舊＋股東）
//   GET  /api/ledger/mapping、PATCH /mapping/source/:id、/mapping/category/:id   廠商／會計科目 → 月報科目
//   GET  /api/ledger/lines?ym=2026-09[&store=120085]  帳本每一列
//   GET  /api/ledger/summary?ym=2026-09[&store=]      每店×科目加總
//   GET  /api/ledger/overview?ym=2026-09              全部門市一覽
//   GET  /api/ledger/report?ym=2026-09&store=120085   一家店的月報（含每格明細）
//   POST /api/ledger/manual                           手填值／調帳（billing 編輯）
//   DELETE /api/ledger/manual/:id                     作廢手填／調帳（留紀錄）
//   POST /api/ledger/report/retained                  保留盈餘金額（null＝照預設比例）
//   GET/POST/DELETE /api/ledger/fixed                 每店固定金額（行銷基金、折舊）
//   POST /api/ledger/report/status                    關帳流程 {ym, stores:[…]|'all', action: submit|close|reopen, reason}
//     submit＝會計送審閱（billing 編輯）；close／reopen＝只有 super_admin（Louis）；關帳存整份快照、之後數字凍結
//   GET  /api/ledger/audit?ym=2026-09[&fresh=1]       查帳提醒（全部門市；services/monthlyAudit.js）
//   POST /api/ledger/audit/ack                        會計標記：確認沒問題／已處理／要追（{store, ym, rule_key, status, note}）
//   DELETE /api/ledger/audit/ack/:id                  取消標記
//   POST /api/ledger/audit/explain                    AI 說明一家店（要 ANTHROPIC_API_KEY）
// 權限：billing 模組「查看」；寫入要「編輯」；已關帳的月份不能改
const express = require('express');
const router = express.Router();
const supabase = require('../config/supabase');
const { authenticate, authorizeModule } = require('../middleware/auth');
const MR = require('../services/monthlyReport');
const MA = require('../services/monthlyAudit');
const LV = require('../services/ledgerVouchers');
const LS = require('../services/ledgerSubjects');

router.use(authenticate, authorizeModule('billing', 'view'));
const canEdit = authorizeModule('billing', 'edit');

const YM = MR.YM;
const fail = (res, e) => { console.error('[ledger]', e.message); res.status(500).json({ success: false, message: e.message }); };
const bad = (res, msg, code = 400) => res.status(code).json({ success: false, message: msg });
const who = (req) => (req.user && (req.user.name || req.user.member_id)) || null;

async function closed(store, ym) {
  const { data } = await supabase.from('store_month_reports').select('status').eq('store_erpid', store).eq('ym', ym).maybeSingle();
  return data && data.status === 'closed';
}

router.get('/accounts', async (req, res) => {
  try { res.json({ success: true, data: await MR.accounts() }); } catch (e) { fail(res, e); }
});

async function rpc(fn, req, res) {
  const ym = String(req.query.ym || '');
  if (!YM.test(ym)) return bad(res, 'ym 要是 YYYY-MM');
  try {
    let q = supabase.rpc(fn, { p_ym: ym });
    if (req.query.store) q = q.eq('store_erpid', String(req.query.store));
    const { data, error } = await q;
    if (error) throw error;
    res.json({ success: true, ym, data });
  } catch (e) { fail(res, e); }
}
router.get('/lines',   (req, res) => rpc('ledger_lines', req, res));
router.get('/summary', (req, res) => rpc('ledger_store_month', req, res));

router.get('/overview', async (req, res) => {
  try { res.json({ success: true, data: await MR.overview(String(req.query.ym || '')) }); } catch (e) { fail(res, e); }
});

router.get('/report', async (req, res) => {
  try {
    const ym = String(req.query.ym || ''), store = String(req.query.store || '');
    // 已關帳＝看關帳當下的快照（數字凍結）；?live=1 才重算
    if (req.query.live !== '1') {
      const { data: rep } = await supabase.from('store_month_reports').select('*').eq('store_erpid', store).eq('ym', ym).maybeSingle();
      if (rep && rep.status === 'closed' && rep.snapshot) {
        const snap = JSON.parse(JSON.stringify(rep.snapshot));
        return res.json({ success: true, data: await LV.decorateReport({ ...snap, report: { ...rep, snapshot: undefined }, status: 'closed', frozen: true }, req.user) });
      }
    }
    const data = await MR.build(ym, store, { withLines: true, allRows: req.query.all === '1' });
    res.json({ success: true, data: await LV.decorateReport(data, req.user) });
  } catch (e) { fail(res, e); }
});

router.post('/manual', canEdit, async (req, res) => {
  try {
    const b = req.body || {};
    const store = String(b.store || ''), ym = String(b.ym || ''), code = String(b.ledger_code || '');
    const type = b.entry_type === 'adjust' ? 'adjust' : 'value';
    if (!store || !YM.test(ym) || !code) return bad(res, '缺門市／月份／科目');
    if (b.fee_ym && !YM.test(String(b.fee_ym))) return bad(res, '費用月要是 YYYY-MM');
    const amount = Number(b.amount);
    if (!Number.isFinite(amount)) return bad(res, '金額不對');
    const reason = String(b.reason || '').trim();
    if (type === 'adjust' && !reason) return bad(res, '調帳一定要寫原因');
    if (await closed(store, ym)) return bad(res, '這個月已關帳，請記在下個月或先重新開帳', 409);
    const vendor = String(b.vendor || '').trim() || null;
    // 會計科目（2026-10-21）：支出格子一律要選（清掉手填值不用）
    let subjectId = null;
    if (!b.clear && await LS.needsSubject(code)) {
      try { subjectId = (await LS.mustGet(b.subject_id, code)).id; } catch (e) { return bad(res, e.message); }
    }
    const row = { entry_type: type, store_erpid: store, report_ym: ym, fee_ym: b.fee_ym || null, ledger_code: code, amount, vendor, reason: reason || null, files: Array.isArray(b.files) ? b.files : [], created_by: who(req), subject_id: subjectId };
    if (type === 'value') {
      // 同店同月同科目同廠商只留一筆：舊的作廢再寫新的（留紀錄）
      let q = supabase.from('ledger_manual_entries').update({ void_at: new Date().toISOString(), void_by: who(req) })
        .eq('store_erpid', store).eq('report_ym', ym).eq('ledger_code', code).eq('entry_type', 'value').is('void_at', null);
      q = vendor ? q.eq('vendor', vendor) : q.is('vendor', null);
      const { error: e1 } = await q; if (e1) throw e1;
      if (b.clear) return res.json({ success: true, data: null });
    }
    const { data, error } = await supabase.from('ledger_manual_entries').insert(row).select().single();
    if (error) throw error;
    res.json({ success: true, data });
  } catch (e) { fail(res, e); }
});

// ── 分攤開帳（2026-10-20）：一筆金額分 N 個月列入同一家店同一個科目 ──
// POST {store, ledger_code, total, from_ym, months(2～60), vendor, reason(必填)}；每月 floor(total/N)，零頭放最後一個月
// 任何一個月已關帳就整筆不建；GET ?store= 列出這家店的分攤；DELETE /amortize/:group 作廢還沒關帳的那幾個月
const addYm = (ym, k) => { const [y, m] = ym.split('-').map(Number); return new Date(Date.UTC(y, m - 1 + k, 1)).toISOString().slice(0, 7); };
router.get('/amortize', async (req, res) => {
  try {
    let q = supabase.from('ledger_manual_entries').select('id, amort_group, amort_seq, amort_n, amort_total, store_erpid, report_ym, ledger_code, amount, vendor, reason, created_by, created_at, void_at, subject_id')
      .not('amort_group', 'is', null).order('created_at', { ascending: false }).limit(2000);
    if (req.query.store) q = q.eq('store_erpid', String(req.query.store));
    const { data, error } = await q; if (error) throw error;
    const g = {};
    for (const r of data || []) {
      const x = (g[r.amort_group] = g[r.amort_group] || { group: r.amort_group, store: r.store_erpid, ledger_code: r.ledger_code, subject_id: r.subject_id || null, total: Number(r.amort_total), n: r.amort_n, vendor: r.vendor,
        reason: String(r.reason || '').replace(/^分攤 \d+\/\d+（[^）]*）：/, ''), created_by: r.created_by, created_at: r.created_at, months: [] });
      x.months.push({ id: r.id, seq: r.amort_seq, ym: r.report_ym, amount: Number(r.amount), void: !!r.void_at });
    }
    const list = Object.values(g).map((x) => ({ ...x, months: x.months.sort((a, b) => a.seq - b.seq), from_ym: x.months.reduce((m, r) => (!m || r.ym < m ? r.ym : m), ''), to_ym: x.months.reduce((m, r) => (r.ym > m ? r.ym : m), '') }))
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    res.json({ success: true, data: list });
  } catch (e) { fail(res, e); }
});
router.post('/amortize', canEdit, async (req, res) => {
  try {
    const b = req.body || {};
    // 會計科目（2026-10-21）：一定要選，月報格子跟著科目走
    let subj;
    try { subj = await LS.mustGet(b.subject_id, b.ledger_code || null); } catch (e) { return bad(res, e.message); }
    const store = String(b.store || ''), code = subj.ledger_code, from = String(b.from_ym || '');
    const total = Math.round(Number(b.total)), n = Math.floor(Number(b.months));
    const reason = String(b.reason || '').trim(), vendor = String(b.vendor || '').trim() || null;
    if (!store || !code || !YM.test(from)) return bad(res, '缺門市／科目／起始月份');
    if (!Number.isFinite(total) || total === 0) return bad(res, '總金額不對');
    if (!(n >= 2 && n <= 60)) return bad(res, '分攤月數要 2～60');
    if (!reason) return bad(res, '要寫說明（例：招牌更換，分 12 個月）');
    if (!(await okCode(code)) ) return bad(res, '沒有這個科目');
    const yms = Array.from({ length: n }, (_, k) => addYm(from, k));
    const { data: cl } = await supabase.from('store_month_reports').select('ym').eq('store_erpid', store).in('ym', yms).eq('status', 'closed');
    if ((cl || []).length) return bad(res, `${cl.map((x) => x.ym).join('、')} 已關帳，請從之後的月份開始分攤`, 409);
    const each = Math.trunc(total / n), last = total - each * (n - 1);
    const group = `am_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const rows = yms.map((ym, k) => ({ entry_type: 'amort', store_erpid: store, report_ym: ym, fee_ym: ym, ledger_code: code, amount: k === n - 1 ? last : each, vendor,
      reason: `分攤 ${k + 1}/${n}（總額 ${total.toLocaleString()}）：${reason}`, files: Array.isArray(b.files) ? b.files : [], created_by: who(req),
      amort_group: group, amort_seq: k + 1, amort_n: n, amort_total: total, subject_id: subj.id }));
    const { error } = await supabase.from('ledger_manual_entries').insert(rows);
    if (error) throw error;
    res.json({ success: true, data: { group, months: yms, each, last } });
  } catch (e) { fail(res, e); }
});
router.delete('/amortize/:group', canEdit, async (req, res) => {
  try {
    const { data } = await supabase.from('ledger_manual_entries').select('id, store_erpid, report_ym').eq('amort_group', req.params.group).is('void_at', null);
    if (!(data || []).length) return bad(res, '找不到或已作廢', 404);
    const kept = [], ids = [];
    for (const r of data) { if (await closed(r.store_erpid, r.report_ym)) kept.push(r.report_ym); else ids.push(r.id); }
    if (ids.length) { const { error } = await supabase.from('ledger_manual_entries').update({ void_at: new Date().toISOString(), void_by: who(req) }).in('id', ids); if (error) throw error; }
    res.json({ success: true, data: { voided: ids.length, kept_closed: kept.sort() } });
  } catch (e) { fail(res, e); }
});

// ── 帳單入帳設定（2026-10-20）：每一筆分配（某店）的列入月份、科目、分攤 ──
// 已關帳的月份不能寫入也不能移出；有分攤的要先取消分攤才能改月份
const LP = require('../services/ledgerPost');
async function allocView(billId) {
  const { data: bill } = await supabase.from('bills').select('id, bill_no, title, period, status, report_ym, report_ym_manual, received_at, submitted_at, created_at, confirmed_at, ledger_code, source_id, accounting_category_id, source_system, subject_id').eq('id', billId).maybeSingle();
  if (!bill) return null;
  const [{ data: als }, { data: src }, { data: cat }] = await Promise.all([
    supabase.from('bill_allocations').select('id, store_erpid, store_name, allocated_amount, report_ym, fee_ym, ledger_code').eq('bill_id', billId).order('store_name'),
    bill.source_id ? supabase.from('billing_sources').select('name, ledger_code').eq('id', bill.source_id).maybeSingle() : { data: null },
    bill.accounting_category_id ? supabase.from('accounting_categories').select('name, ledger_code').eq('id', bill.accounting_category_id).maybeSingle() : { data: null },
  ]);
  const ids = (als || []).map((a) => a.id);
  const { data: sch } = ids.length ? await supabase.from('bill_alloc_schedule').select('*').in('allocation_id', ids).order('seq') : { data: [] };
  const cut = await LP.cutoffDay();
  const autoYm = bill.report_ym_manual && bill.report_ym ? bill.report_ym : (bill.report_ym || LP.reportYmFor(bill.period, LP.tpeDate(bill.received_at || bill.submitted_at || bill.created_at), cut));
  const stores = (als || []).map((a) => a.store_erpid);
  const isC = autoYm ? await LP.closedMap(stores.length ? stores : ['-'], LP.addYm(autoYm, -12), 80) : () => false;
  const defCode = bill.ledger_code || (cat && cat.ledger_code) || (src && src.ledger_code) || null;
  const rows = [];
  for (const a of als || []) {
    const sc = (sch || []).filter((x) => x.allocation_id === a.id);
    const valid = sc.length && Math.round(sc.reduce((t, x) => t + Number(x.amount), 0) * 100) === Math.round(Number(a.allocated_amount) * 100);
    const ym = a.report_ym || (autoYm ? await LP.openYm(a.store_erpid, autoYm, isC) : null);
    rows.push({ ...a, effective_ym: valid ? null : ym, ym_auto: !a.report_ym, closed: valid ? sc.some((x) => isC(a.store_erpid, x.report_ym)) : !!(ym && isC(a.store_erpid, ym)),
      effective_code: a.ledger_code || defCode || 'other', code_auto: !a.ledger_code,
      schedule: valid ? sc.map((x) => ({ seq: x.seq, ym: x.report_ym, amount: Number(x.amount), closed: isC(a.store_erpid, x.report_ym), shifted_from: x.shifted_from })) : [] });
  }
  const subj = bill.subject_id ? await LS.byId(bill.subject_id) : (defCode ? await LS.defaultOf(defCode) : null);
  return { bill: { ...bill, source_name: src && src.name, category_name: cat && cat.name, default_code: defCode, auto_ym: autoYm, cutoff: cut,
    subject_name: subj ? subj.name : null, subject_ledger: subj ? subj.ledger_code : null, subject_set: !!bill.subject_id }, allocations: rows };
}
router.get('/bill/:id', async (req, res) => {
  try { const v = await allocView(req.params.id); if (!v) return bad(res, '找不到帳單', 404); res.json({ success: true, data: v }); } catch (e) { fail(res, e); }
});
router.patch('/allocation/:id', canEdit, async (req, res) => {
  try {
    const b = req.body || {};
    const { data: a } = await supabase.from('bill_allocations').select('id, bill_id, store_erpid').eq('id', req.params.id).maybeSingle();
    if (!a) return bad(res, '找不到這筆分配', 404);
    const v = await allocView(a.bill_id);
    const cur = v.allocations.find((x) => x.id === a.id);
    const up = {};
    if (b.ledger_code !== undefined) {
      if (b.ledger_code && !(await okCode(b.ledger_code))) return bad(res, '沒有這個科目');
      if (cur.closed) return bad(res, '這筆列入的月份已關帳，不能改科目', 409);
      up.ledger_code = b.ledger_code || null;
    }
    if (b.report_ym !== undefined) {
      if (cur.schedule.length) return bad(res, '這筆有分攤，請先取消分攤再改月份');
      if (b.report_ym && !YM.test(String(b.report_ym))) return bad(res, '月份要是 YYYY-MM');
      if (cur.closed) return bad(res, `${cur.effective_ym} 已關帳，不能移出`, 409);
      if (b.report_ym && await closed(a.store_erpid, b.report_ym)) return bad(res, `${b.report_ym} 已關帳，請選之後的月份`, 409);
      up.report_ym = b.report_ym || null;
    }
    if (!Object.keys(up).length) return bad(res, '沒有要改的');
    up.updated_at = new Date().toISOString();
    const { error } = await supabase.from('bill_allocations').update(up).eq('id', a.id);
    if (error) throw error;
    MR.clearBookCache();
    res.json({ success: true, data: await allocView(a.bill_id) });
  } catch (e) { fail(res, e); }
});
// 分攤：months 1（或 0）＝取消分攤；from_ym 沒填＝目前列入的月份
router.post('/allocation/:id/schedule', canEdit, async (req, res) => {
  try {
    const b = req.body || {};
    const { data: a } = await supabase.from('bill_allocations').select('id, bill_id, store_erpid, allocated_amount').eq('id', req.params.id).maybeSingle();
    if (!a) return bad(res, '找不到這筆分配', 404);
    const v = await allocView(a.bill_id);
    const cur = v.allocations.find((x) => x.id === a.id);
    if (cur.schedule.some((x) => x.closed)) return bad(res, '分攤裡已經有月份關帳了，不能重排（要改請記調帳）', 409);
    if (!cur.schedule.length && cur.closed) return bad(res, `${cur.effective_ym} 已關帳，不能改`, 409);
    const n = Math.floor(Number(b.months) || 0);
    await supabase.from('bill_alloc_schedule').delete().eq('allocation_id', a.id);
    if (n > 1) {
      if (n > 60) return bad(res, '最多分 60 個月');
      const from = String(b.from_ym || cur.effective_ym || '');
      if (!YM.test(from)) return bad(res, '起始月份要是 YYYY-MM');
      const rows = (await LP.plan(a.store_erpid, a.allocated_amount, from, n)).map((r) => ({ ...r, allocation_id: a.id, created_by: who(req) }));
      const { error } = await supabase.from('bill_alloc_schedule').insert(rows);
      if (error) throw error;
    }
    MR.clearBookCache();
    res.json({ success: true, data: await allocView(a.bill_id) });
  } catch (e) { fail(res, e); }
});
// 入帳月份預設（給請款審核畫面）：費用月＋今天收到 → 預設列入月份；同時回這些門市在那個月有沒有關帳
router.get('/posting-preview', async (req, res) => {
  try {
    const fee = String(req.query.fee_ym || ''), want = String(req.query.ym || '');
    const stores = String(req.query.stores || '').split(',').filter(Boolean);
    const cut = await LP.cutoffDay();
    const def = YM.test(fee) ? LP.reportYmFor(fee, LP.tpeDate(), cut) : null;
    const ym = YM.test(want) ? want : def;
    const isC = ym && stores.length ? await LP.closedMap(stores, ym, 40) : () => false;
    const shift = [];
    for (const s of stores) { const o = await LP.openYm(s, ym, isC); if (o !== ym) shift.push({ store: s, to: o }); }
    res.json({ success: true, data: { default_ym: def, cutoff: cut, ym, shift } });
  } catch (e) { fail(res, e); }
});
// ── 📒 帳本明細（2026-10-20）：from～to（最多 12 個月）全部門市每一筆支出，可依門市／科目／區塊／來源／關鍵字篩 ──
router.get('/book', async (req, res) => {
  try {
    const from = String(req.query.from || ''), to = String(req.query.to || from);
    if (!YM.test(from) || !YM.test(to) || to < from) return bad(res, '月份要是 YYYY-MM，且起 ≤ 迄');
    const yms = []; for (let m = from; m <= to && yms.length < 12; m = LP.addYm(m, 1)) yms.push(m);
    const months = [];
    for (const ym of yms) months.push(await MR.bookMonth(ym, { fresh: req.query.fresh === '1' && ym === yms[yms.length - 1] }));
    const f = { store: String(req.query.store || ''), code: String(req.query.code || ''), group: String(req.query.group || ''), source: String(req.query.source || ''), subject: String(req.query.subject || ''), q: String(req.query.q || '').trim() };
    let lines = months.flatMap((m) => m.lines);
    if (f.store) lines = lines.filter((l) => l.store === f.store);
    if (f.code) lines = lines.filter((l) => l.code === f.code);
    if (f.group) lines = lines.filter((l) => l.group === f.group);
    if (f.source) lines = lines.filter((l) => l.source_name === f.source || l.source === f.source);
    if (f.subject) lines = lines.filter((l) => l.subject_id === f.subject);
    if (f.q) lines = lines.filter((l) => `${l.ref_title || ''} ${l.name} ${l.store_name} ${l.subject_name || ''}`.includes(f.q));
    const byCode = {}, byStore = {}, bySource = {}, bySubject = {};
    for (const l of lines) {
      const c = (byCode[l.code] = byCode[l.code] || { code: l.code, name: l.name, group: l.group, group_name: l.group_name, months: {}, total: 0 });
      c.months[l.ym] = (c.months[l.ym] || 0) + l.amount; c.total += l.amount;
      const s = (byStore[l.store] = byStore[l.store] || { store: l.store, store_name: l.store_name, months: {}, total: 0 });
      s.months[l.ym] = (s.months[l.ym] || 0) + l.amount; s.total += l.amount;
      bySource[l.source_name] = (bySource[l.source_name] || 0) + l.amount;
      const sk = l.subject_id || `none:${l.code}`;
      const sj = (bySubject[sk] = bySubject[sk] || { subject_id: l.subject_id || null, name: l.subject_name || l.name, code: l.code, code_name: l.name, months: {}, total: 0, unset: 0 });
      sj.months[l.ym] = (sj.months[l.ym] || 0) + l.amount; sj.total += l.amount; if (!l.subject_set) sj.unset += l.amount;
    }
    const total = lines.reduce((t, l) => t + l.amount, 0);
    res.json({ success: true, data: {
      months: yms, total, count: lines.length,
      by_code: Object.values(byCode).sort((a, b) => b.total - a.total),
      by_store: Object.values(byStore).sort((a, b) => b.total - a.total),
      by_subject: Object.values(bySubject).sort((a, b) => b.total - a.total),
      by_source: Object.entries(bySource).map(([k, v]) => ({ source: k, amount: v })).sort((a, b) => b.amount - a.amount),
      lines: lines.sort((a, b) => b.ym.localeCompare(a.ym) || String(a.store_name).localeCompare(String(b.store_name), 'zh-Hant') || b.amount - a.amount).slice(0, 3000),
      truncated: lines.length > 3000, errors: months.flatMap((m) => m.errors.map((e) => ({ ...e, ym: m.ym }))),
    } });
  } catch (e) { fail(res, e); }
});

router.delete('/manual/:id', canEdit, async (req, res) => {
  try {
    const { data: m } = await supabase.from('ledger_manual_entries').select('store_erpid, report_ym').eq('id', req.params.id).maybeSingle();
    if (!m) return bad(res, '找不到', 404);
    if (await closed(m.store_erpid, m.report_ym)) return bad(res, '這個月已關帳', 409);
    const { error } = await supabase.from('ledger_manual_entries').update({ void_at: new Date().toISOString(), void_by: who(req) }).eq('id', req.params.id).is('void_at', null);
    if (error) throw error;
    res.json({ success: true });
  } catch (e) { fail(res, e); }
});

router.post('/report/retained', canEdit, async (req, res) => {
  try {
    const store = String((req.body || {}).store || ''), ym = String((req.body || {}).ym || '');
    if (!store || !YM.test(ym)) return bad(res, '缺門市／月份');
    if (await closed(store, ym)) return bad(res, '這個月已關帳', 409);
    const v = req.body.amount;
    const amount = v === null || v === '' || v === undefined ? null : Number(v);
    if (amount !== null && !Number.isFinite(amount)) return bad(res, '金額不對');
    const { error } = await supabase.from('store_month_reports').upsert({ store_erpid: store, ym, retained_amount: amount, updated_at: new Date().toISOString() }, { onConflict: 'store_erpid,ym' });
    if (error) throw error;
    res.json({ success: true });
  } catch (e) { fail(res, e); }
});

router.get('/fixed', async (req, res) => {
  try {
    let q = supabase.from('store_fixed_items').select('*').order('store_erpid').order('from_ym');
    if (req.query.store) q = q.eq('store_erpid', String(req.query.store));
    const { data, error } = await q; if (error) throw error;
    res.json({ success: true, data });
  } catch (e) { fail(res, e); }
});
router.post('/fixed', canEdit, async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.store || !['marketing_fund', 'depreciation'].includes(b.ledger_code)) return bad(res, '缺門市或科目（行銷基金／折舊）');
    if (!YM.test(String(b.from_ym || '')) || (b.to_ym && !YM.test(String(b.to_ym)))) return bad(res, '起訖月份要是 YYYY-MM');
    const amount = Number(b.amount); if (!Number.isFinite(amount)) return bad(res, '金額不對');
    const { data, error } = await supabase.from('store_fixed_items').insert({ store_erpid: String(b.store), ledger_code: b.ledger_code, amount, from_ym: b.from_ym, to_ym: b.to_ym || null, note: b.note || null, created_by: who(req) }).select().single();
    if (error) throw error;
    res.json({ success: true, data });
  } catch (e) { fail(res, e); }
});
router.delete('/fixed/:id', canEdit, async (req, res) => {
  try { const { error } = await supabase.from('store_fixed_items').delete().eq('id', req.params.id); if (error) throw error; res.json({ success: true }); } catch (e) { fail(res, e); }
});


// ── 查帳提醒 ──
router.get('/audit', async (req, res) => {
  try { res.json({ success: true, data: await MA.audit(String(req.query.ym || ''), { fresh: req.query.fresh === '1' }) }); } catch (e) { fail(res, e); }
});
router.post('/audit/ack', canEdit, async (req, res) => {
  try {
    const b = req.body || {};
    const store = String(b.store || ''), ym = String(b.ym || ''), key = String(b.rule_key || '');
    if (!store || !YM.test(ym) || !key) return bad(res, '缺門市／月份／規則');
    const status = ['ok', 'fixed', 'follow'].includes(b.status) ? b.status : 'ok';
    const row = { store_erpid: store, ym, rule_key: key, status, note: b.note ? String(b.note).slice(0, 500) : null, created_by: who(req) };
    const { data, error } = await supabase.from('ledger_audit_acks').upsert(row, { onConflict: 'store_erpid,ym,rule_key' }).select().single();
    if (error) throw error;
    res.json({ success: true, data });
  } catch (e) { fail(res, e); }
});
router.delete('/audit/ack/:id', canEdit, async (req, res) => {
  try {
    const { error } = await supabase.from('ledger_audit_acks').delete().eq('id', req.params.id);
    if (error) throw error;
    res.json({ success: true });
  } catch (e) { fail(res, e); }
});
router.post('/audit/explain', async (req, res) => {
  try {
    const b = req.body || {};
    if (!YM.test(String(b.ym || '')) || !b.store) return bad(res, '缺門市／月份');
    res.json({ success: true, data: await MA.explain(String(b.ym), String(b.store)) });
  } catch (e) { fail(res, e.response ? new Error(`AI：${e.response.status}`) : e); }
});


// ── 關帳流程（2026-10-20）：整理中 draft → 待審閱 review（會計送）→ 已關帳 closed（Louis）；重開要寫原因 ──
// 營運定案：店長關帳後才看得到月報、寫心得（看的入口在市場部店長評核 /sm，經 /api/external/store-report）
const isBoss = (req) => req.user && req.user.role === 'super_admin';
router.post('/report/status', canEdit, async (req, res) => {
  try {
    const b = req.body || {};
    const ym = String(b.ym || ''), action = String(b.action || '');
    if (!YM.test(ym)) return bad(res, '月份要是 YYYY-MM');
    if (!['submit', 'close', 'reopen'].includes(action)) return bad(res, 'action 要是 submit／close／reopen');
    if ((action === 'close' || action === 'reopen') && !isBoss(req)) return bad(res, '關帳／重開只有最高管理者可以做', 403);
    if (action === 'reopen' && !String(b.reason || '').trim()) return bad(res, '重開一定要寫原因');
    let stores = b.stores;
    if (stores === 'all') stores = (await MR.overview(ym)).stores.map((s) => s.store);
    if (!Array.isArray(stores) || !stores.length) return bad(res, '缺門市');
    const now = new Date().toISOString(), by = who(req);
    const { data: cur } = await supabase.from('store_month_reports').select('store_erpid, status, snapshot->imported').eq('ym', ym).in('store_erpid', stores.map(String));
    const st = Object.fromEntries((cur || []).map((r) => [r.store_erpid, r.status]));
    const imp = Object.fromEntries((cur || []).map((r) => [r.store_erpid, !!r.imported]));
    const out = [];
    for (const store of stores.map(String)) {
      const s0 = st[store] || 'draft';
      try {
        if (action === 'submit') {
          if (s0 !== 'draft') { out.push({ store, skip: `目前是 ${s0}` }); continue; }
          await supabase.from('store_month_reports').upsert({ store_erpid: store, ym, status: 'review', submitted_by: by, submitted_at: now, updated_at: now }, { onConflict: 'store_erpid,ym' });
        } else if (action === 'close') {
          if (s0 === 'closed') { out.push({ store, skip: '已關帳' }); continue; }
          const snap = await MR.build(ym, store, { withLines: true });
          snap.snapshot_at = now;
          await supabase.from('store_month_reports').upsert({ store_erpid: store, ym, status: 'closed', snapshot: snap, closed_by: by, closed_at: now, updated_at: now }, { onConflict: 'store_erpid,ym' });
        } else {
          if (s0 !== 'closed') { out.push({ store, skip: `目前是 ${s0}` }); continue; }
          // 試算表匯入的月份不能重開（重開後再關帳會變成系統串聯的數字、試算表的就不見了）；要修正：之後月份記調帳，或重新匯入試算表
          if (imp[store]) { out.push({ store, skip: '這個月是試算表匯入的，不能重開；要修正請在之後的月份記調帳，或改試算表後重新匯入' }); continue; }
          await supabase.from('store_month_reports').update({ status: 'draft', reopened_by: by, reopened_at: now, reopen_reason: String(b.reason).slice(0, 500), updated_at: now }).eq('store_erpid', store).eq('ym', ym);
        }
        out.push({ store, ok: true });
      } catch (e) { out.push({ store, error: e.message }); }
    }
    res.json({ success: true, data: { action, ym, results: out, done: out.filter((x) => x.ok).length } });
  } catch (e) { fail(res, e); }
});
router.post('/report/reviewer-note', canEdit, async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.store || !YM.test(String(b.ym || ''))) return bad(res, '缺門市／月份');
    const { error } = await supabase.from('store_month_reports').upsert({ store_erpid: String(b.store), ym: String(b.ym), reviewer_note: b.note ? String(b.note).slice(0, 2000) : null, updated_at: new Date().toISOString() }, { onConflict: 'store_erpid,ym' });
    if (error) throw error;
    res.json({ success: true });
  } catch (e) { fail(res, e); }
});


// ── 科目與廠商（2026-10-20）：新科目、廠商／會計科目對應到月報哪一格 ──
// 帳單歸格順序（ledger_lines）：分攤列 ledger_code → 帳單 → 廠商的會計科目 accounting_categories → 廠商 billing_sources → 「其他」
const GROUPS = ['opex', 'planning', 'ads', 'misc', 'frame', 'lens', 'contact'];
router.get('/mapping', async (req, res) => {
  try {
    const since = new Date(Date.now() - 120 * 864e5).toISOString();
    const [{ data: srcs }, { data: cats }, { data: bills }] = await Promise.all([
      supabase.from('billing_sources').select('id, name, short_name, source_type, ledger_code, is_active').order('source_type').order('name'),
      supabase.from('accounting_categories').select('id, source_id, name, ledger_code, is_active, sort_order').order('sort_order'),
      supabase.from('bills').select('source_id, accounting_category_id, total_amount').gte('created_at', since).is('void_at', null),
    ]);
    const cnt = {};
    for (const b of bills || []) { const k = `${b.source_id}|${b.accounting_category_id || ''}`; cnt[k] = (cnt[k] || 0) + 1; cnt[`${b.source_id}|*`] = (cnt[`${b.source_id}|*`] || 0) + 1; }
    res.json({ success: true, data: (srcs || []).map((s) => ({ ...s, bills_120d: cnt[`${s.id}|*`] || 0,
      categories: (cats || []).filter((c) => c.source_id === s.id).map((c) => ({ ...c, bills_120d: cnt[`${s.id}|${c.id}`] || 0 })) })) });
  } catch (e) { fail(res, e); }
});
const okCode = async (code) => { if (code === null || code === '') return true; const { data } = await supabase.from('ledger_accounts').select('code').eq('code', code).maybeSingle(); return !!data; };
router.patch('/mapping/source/:id', canEdit, async (req, res) => {
  try {
    const code = (req.body || {}).ledger_code || null;
    if (!(await okCode(code))) return bad(res, '沒有這個科目');
    const { error } = await supabase.from('billing_sources').update({ ledger_code: code }).eq('id', req.params.id);
    if (error) throw error; res.json({ success: true });
  } catch (e) { fail(res, e); }
});
router.patch('/mapping/category/:id', canEdit, async (req, res) => {
  try {
    const code = (req.body || {}).ledger_code || null;
    if (!(await okCode(code))) return bad(res, '沒有這個科目');
    const { error } = await supabase.from('accounting_categories').update({ ledger_code: code }).eq('id', req.params.id);
    if (error) throw error; res.json({ success: true });
  } catch (e) { fail(res, e); }
});
// 倉庫開帳 → 月報哪一格（2026-10-20）：預設（撥補／出貨）＋各撥補區塊、各出貨倉別；區塊名稱從近 3 個月倉庫資料抓
router.get('/storehouse-map', async (req, res) => {
  try {
    const { data: row } = await supabase.from('report_settings').select('value').eq('key', 'storehouse_ledger').maybeSingle();
    const ledger = { replen: MR.SH_DEFAULT, ship: MR.SH_DEFAULT, frame: 'frame_hq', manual_frame: 'frame_hq', manual_misc: 'consumables', sections: {}, warehouses: {}, misc_names: { '工程修繕': 'repair' }, ...((row && row.value) || {}) };
    const now = new Date(Date.now() + 8 * 3600e3);
    const yms = [0, 1, 2].map((k) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - k, 1)).toISOString().slice(0, 7));
    const months = await Promise.all(yms.map((ym) => MR.storehouseMonth(ym)));
    const sec = {}, wh = {}, err = months.map((m) => m.error).filter(Boolean)[0] || null;
    for (const m of months) {
      const lines = [...Object.values(m.byStore || {}).flat(), ...(m.issues || []).filter((i) => i.kind === 'unmapped').map((i) => i.line)];
      for (const l of lines) for (const i of l.items || []) {
        if (l.src === 'frame' || l.src === 'manual_frame' || l.src === 'manual_misc') continue;   // 鏡框／匯入雜費各自一格，不分區
        const k = (l.src === 'ship' ? i.warehouse : i.section) || '（未分區）';
        const t = l.src === 'ship' ? wh : sec;
        t[k] = (t[k] || 0) + (Number(i.qty) || 0) * (Number(i.price) || 0);
      }
    }
    for (const k of Object.keys(ledger.sections || {})) if (!(k in sec)) sec[k] = 0;
    for (const k of Object.keys(ledger.warehouses || {})) if (!(k in wh)) wh[k] = 0;
    const list = (o) => Object.entries(o).sort((a, b) => b[1] - a[1]).map(([name, amount]) => ({ name, amount: Math.round(amount) }));
    res.json({ success: true, data: { ledger, sections: list(sec), warehouses: list(wh), months: yms, error: err } });
  } catch (e) { fail(res, e); }
});
router.put('/storehouse-map', canEdit, async (req, res) => {
  try {
    const b = req.body || {};
    const clean = async (o) => { const r = {}; for (const [k, v] of Object.entries(o || {})) { if (!v) continue; if (!(await okCode(v))) throw Object.assign(new Error(`沒有這個科目：${v}`), { status: 400 }); r[String(k).slice(0, 40)] = v; } return r; };
    const replen = b.replen || MR.SH_DEFAULT, ship = b.ship || MR.SH_DEFAULT;
    const frame = b.frame || 'frame_hq', manual_frame = b.manual_frame || 'frame_hq', manual_misc = b.manual_misc || 'consumables';
    for (const c of [replen, ship, frame, manual_frame, manual_misc]) if (!(await okCode(c))) return bad(res, '沒有這個科目');
    const value = { replen, ship, frame, manual_frame, manual_misc, sections: await clean(b.sections), warehouses: await clean(b.warehouses), misc_names: await clean(b.misc_names) };
    const { error } = await supabase.from('report_settings').upsert({ key: 'storehouse_ledger', value, updated_at: new Date().toISOString() }, { onConflict: 'key' });
    if (error) throw error;
    MR.clearStorehouseCache();
    res.json({ success: true, data: value });
  } catch (e) { if (e.status === 400) return bad(res, e.message); fail(res, e); }
});
router.post('/accounts', canEdit, async (req, res) => {
  try {
    const b = req.body || {};
    const name = String(b.name || '').trim();
    if (!name) return bad(res, '要填科目名稱');
    const isRev = b.group_code === 'revenue';   // 2026-10-20：會計也能加收入科目（手填，算進獲利用的實收）
    if (!isRev && !GROUPS.includes(b.group_code)) return bad(res, '要選放在月報哪一區');
    const { data: same } = await supabase.from('ledger_accounts').select('code').eq('name', name).maybeSingle();
    if (same) return bad(res, `已經有「${name}」這個科目了`);
    const { data: last } = await supabase.from('ledger_accounts').select('sort_order').eq('group_code', b.group_code).order('sort_order', { ascending: false }).limit(1).maybeSingle();
    const code = `x_${Date.now().toString(36)}`;
    const row = { code, name, group_code: b.group_code, kind: isRev ? 'revenue' : 'expense', ratio_group: isRev ? null : (b.ratio_group || null),
      auto_source: isRev || b.auto_source === 'manual' ? 'manual' : 'bill', sort_order: ((last && last.sort_order) || 0) + 1, is_active: true,
      note: `新增於 ${new Date().toISOString().slice(0, 10)}，${who(req)}` };
    const { data, error } = await supabase.from('ledger_accounts').insert(row).select().single();
    if (error) throw error;
    if (row.kind === 'expense') await LS.ensureDefault(code, name);
    res.json({ success: true, data });
  } catch (e) { fail(res, e); }
});
router.patch('/accounts/:code', canEdit, async (req, res) => {
  try {
    const b = req.body || {}, up = {};
    if (b.name !== undefined) { if (!String(b.name).trim()) return bad(res, '名稱不能空白'); up.name = String(b.name).trim(); }
    if (b.ratio_group !== undefined) up.ratio_group = b.ratio_group || null;
    if (b.is_active !== undefined) up.is_active = !!b.is_active;
    if (b.sort_order !== undefined) up.sort_order = Number(b.sort_order) || 0;
    if (b.group_code !== undefined) { if (!GROUPS.includes(b.group_code)) return bad(res, '區不對'); up.group_code = b.group_code; }
    if (up.is_active === false) {
      const { count } = await supabase.from('bill_allocations').select('id', { count: 'exact', head: true }).eq('ledger_code', req.params.code);
      if (count) return bad(res, `還有 ${count} 筆帳指定這個科目，先改掉再停用`);
    }
    const { error } = await supabase.from('ledger_accounts').update(up).eq('code', req.params.code);
    if (error) throw error; res.json({ success: true });
  } catch (e) { fail(res, e); }
});


// ── 門市基礎設定（2026-10-20，C2）：一家店一頁＝基本資料（房租／電／水／電話網路／金雞）＋房租合約＋固定支出與付款狀態＋行銷基金折舊＋股東 ──
const HIDE_KEYS = /pass|pwd|密碼/i;   // 網路密碼等不回前端（安全待修 #7：之後改加密存放）
router.get('/store-profile', async (req, res) => {
  try {
    const store = String(req.query.store || '');
    if (!store) return bad(res, '缺門市');
    const ym = YM.test(String(req.query.ym || '')) ? String(req.query.ym) : new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 7);
    const [{ data: dept }, { data: cats }, { data: fields }, { data: facts }, { data: cons }, { data: recs }, { data: fixed }, { data: holders }] = await Promise.all([
      supabase.from('departments').select('store_erpid, store_name, report_kind').eq('store_erpid', store).maybeSingle(),
      supabase.from('entity_fact_categories').select('id, name, icon'),
      supabase.from('entity_fact_fields').select('category_id, field_key, field_label, sort_order').order('sort_order'),
      supabase.from('entity_facts').select('id, category_id, data, note, updated_at').eq('store_erpid', store),
      supabase.from('contracts').select('id, type, name, purpose, status, start_date, end_date, monthly_amount, type_data, party_name, renewed_from, payment, note').eq('store_erpid', store).order('start_date', { ascending: false }),
      supabase.from('recurring_expenses').select('id, name, amount, payment_method, payee_name, cycle_day, ledger_code, period_text, is_active, contract_id, contract_share').eq('store_erpid', store),
      supabase.from('store_fixed_items').select('*').eq('store_erpid', store).order('from_ym'),
      supabase.from('store_shareholders').select('*').eq('store_erpid', store),
    ]);
    const catName = Object.fromEntries((cats || []).map((c) => [c.id, c.name]));
    const basics = (facts || []).map((f) => {
      const fl = (fields || []).filter((x) => x.category_id === f.category_id);
      const rows = fl.filter((x) => f.data && f.data[x.field_key] != null && String(f.data[x.field_key]).trim() !== '')
        .map((x) => ({ key: x.field_key, label: x.field_label, value: HIDE_KEYS.test(x.field_key) ? '（已存，不顯示）' : f.data[x.field_key] }));
      return { id: f.id, category: catName[f.category_id] || '其他', rows, updated_at: f.updated_at };
    });
    const ids = (recs || []).map((r) => r.id);
    const { data: pays } = ids.length ? await supabase.from('recurring_expense_payments').select('id, expense_id, year_month, amount, status, due_date, paid_at, pay_method, check_no, check_issue_date, check_due_date, check_cashed_date, check_note')
      .in('expense_id', ids).gte('year_month', (() => { const [y, m] = ym.split('-').map(Number); const d = new Date(Date.UTC(y, m - 6, 1)); return d.toISOString().slice(0, 7); })())
      .lte('year_month', ym).order('year_month') : { data: [] };
    const today = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
    const contracts = (cons || []).map((c) => ({ ...c, this_month: c.type === 'rent' ? MR.rentForMonth(c, ym) : null,
      days_left: c.end_date ? Math.round((Date.parse(c.end_date) - Date.parse(today)) / 864e5) : null }));
    // 支票（既有支票紀錄系統）：這家店的科目＋連到這家店合約的批次；前 6 個月到後 6 個月
    const conIds = (cons || []).map((c) => c.id);
    const [{ data: subs }, { data: cbs }] = await Promise.all([
      supabase.from('check_subjects').select('id, name, parent_id, store_erpid, is_active'),
      conIds.length ? supabase.from('check_batches').select('id').in('contract_id', conIds) : Promise.resolve({ data: [] }),
    ]);
    const mySubs = (subs || []).filter((x) => x.store_erpid === store).map((x) => x.id);
    const subName = Object.fromEntries((subs || []).map((x) => [x.id, x.name]));
    const rentParent = (subs || []).find((x) => !x.parent_id && x.name === '房租');
    let batches = [];
    const bIds = new Set((cbs || []).map((x) => x.id));
    const q = supabase.from('check_batches').select('id, batch_no, subject_id, drawer_name, bank_name, status, notes, contract_id');
    const { data: bs } = mySubs.length || bIds.size
      ? await (mySubs.length && bIds.size ? q.or(`subject_id.in.(${mySubs.join(',')}),id.in.(${[...bIds].join(',')})`) : mySubs.length ? q.in('subject_id', mySubs) : q.in('id', [...bIds]))
      : { data: [] };
    if ((bs || []).length) {
      const [y, m] = ym.split('-').map(Number);
      const from = new Date(Date.UTC(y, m - 7, 1)).toISOString().slice(0, 10), to = new Date(Date.UTC(y, m + 6, 0)).toISOString().slice(0, 10);
      const { data: cks } = await supabase.from('checks').select('id, batch_id, check_no, amount, due_date, status, paid_at')
        .in('batch_id', bs.map((b) => b.id)).gte('due_date', from).lte('due_date', to).order('due_date');
      const { data: pend } = await supabase.from('checks').select('batch_id, due_date').in('batch_id', bs.map((b) => b.id)).eq('status', 'pending');
      batches = bs.map((b) => {
        const pd = (pend || []).filter((x) => x.batch_id === b.id).map((x) => x.due_date).sort();
        return { ...b, subject: subName[b.subject_id] || '', checks: (cks || []).filter((c) => c.batch_id === b.id), pending: pd.length, last_due: pd[pd.length - 1] || null };
      }).filter((b) => b.checks.length || b.pending).sort((a, b) => String(b.last_due || '').localeCompare(String(a.last_due || '')));
    }
    const unmappedRent = (subs || []).filter((x) => rentParent && x.parent_id === rentParent.id && !x.store_erpid && x.is_active).map((x) => ({ id: x.id, name: x.name }));
    res.json({ success: true, data: {
      store, store_name: dept ? dept.store_name : store, ym, basics, contracts,
      checks: { batches, subjects: (subs || []).filter((x) => x.store_erpid === store).map((x) => ({ id: x.id, name: x.name })), unmapped_rent: unmappedRent },
      recurring: (recs || []).map((r) => ({ ...r, payments: (pays || []).filter((p) => p.expense_id === r.id) })),
      fixed: fixed || [], shareholders: holders || [],
    } });
  } catch (e) { fail(res, e); }
});

// ── Excel 匯入月報手填值（2026-10-20）──
// 欄位：門市（名稱或 ERP 編號）｜月份 YYYY-MM｜科目（名稱或代碼）｜金額｜方式（手填／調帳，空白＝手填）｜廠商｜備註（調帳必填）
// 先 ?dry=1 預覽（每列檢查結果），確認後不帶 dry 寫入；手填同格舊值作廢留紀錄；已關帳的月份整列擋
const multer = require('multer');
const xlsUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });
router.get('/import/template', async (req, res) => {
  try {
    const XLSX = require('xlsx');
    const accs = await MR.accounts();
    const { data: deps } = await supabase.from('departments').select('store_erpid, store_name').eq('report_kind', 'store').order('store_name');
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['門市', '月份', '科目', '金額', '方式', '廠商', '備註'], ['文化店', '2026-09', '勞健保', 12345, '手填', '', '']]), '匯入');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['科目', '代碼', '類型'], ...accs.filter((a) => a.kind !== 'info').map((a) => [a.name, a.code, a.kind === 'revenue' ? '收入' : '支出'])]), '科目清單');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['門市', 'ERP 編號'], ...(deps || []).map((d) => [d.store_name, d.store_erpid])]), '門市清單');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', "attachment; filename*=UTF-8''" + encodeURIComponent('月報匯入範本.xlsx'));
    res.send(buf);
  } catch (e) { fail(res, e); }
});
router.post('/import', canEdit, xlsUpload.single('file'), async (req, res) => {
  try {
    if (!req.file) return bad(res, '請上傳 Excel');
    const XLSX = require('xlsx');
    const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '' });
    if (rows.length < 2) return bad(res, 'Excel 是空的');
    const head = rows[0].map((h) => String(h).trim());
    const col = (names) => head.findIndex((h) => names.includes(h));
    const C = { store: col(['門市', '門市編號']), ym: col(['月份', '月報月份']), acc: col(['科目', '科目代碼']), amt: col(['金額']), type: col(['方式']), vendor: col(['廠商']), note: col(['備註', '原因']) };
    if (C.store < 0 || C.ym < 0 || C.acc < 0 || C.amt < 0) return bad(res, '第一列要有：門市、月份、科目、金額（可下載範本）');
    const accs = await MR.accounts();
    const accBy = new Map(); accs.filter((a) => a.kind !== 'info').forEach((a) => { accBy.set(a.code, a); accBy.set(a.name, a); });
    const { data: deps } = await supabase.from('departments').select('store_erpid, store_name');
    const norm = (x) => String(x || '').replace(/^愛民眼鏡/, '').replace(/\s+/g, '').replace(/店$/, '');
    const depBy = new Map(); (deps || []).forEach((d) => { depBy.set(String(d.store_erpid), d); depBy.set(norm(d.store_name), d); });
    const ymOf = (v) => { if (typeof v === 'number') { const d = XLSX.SSF.parse_date_code(v); return d ? `${d.y}-${String(d.m).padStart(2, '0')}` : ''; } const m = String(v).trim().match(/^(\d{4})[-/.年](\d{1,2})/); return m ? `${m[1]}-${String(m[2]).padStart(2, '0')}` : ''; };
    const closedCache = new Map();
    const out = [];
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i]; if (!r || r.every((x) => String(x).trim() === '')) continue;
      const rawStore = String(r[C.store]).trim(), dep = depBy.get(rawStore) || depBy.get(norm(rawStore));
      const ym = ymOf(r[C.ym]); const a = accBy.get(String(r[C.acc]).trim());
      const amount = Number(String(r[C.amt]).replace(/[,，\s元]/g, ''));
      const type = C.type >= 0 && /調/.test(String(r[C.type])) ? 'adjust' : 'value';
      const vendor = C.vendor >= 0 ? String(r[C.vendor]).trim() || null : null;
      const note = C.note >= 0 ? String(r[C.note]).trim() : '';
      const errs = [];
      if (!dep) errs.push(`門市「${rawStore}」對不到`);
      if (!YM.test(ym)) errs.push('月份要是 2026-09 這種格式');
      if (!a) errs.push(`科目「${r[C.acc]}」對不到`);
      else if (a.kind === 'info') errs.push('業績格不能手填');
      if (!Number.isFinite(amount) || String(r[C.amt]).trim() === '') errs.push('金額不對');
      if (type === 'adjust' && !note) errs.push('調帳一定要寫原因（備註欄）');
      if (dep && YM.test(ym)) {
        const k = dep.store_erpid + '|' + ym;
        if (!closedCache.has(k)) closedCache.set(k, await closed(dep.store_erpid, ym));
        if (closedCache.get(k)) errs.push('這個月已關帳');
      }
      out.push({ row: i + 1, store: dep ? dep.store_erpid : rawStore, store_name: dep ? dep.store_name : rawStore, ym, code: a ? a.code : null, account: a ? a.name : String(r[C.acc]), amount, type, vendor, note, errors: errs });
    }
    const bad2 = out.filter((x) => x.errors.length);
    if (req.query.dry === '1' || bad2.length) return res.json({ success: true, data: { dry: true, rows: out, ok: out.length - bad2.length, bad: bad2.length } });
    let done = 0;
    for (const x of out) {
      if (x.type === 'value') {
        let q = supabase.from('ledger_manual_entries').update({ void_at: new Date().toISOString(), void_by: who(req) })
          .eq('store_erpid', x.store).eq('report_ym', x.ym).eq('ledger_code', x.code).eq('entry_type', 'value').is('void_at', null);
        q = x.vendor ? q.eq('vendor', x.vendor) : q.is('vendor', null);
        const { error: e1 } = await q; if (e1) throw e1;
      }
      const { error } = await supabase.from('ledger_manual_entries').insert({ entry_type: x.type, store_erpid: x.store, report_ym: x.ym, ledger_code: x.code, amount: x.amount,
        vendor: x.vendor, reason: x.note ? `Excel 匯入：${x.note}` : 'Excel 匯入', files: [], created_by: who(req) });
      if (error) throw error; done += 1;
    }
    res.json({ success: true, data: { dry: false, done } });
  } catch (e) { fail(res, e); }
});

// ── 刷卡手續費費率（2026-10-20）：ERP 付款方式 × 費率％＋每筆固定 → 月報「刷卡手續費」自動算 ──
router.get('/card-fee-rates', async (req, res) => {
  try {
    const ym = YM.test(String(req.query.ym || '')) ? String(req.query.ym) : null;
    const st = await MR.settings();
    const seen = {};
    if (ym) {
      const mk = await MR.marketMonth(ym);
      for (const v of Object.values(mk.stores || {})) for (const x of ((v.cashflow || {}).by || [])) {
        const k = String(x.code); const t = (seen[k] = seen[k] || { code: k, name: x.name, amount: 0, n: 0, stores: 0 });
        t.amount += Number(x.amount) || 0; t.n += Number(x.n) || 0; t.stores += 1;
      }
    }
    const rates = st.card_fee_rates || {};
    const codes = [...new Set([...Object.keys(rates), ...Object.keys(seen)])];
    res.json({ success: true, data: codes.map((c) => ({ code: c, name: (rates[c] && rates[c].name) || (seen[c] && seen[c].name) || c,
      rate: rates[c] ? rates[c].rate : null, per_txn: rates[c] ? rates[c].per_txn || 0 : null, set: !!rates[c],
      amount: seen[c] ? Math.round(seen[c].amount) : null, n: seen[c] ? seen[c].n : null })).sort((a, b) => (b.amount || 0) - (a.amount || 0)) });
  } catch (e) { fail(res, e); }
});
router.put('/card-fee-rates', canEdit, async (req, res) => {
  try {
    const list = Array.isArray((req.body || {}).rates) ? req.body.rates : null;
    if (!list) return bad(res, '缺費率');
    const out = {};
    for (const r of list) {
      const code = String(r.code || '').trim(); if (!code) continue;
      if (r.rate === '' || r.rate == null) continue;   // 空白＝不設（月報會提醒）
      const rate = Number(r.rate), per = Number(r.per_txn || 0);
      if (!(rate >= 0 && rate <= 20) || !(per >= 0 && per <= 1000)) return bad(res, `「${r.name || code}」費率不合理（0～20%、每筆 0～1000 元）`);
      out[code] = { name: String(r.name || code).slice(0, 40), rate, per_txn: per };
    }
    const { error } = await supabase.from('report_settings').upsert({ key: 'card_fee_rates', value: out, updated_by: who(req), updated_at: new Date().toISOString() }, { onConflict: 'key' });
    if (error) throw error; res.json({ success: true, data: out });
  } catch (e) { fail(res, e); }
});

// 支票科目綁門市／支票批次綁合約（既有支票紀錄系統，2026-10-20）
router.patch('/check-subjects/:id', canEdit, async (req, res) => {
  try {
    const v = (req.body || {}).store_erpid; const store = v ? String(v) : null;
    if (store) { const { data: d } = await supabase.from('departments').select('store_erpid').eq('store_erpid', store).maybeSingle(); if (!d) return bad(res, '沒有這家門市'); }
    const { error } = await supabase.from('check_subjects').update({ store_erpid: store }).eq('id', req.params.id);
    if (error) throw error; res.json({ success: true });
  } catch (e) { fail(res, e); }
});
router.patch('/check-batches/:id', canEdit, async (req, res) => {
  try {
    const v = (req.body || {}).contract_id; const cid = v ? String(v) : null;
    if (cid) { const { data: c } = await supabase.from('contracts').select('id').eq('id', cid).maybeSingle(); if (!c) return bad(res, '沒有這份合約'); }
    const { error } = await supabase.from('check_batches').update({ contract_id: cid }).eq('id', req.params.id);
    if (error) throw error; res.json({ success: true });
  } catch (e) { fail(res, e); }
});

// ── 股東（2026-10-20）：在「門市基礎設定」設定；月報可分配盈餘依持股比例分（同一期間持股合計不能超過 100%）──
const overlap = (a1, a2, b1, b2) => a1 <= (b2 || '9999-12') && b1 <= (a2 || '9999-12');
// 股東名單＝左手「股東」部門（2026-10-20）；選股東只能從這份名單挑，姓名／客編以左手為準
router.get('/shareholder-roster', async (req, res) => {
  try { res.json({ success: true, data: await require('../services/shareholderRoster').roster(req.query.force === '1') }); } catch (e) { fail(res, e); }
});
router.put('/shareholder-roster/group', canEdit, async (req, res) => {
  try {
    const erpid = String((req.body || {}).erpid || '').trim();
    if (!/^[0-9A-Za-z]{2,20}$/.test(erpid)) return bad(res, '左手部門編號格式不對');
    const R = require('../services/shareholderRoster');
    await R.setGroup(erpid);
    res.json({ success: true, data: await R.roster(true) });
  } catch (e) { fail(res, e); }
});
router.post('/shareholders', canEdit, async (req, res) => {
  try {
    const b = req.body || {};
    const store = String(b.store || '');
    const shares = Math.round(Number(b.shares) * 1000) / 1000;   // 可以有小數（1.5%）
    const ro = await require('../services/shareholderRoster').roster(false);
    const person = (ro.list || []).find((x) => x.erpid === String(b.erpid || ''));
    if (!person) return bad(res, '只能選左手的在職人員或「股東」部門的人（名單沒有這位）');
    const name = person.name;
    b.app_number = person.app_number;
    if (!store) return bad(res, '缺門市');
    if (!(shares > 0 && shares <= 100)) return bad(res, '持股要大於 0、最多 100（%），可以有小數');
    if (!YM.test(String(b.from_ym || '')) || (b.to_ym && !YM.test(String(b.to_ym)))) return bad(res, '起訖月份要是 YYYY-MM');
    const { data: cur } = await supabase.from('store_shareholders').select('shares, from_ym, to_ym').eq('store_erpid', store);
    const sum = (cur || []).filter((h) => overlap(h.from_ym, h.to_ym, b.from_ym, b.to_ym || null)).reduce((a, h) => a + Number(h.shares), 0);
    if (Math.round((sum + shares) * 1000) > 100000) return bad(res, `同一期間持股合計會變成 ${sum + shares}%，超過 100%`);
    const { data, error } = await supabase.from('store_shareholders').insert({ store_erpid: store, name, erpid: b.erpid || null, app_number: b.app_number || null,
      shares, from_ym: b.from_ym, to_ym: b.to_ym || null, created_by: who(req) }).select().single();
    if (error) throw error;
    require('../services/shareholderRoster').resync().catch((e) => console.warn('[shareholders] portal 同步', e.message));
    res.json({ success: true, data });
  } catch (e) { fail(res, e); }
});
router.patch('/shareholders/:id', canEdit, async (req, res) => {
  try {
    const b = req.body || {}, up = {};
    if (b.to_ym !== undefined) { if (b.to_ym && !YM.test(String(b.to_ym))) return bad(res, '月份要是 YYYY-MM'); up.to_ym = b.to_ym || null; }
    if (!Object.keys(up).length) return bad(res, '沒有要改的（持股比例要改請設結束月份、再新增一筆）');
    const { error } = await supabase.from('store_shareholders').update(up).eq('id', req.params.id);
    if (error) throw error;
    require('../services/shareholderRoster').resync().catch((e) => console.warn('[shareholders] portal 同步', e.message));
    res.json({ success: true });
  } catch (e) { fail(res, e); }
});
router.delete('/shareholders/:id', canEdit, async (req, res) => {
  try {
    const { error } = await supabase.from('store_shareholders').delete().eq('id', req.params.id); if (error) throw error;
    require('../services/shareholderRoster').resync().catch((e) => console.warn('[shareholders] portal 同步', e.message));
    res.json({ success: true });
  } catch (e) { fail(res, e); }
});


// ── 原始憑證（2026-10-21）：只有營運部（operation_*）與超級管理員 ──
//   GET    /api/ledger/vouchers?ref_type=bill&ref_id=…   列出（簽名網址 1 小時）
//   POST   /api/ledger/vouchers  multipart files[]＋ref_type＋ref_id[＋note]   上傳（照片／PDF，每檔 20MB）
//   DELETE /api/ledger/vouchers/:id                       作廢（留紀錄，檔案不刪）
const voucherGuard = (req, res, next) => (LV.canSee(req.user) ? next() : bad(res, '原始憑證只有營運部與超級管理員看得到', 403));
const voucherUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024, files: 10 } });
router.get('/vouchers', voucherGuard, async (req, res) => {
  try { res.json({ success: true, data: await LV.list(String(req.query.ref_type || ''), String(req.query.ref_id || '')) }); } catch (e) { bad(res, e.message); }
});
router.post('/vouchers', voucherGuard, canEdit, voucherUpload.array('files', 10), async (req, res) => {
  try {
    const t = String((req.body || {}).ref_type || ''), id = String((req.body || {}).ref_id || '');
    if (!(req.files || []).length) return bad(res, '沒有檔案');
    const out = [];
    for (const f of req.files) out.push(await LV.upload(t, id, f, who(req), (req.body || {}).note));
    res.json({ success: true, data: { uploaded: out.length, files: await LV.list(t, id) } });
  } catch (e) { bad(res, e.message); }
});
router.delete('/vouchers/:id', voucherGuard, canEdit, async (req, res) => {
  try { res.json({ success: true, data: await LV.voidOne(req.params.id, who(req)) }); } catch (e) { bad(res, e.message); }
});


// ── 會計科目（2026-10-21）：月報格子底下的細項；手填／調帳／分攤／開帳都要選 ──
//   GET   /api/ledger/subjects[?all=1]        清單（all＝含停用）
//   POST  /api/ledger/subjects {ledger_code, name, note}
//   PATCH /api/ledger/subjects/:id {name, is_active, sort_order, note}
//   PATCH /api/ledger/manual/:id/subject {subject_id}   補選手填／調帳／分攤（分攤整組一起改）
//   PATCH /api/ledger/bill/:id/subject {subject_id}     改帳單的科目（月報格子跟著換；有月份已關帳就不能換格子）
router.get('/subjects', async (req, res) => {
  try { const v = await LS.all(true); res.json({ success: true, data: req.query.all === '1' ? v : v.filter((s) => s.is_active) }); } catch (e) { fail(res, e); }
});
router.post('/subjects', canEdit, async (req, res) => {
  try { res.json({ success: true, data: await LS.create(req.body || {}, who(req)) }); } catch (e) { bad(res, e.message); }
});
router.patch('/subjects/:id', canEdit, async (req, res) => {
  try { res.json({ success: true, data: await LS.patch(req.params.id, req.body || {}) }); } catch (e) { bad(res, e.message); }
});
router.patch('/manual/:id/subject', canEdit, async (req, res) => {
  try {
    const { data: m } = await supabase.from('ledger_manual_entries').select('id, ledger_code, amort_group, void_at').eq('id', req.params.id).maybeSingle();
    if (!m || m.void_at) return bad(res, '找不到這筆（或已作廢）', 404);
    const s = await LS.mustGet((req.body || {}).subject_id, m.ledger_code);
    let q = supabase.from('ledger_manual_entries').update({ subject_id: s.id });
    q = m.amort_group ? q.eq('amort_group', m.amort_group) : q.eq('id', m.id);
    const { error } = await q; if (error) throw error;
    MR.clearBookCache && MR.clearBookCache();
    res.json({ success: true, data: { subject_id: s.id, subject_name: s.name } });
  } catch (e) { bad(res, e.message); }
});
router.patch('/bill/:id/subject', canEdit, async (req, res) => {
  try {
    const { data: bill } = await supabase.from('bills').select('id, ledger_code, period').eq('id', req.params.id).maybeSingle();
    if (!bill) return bad(res, '找不到帳單', 404);
    const s = await LS.mustGet((req.body || {}).subject_id);
    const { data: als } = await supabase.from('bill_allocations').select('id, store_erpid, report_ym, ledger_code').eq('bill_id', bill.id);
    const changesCell = (als || []).some((a) => (a.ledger_code || bill.ledger_code) !== s.ledger_code);
    if (changesCell) {
      for (const a of als || []) {
        const ym = a.report_ym || bill.period;
        if (ym && await closed(String(a.store_erpid), ym)) return bad(res, `${a.store_erpid} ${ym} 已關帳，不能換到別的月報格子（同一格的科目可以換）`, 409);
      }
      await supabase.from('bill_allocations').update({ ledger_code: null, updated_at: new Date().toISOString() }).eq('bill_id', bill.id);
    }
    const { error } = await supabase.from('bills').update({ subject_id: s.id, ledger_code: s.ledger_code, updated_at: new Date().toISOString() }).eq('id', bill.id);
    if (error) throw error;
    MR.clearBookCache && MR.clearBookCache();
    res.json({ success: true, data: { subject_id: s.id, subject_name: s.name, ledger_code: s.ledger_code } });
  } catch (e) { bad(res, e.message); }
});


// ── 舊月報試算表匯入（2026-10-21）：串聯上線前的月份用試算表當正本，匯入即關帳 ──
//   POST /api/ledger/import-sheet {items:[{store, ym, sheet, meta}], dry, force}（只有最高管理者）
router.post('/import-sheet', async (req, res) => {
  try {
    if (!isBoss(req)) return bad(res, '只有最高管理者可以匯入', 403);
    const b = req.body || {};
    const items = Array.isArray(b.items) ? b.items : [];
    if (!items.length || items.length > 60) return bad(res, '一次 1～60 筆');
    const SI = require('../services/sheetImport');
    const out = [];
    for (const it of items) {
      try { out.push(await SI.importOne(it, who(req), { dry: !!b.dry, force: !!b.force })); } catch (e) { out.push({ store: it.store, ym: it.ym, error: e.message }); }
    }
    if (!b.dry) MR.clearBookCache && MR.clearBookCache();
    res.json({ success: true, data: out });
  } catch (e) { fail(res, e); }
});

module.exports = router;
