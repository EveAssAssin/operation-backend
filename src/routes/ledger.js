// routes/ledger.js —— 門市月報帳本（P0 2026-10-20；P1 月報同日）
// 規劃：app/pet-feature/PLAN_門市月報與開帳_20261020.md
//   GET  /api/ledger/accounts                         科目表
//   POST /api/ledger/accounts、PATCH /accounts/:code   新增／改科目（新科目自動排進月報那一區）
//   POST /api/ledger/shareholders、PATCH|DELETE /shareholders/:id   股東（門市基礎設定裡設）
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
      if (rep && rep.status === 'closed' && rep.snapshot) return res.json({ success: true, data: { ...rep.snapshot, report: { ...rep, snapshot: undefined }, status: 'closed', frozen: true } });
    }
    const data = await MR.build(ym, store, { withLines: true, allRows: req.query.all === '1' });
    res.json({ success: true, data });
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
    const row = { entry_type: type, store_erpid: store, report_ym: ym, fee_ym: b.fee_ym || null, ledger_code: code, amount, vendor, reason: reason || null, files: Array.isArray(b.files) ? b.files : [], created_by: who(req) };
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
    const { data: cur } = await supabase.from('store_month_reports').select('store_erpid, status').eq('ym', ym).in('store_erpid', stores.map(String));
    const st = Object.fromEntries((cur || []).map((r) => [r.store_erpid, r.status]));
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
router.post('/accounts', canEdit, async (req, res) => {
  try {
    const b = req.body || {};
    const name = String(b.name || '').trim();
    if (!name) return bad(res, '要填科目名稱');
    if (!GROUPS.includes(b.group_code)) return bad(res, '要選放在月報哪一區');
    const { data: same } = await supabase.from('ledger_accounts').select('code').eq('name', name).maybeSingle();
    if (same) return bad(res, `已經有「${name}」這個科目了`);
    const { data: last } = await supabase.from('ledger_accounts').select('sort_order').eq('group_code', b.group_code).order('sort_order', { ascending: false }).limit(1).maybeSingle();
    const code = `x_${Date.now().toString(36)}`;
    const row = { code, name, group_code: b.group_code, kind: 'expense', ratio_group: b.ratio_group || null,
      auto_source: b.auto_source === 'manual' ? 'manual' : 'bill', sort_order: ((last && last.sort_order) || 0) + 1, is_active: true,
      note: `新增於 ${new Date().toISOString().slice(0, 10)}，${who(req)}` };
    const { data, error } = await supabase.from('ledger_accounts').insert(row).select().single();
    if (error) throw error; res.json({ success: true, data });
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
    res.json({ success: true, data: {
      store, store_name: dept ? dept.store_name : store, ym, basics, contracts,
      recurring: (recs || []).map((r) => ({ ...r, payments: (pays || []).filter((p) => p.expense_id === r.id) })),
      fixed: fixed || [], shareholders: holders || [],
    } });
  } catch (e) { fail(res, e); }
});


// ── 股東（2026-10-20）：在「門市基礎設定」設定；月報可分配盈餘依持股比例分（同一期間持股合計不能超過 100%）──
const overlap = (a1, a2, b1, b2) => a1 <= (b2 || '9999-12') && b1 <= (a2 || '9999-12');
router.post('/shareholders', canEdit, async (req, res) => {
  try {
    const b = req.body || {};
    const store = String(b.store || ''), name = String(b.name || '').trim();
    const shares = Math.round(Number(b.shares));
    if (!store || !name) return bad(res, '缺門市或姓名');
    if (!(shares >= 1 && shares <= 100)) return bad(res, '持股要是 1～100（%）');
    if (!YM.test(String(b.from_ym || '')) || (b.to_ym && !YM.test(String(b.to_ym)))) return bad(res, '起訖月份要是 YYYY-MM');
    const { data: cur } = await supabase.from('store_shareholders').select('shares, from_ym, to_ym').eq('store_erpid', store);
    const sum = (cur || []).filter((h) => overlap(h.from_ym, h.to_ym, b.from_ym, b.to_ym || null)).reduce((a, h) => a + h.shares, 0);
    if (sum + shares > 100) return bad(res, `同一期間持股合計會變成 ${sum + shares}%，超過 100%`);
    const { data, error } = await supabase.from('store_shareholders').insert({ store_erpid: store, name, erpid: b.erpid || null, app_number: b.app_number || null,
      shares, from_ym: b.from_ym, to_ym: b.to_ym || null, created_by: who(req) }).select().single();
    if (error) throw error; res.json({ success: true, data });
  } catch (e) { fail(res, e); }
});
router.patch('/shareholders/:id', canEdit, async (req, res) => {
  try {
    const b = req.body || {}, up = {};
    if (b.to_ym !== undefined) { if (b.to_ym && !YM.test(String(b.to_ym))) return bad(res, '月份要是 YYYY-MM'); up.to_ym = b.to_ym || null; }
    if (!Object.keys(up).length) return bad(res, '沒有要改的（持股比例要改請設結束月份、再新增一筆）');
    const { error } = await supabase.from('store_shareholders').update(up).eq('id', req.params.id);
    if (error) throw error; res.json({ success: true });
  } catch (e) { fail(res, e); }
});
router.delete('/shareholders/:id', canEdit, async (req, res) => {
  try { const { error } = await supabase.from('store_shareholders').delete().eq('id', req.params.id); if (error) throw error; res.json({ success: true }); } catch (e) { fail(res, e); }
});

module.exports = router;
