// routes/regulationsPublic.js — 人員「查規範」公開 API（用 APP 編號確認身分，不需登入）
//   掛在 /api/regulations-public
const express   = require('express');
const rateLimit = require('express-rate-limit');
const router    = express.Router();
const svc = require('../services/regulationPublic');

const ok   = (res, data) => res.json({ success: true, data });
const fail = (res, e, code = 400) => res.status(code).json({ success: false, message: e.message });

// 每個請求都要帶 app_number（query 或 body），驗證後放到 req.emp
async function who(req, res, next) {
  try { req.emp = await svc.verify(req.query.app_number || req.body?.app_number); next(); }
  catch (e) { fail(res, e, 403); }
}
// AI 問答限流：每個 IP 10 分鐘 30 題
const askLimit = rateLimit({ windowMs: 10 * 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false,
  message: { success: false, message: '問得太快了，請過幾分鐘再問' } });

router.get('/verify', who, (req, res) => ok(res, { ...req.emp, ai: !!process.env.ANTHROPIC_API_KEY }));
router.get('/search', who, async (req, res) => { try { ok(res, await svc.search(req.emp, req.query.q, { all: req.query.all === '1' })); } catch (e) { fail(res, e, 500); } });
router.get('/list', who, async (req, res) => {
  try {
    const ids = await svc.applicableIds(req.emp.roles);
    const all = await svc.categories();
    ok(res, all.filter(r => req.query.all === '1' || ids.has(Number(r.id))).map(({ roles, ...r }) => r));
  } catch (e) { fail(res, e, 500); }
});
router.get('/regulation/:id', who, async (req, res) => { try { ok(res, await svc.getRegulation(req.params.id)); } catch (e) { fail(res, e, 404); } });
router.get('/recent', who, async (req, res) => { try { ok(res, await svc.recent(req.emp, Math.min(Number(req.query.days) || 30, 120))); } catch (e) { fail(res, e, 500); } });
router.get('/my-deductions', who, async (req, res) => { try { ok(res, await svc.myDeductions(req.emp)); } catch (e) { fail(res, e, 500); } });
router.post('/ask', askLimit, who, async (req, res) => {
  try { ok(res, await svc.ask(req.emp, req.body?.question, Array.isArray(req.body?.history) ? req.body.history : [])); } catch (e) { fail(res, e); }
});
router.post('/feedback', who, async (req, res) => { try { ok(res, await svc.feedback(req.emp, req.body?.id, req.body?.helpful)); } catch (e) { fail(res, e); } });

module.exports = router;
