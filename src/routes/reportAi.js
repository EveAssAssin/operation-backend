// routes/reportAi.js —— 月報 AI（2026-11-09）
//   GET  /api/report-ai/chats、/chats/:id        對話（自己的）
//   POST /api/report-ai/chat                      {chat_id?, stores:[erpid], ym, message}
//   GET  /api/report-ai/orders?status=            動作單；POST /orders/:id/apply|reject（apply 要 billing 編輯；close/reopen 另在 service 擋 super_admin）
//   POST /api/report-ai/feedback                  {run_id, verdict approved|edited|rejected, note, final}（糾正立刻進 AI 筆記）
//   GET  /api/report-ai/issues?scope=  PATCH /issues/:id  POST /issues   待追蹤（樂維斯記憶層）
//   GET  /api/report-ai/notes                     AI 的工作筆記（唯讀看）
//   GET  /api/report-ai/dev-needs  PUT /dev-needs/:id
// 權限：report_ai 模組 view；寫入（chat 也算，因為會開單）要 billing edit 或 report_ai edit
const express = require('express');
const router = express.Router();
const supabase = require('../config/supabase');
const { authenticate, authorizeModule } = require('../middleware/auth');
const RA = require('../services/reportAi');
router.use(authenticate, authorizeModule('report_ai', 'view'));
const canEdit = authorizeModule('report_ai', 'edit');
const wrap = (fn) => async (req, res) => { try { res.json({ success: true, data: await fn(req, res) }); } catch (e) { console.error('[report-ai]', req.path, e.message); res.status(e.status || 500).json({ success: false, message: e.message }); } };
const app = (req) => String(req.user.member_id || req.user.app_number);

router.get('/chats', wrap(async (req) => { const { data } = await supabase.from('report_ai_chats').select('id, title, stores, ym, updated_at').eq('app_number', app(req)).order('updated_at', { ascending: false }).limit(30); return data || []; }));
router.get('/chats/:id', wrap(async (req) => { const { data } = await supabase.from('report_ai_chats').select('*').eq('id', req.params.id).eq('app_number', app(req)).maybeSingle(); if (!data) throw Object.assign(new Error('沒有這則對話'), { status: 404 }); const ids = [].concat(...(data.messages || []).map((m) => m.orders || [])); const { data: orders } = ids.length ? await supabase.from('report_ai_orders').select('*').in('id', ids) : { data: [] }; return { ...data, orders: orders || [] }; }));
router.post('/chat', canEdit, wrap(async (req) => { const b = req.body || {}; if (!String(b.message || '').trim()) throw Object.assign(new Error('請輸入訊息'), { status: 400 }); return RA.chat({ user: req.user, chatId: b.chat_id, stores: Array.isArray(b.stores) ? b.stores.map(String) : [], ym: b.ym || null, message: String(b.message) }); }));
router.get('/orders', wrap(async (req) => { let q = supabase.from('report_ai_orders').select('*').order('id', { ascending: false }).limit(100); if (req.query.status) q = q.eq('status', req.query.status); const { data } = await q; return data || []; }));
router.post('/orders/:id/apply', canEdit, wrap(async (req) => RA.apply(Number(req.params.id), req.user)));
router.post('/orders/:id/reject', canEdit, wrap(async (req) => RA.reject(Number(req.params.id), req.user)));
router.post('/feedback', wrap(async (req) => { const b = req.body || {}; return RA.feedback({ run_id: b.run_id, verdict: b.verdict, note: b.note, final: b.final, by: req.user.name || app(req), scope: b.scope }); }));
router.get('/issues', wrap(async (req) => (await RA.lavis('GET', `/memory/acct/issues?${new URLSearchParams({ ...(req.query.scope ? { scope: req.query.scope } : {}), ...(req.query.status ? { status: req.query.status } : {}) })}`)).data));
router.post('/issues', canEdit, wrap(async (req) => RA.lavis('POST', '/memory/acct/issues', { ...(req.body || {}), by: req.user.name || app(req) })));
router.patch('/issues/:id', canEdit, wrap(async (req) => RA.lavis('PATCH', `/memory/acct/issues/${req.params.id}`, { ...(req.body || {}), by: req.user.name || app(req) })));
router.get('/notes', wrap(async () => (await RA.lavis('GET', '/memory/acct/notes')).data));
router.get('/dev-needs', wrap(async () => { const { data } = await supabase.from('report_ai_dev_needs').select('*').order('id', { ascending: false }).limit(100); return data || []; }));
router.put('/dev-needs/:id', canEdit, wrap(async (req) => { const { data } = await supabase.from('report_ai_dev_needs').update({ status: (req.body || {}).status || 'open' }).eq('id', req.params.id).select('*').single(); return data; }));
router.get('/stores', wrap(async () => RA.storeList()));
module.exports = router;
