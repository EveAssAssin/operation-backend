// routes/regulations.js — 規範系統 API（authenticate 在 app.js 掛）
//
// 規範
//   GET    /                         列表 ?q=&category=&status=
//   GET    /categories               分類清單
//   GET    /clauses                  條文搜尋 ?q=&regulation_id=
//   GET    /:id                      單份（現行內容＋版本＋開著的草稿）
//   GET    /versions/:vid            某一版完整內容
// 編輯
//   POST   /new                      新增一份規範（建草稿）
//   POST   /:id/draft                開始修改（建或取回草稿）
//   GET    /drafts/list              草稿／被退回清單
//   PUT    /versions/:vid            儲存草稿
//   POST   /versions/:vid/preview    預先檢查（差異、風險、規則檢查；不含 AI）
//   POST   /versions/:vid/submit     送審（推播審核人）
//   POST   /versions/:vid/discard    捨棄草稿
// 審核（只有指定審核人或 super_admin）
//   GET    /reviews/list             ?status=pending|done
//   GET    /reviews/:vid             審核詳情（含舊版內容）
//   POST   /reviews/:vid/approve     { doc?, notify_staff, notice }
//   POST   /reviews/:vid/return      { reason }
//   POST   /reviews/approve-low      低風險全部通過
// 扣分
//   GET    /employees/search         ?q=
//   GET    /deductions               ?status=&erpid=
//   POST   /deductions               { employee_erpid, clause_code, score?, note, incident_date }
//   POST   /deductions/:id/approve   → 寫入 MAP
//   POST   /deductions/:id/reject    { reason }
// 設定
//   GET    /settings                 審核人、匯入狀態、是否有 AI
//   PUT    /settings/reviewer        { erpid }
//   POST   /import                   從 MAP 匯入（背景執行）

const express = require('express');
const router  = express.Router();
const { authorizeModule } = require('../middleware/auth');
const supabase = require('../config/supabase');
const svc = require('../services/regulationService');

const ok   = (res, data) => res.json({ success: true, data });
const fail = (res, e, code = 400) => { console.error('[Regulations]', e.message); res.status(code).json({ success: false, message: e.message }); };
const view = authorizeModule('regulations', 'view');
const edit = authorizeModule('regulations', 'edit');

// ── 設定 ──
router.get('/settings', view, async (req, res) => {
  try {
    const reviewer = await svc.getReviewer();
    ok(res, { reviewer, is_reviewer: svc.isReviewer(req.user, reviewer), import: svc.getImportStatus(), ai: !!process.env.ANTHROPIC_API_KEY, roles: svc.MAP_ROLES });
  } catch (e) { fail(res, e, 500); }
});
router.put('/settings/reviewer', edit, async (req, res) => {
  try {
    const cur = await svc.getReviewer();
    if (req.user?.role !== 'super_admin' && !(cur?.erpid && svc.isReviewer(req.user, cur))) throw new Error('只有系統管理員或目前的審核人可以更換審核人');
    ok(res, await svc.setReviewer(req.body?.erpid, req.user?.name));
  } catch (e) { fail(res, e); }
});
router.post('/import', edit, async (req, res) => {
  try {
    if (req.user?.role !== 'super_admin' && !svc.isReviewer(req.user, await svc.getReviewer())) throw new Error('只有系統管理員或審核人可以匯入');
    svc.importFromMap(req.user?.name).catch(() => {});   // 背景跑，前端輪詢 /settings
    ok(res, svc.getImportStatus());
  } catch (e) { fail(res, e); }
});

// ── 扣分 ──
router.get('/employees/search', view, async (req, res) => { try { ok(res, await svc.searchEmployees(req.query.q)); } catch (e) { fail(res, e, 500); } });
router.get('/deductions', view, async (req, res) => { try { ok(res, await svc.listDeductions(req.query)); } catch (e) { fail(res, e, 500); } });
router.post('/deductions', edit, async (req, res) => { try { ok(res, await svc.createDeduction(req.body || {}, req.user)); } catch (e) { fail(res, e); } });
router.post('/deductions/:id/approve', edit, async (req, res) => {
  try {
    if (!svc.isReviewer(req.user, await svc.getReviewer()) && !['super_admin', 'dept_head', 'operation_lead'].includes(req.user?.role)) throw new Error('沒有審核扣分的權限');
    ok(res, await svc.approveDeduction(req.params.id, req.user));
  } catch (e) { fail(res, e); }
});
router.post('/deductions/:id/reject', edit, async (req, res) => {
  try {
    if (!svc.isReviewer(req.user, await svc.getReviewer()) && !['super_admin', 'dept_head', 'operation_lead'].includes(req.user?.role)) throw new Error('沒有審核扣分的權限');
    ok(res, await svc.rejectDeduction(req.params.id, req.user, req.body?.reason));
  } catch (e) { fail(res, e); }
});

// ── 審核 ──
router.get('/reviews/list', view, async (req, res) => { try { ok(res, await svc.listReviews(req.query.status === 'done' ? 'done' : 'pending')); } catch (e) { fail(res, e, 500); } });
router.post('/reviews/approve-low', edit, async (req, res) => { try { ok(res, await svc.approveAllLow(req.user)); } catch (e) { fail(res, e); } });
router.get('/reviews/:vid', view, async (req, res) => { try { ok(res, await svc.getReview(req.params.vid)); } catch (e) { fail(res, e, 404); } });
router.post('/reviews/:vid/approve', edit, async (req, res) => {
  try { ok(res, await svc.approve(req.params.vid, req.user, { doc: req.body?.doc, notifyStaff: !!req.body?.notify_staff, notice: req.body?.notice })); } catch (e) { fail(res, e); }
});
router.post('/reviews/:vid/return', edit, async (req, res) => { try { ok(res, await svc.returnVersion(req.params.vid, req.user, req.body?.reason)); } catch (e) { fail(res, e); } });

// ── 編輯 ──
router.get('/drafts/list', view, async (req, res) => { try { ok(res, await svc.listDrafts()); } catch (e) { fail(res, e, 500); } });
router.post('/new', edit, async (req, res) => { try { ok(res, await svc.createNewRegulation(req.body || {}, req.user)); } catch (e) { fail(res, e); } });
router.get('/versions/:vid', view, async (req, res) => { try { ok(res, await svc.getVersion(req.params.vid)); } catch (e) { fail(res, e, 404); } });
router.put('/versions/:vid', edit, async (req, res) => { try { ok(res, await svc.saveDraft(req.params.vid, req.body || {}, req.user)); } catch (e) { fail(res, e); } });
router.post('/versions/:vid/preview', edit, async (req, res) => {
  try {
    const v = await svc.getVersion(req.params.vid);
    const { regulation } = await svc.getRegulation(v.regulation_id);
    const cur = regulation.current_version > 0 ? (await svc.getRegulation(v.regulation_id)).doc : { sections: [] };
    const a = await svc.analyze(v.regulation_id, cur, v.doc, { withAi: false });
    ok(res, { risk: a.risk, risk_reasons: a.risk_reasons, checks: a.checks, summary: a.summary, changes: a.diff.changes.length + a.diff.meta.length });
  } catch (e) { fail(res, e); }
});
router.post('/versions/:vid/submit', edit, async (req, res) => { try { ok(res, await svc.submitDraft(req.params.vid, req.user)); } catch (e) { fail(res, e); } });
router.post('/versions/:vid/discard', edit, async (req, res) => { try { ok(res, await svc.discardDraft(req.params.vid)); } catch (e) { fail(res, e); } });
router.post('/:id/draft', edit, async (req, res) => { try { ok(res, await svc.createDraft(req.params.id, req.user)); } catch (e) { fail(res, e); } });

// ── 查詢 ──
router.get('/clauses', view, async (req, res) => { try { ok(res, await svc.searchClauses({ q: req.query.q, regulationId: req.query.regulation_id })); } catch (e) { fail(res, e, 500); } });
router.get('/categories', view, async (req, res) => {
  try {
    const { data, error } = await supabase.from('regulations').select('category').eq('status', 'active');
    if (error) throw error;
    const m = {}; (data || []).forEach(r => { const k = r.category || '（未分類）'; m[k] = (m[k] || 0) + 1; });
    ok(res, Object.entries(m).map(([name, count]) => ({ name, count })).sort((a, b) => a.name.localeCompare(b.name, 'zh-Hant')));
  } catch (e) { fail(res, e, 500); }
});
router.get('/', view, async (req, res) => { try { ok(res, await svc.listRegulations(req.query)); } catch (e) { fail(res, e, 500); } });
router.get('/:id', view, async (req, res) => { try { ok(res, await svc.getRegulation(req.params.id)); } catch (e) { fail(res, e, 404); } });

module.exports = router;
