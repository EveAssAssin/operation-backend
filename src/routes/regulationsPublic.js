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

// ── 提出新增／修改規範（左手稱號符合才可以；送審後指定審核人通過才上線）2026-10-28 ──
const multer = require('multer');
const sharp  = require('sharp');
const P   = require('../services/regulationPropose');
const reg = require('../services/regulationService');
const AI  = require('../services/regulationAi');
const storage = require('../services/storageService');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });
const editLimit = rateLimit({ windowMs: 10 * 60 * 1000, max: 120, standardHeaders: true, legacyHeaders: false,
  message: { success: false, message: '操作太頻繁，請過幾分鐘再試' } });
const pfail = (res, e) => fail(res, e, e.status || 400);
const can = async (req, res, next) => { try { req.can = await P.mustCan(req.emp); next(); } catch (e) { pfail(res, e); } };
const own = async (req, res, next) => { try { req.ver = await P.ownVersion(req.emp, req.params.vid); next(); } catch (e) { pfail(res, e); } };
const U = (req) => P.userOf(req.emp);

router.get('/propose/me', who, async (req, res) => {
  try {
    const c = await P.check(req.emp);
    let meta = null;
    if (c.can) meta = { roles: reg.MAP_ROLES, categories: (await svc.categories()).map(r => r.category).filter((x, i, a) => x && a.indexOf(x) === i), ai: AI.enabled() };
    ok(res, { can: c.can, reason: c.reason, matched: c.matched || [], meta, mine: await P.mine(req.emp) });
  } catch (e) { pfail(res, e); }
});
router.post('/propose/new', editLimit, who, can, async (req, res) => { try { ok(res, await P.createNew(req.emp, req.body || {})); } catch (e) { pfail(res, e); } });
router.post('/propose/:id/draft', editLimit, who, can, async (req, res) => { try { ok(res, await P.startEdit(req.emp, req.params.id)); } catch (e) { pfail(res, e); } });
router.get('/propose/versions/:vid', who, own, (req, res) => ok(res, req.ver));
router.put('/propose/versions/:vid', editLimit, who, can, own, async (req, res) => { try { ok(res, await reg.saveDraft(req.params.vid, req.body || {}, U(req))); } catch (e) { pfail(res, e); } });
router.post('/propose/versions/:vid/preview', editLimit, who, can, own, async (req, res) => {
  try {
    const v = req.ver;
    const { regulation } = await reg.getRegulation(v.regulation_id);
    const cur = regulation.current_version > 0 ? (await reg.getRegulation(v.regulation_id)).doc : { sections: [] };
    const a = await reg.analyze(v.regulation_id, cur, v.doc, { withAi: false });
    ok(res, { risk: a.risk, risk_reasons: a.risk_reasons, checks: a.checks, summary: a.summary, changes: a.diff.changes.length + a.diff.meta.length });
  } catch (e) { pfail(res, e); }
});
router.post('/propose/versions/:vid/submit', editLimit, who, can, own, async (req, res) => { try { ok(res, await reg.submitDraft(req.params.vid, U(req))); } catch (e) { pfail(res, e); } });
router.post('/propose/versions/:vid/discard', editLimit, who, can, own, async (req, res) => { try { ok(res, await reg.discardDraft(req.params.vid)); } catch (e) { pfail(res, e); } });
router.post('/propose/versions/:vid/assist', editLimit, who, can, own, async (req, res) => { try { ok(res, await AI.assist(req.params.vid, req.body || {}, U(req))); } catch (e) { pfail(res, e); } });
router.post('/propose/versions/:vid/assist/choose', editLimit, who, can, own, async (req, res) => { try { ok(res, await AI.chooseOption(req.params.vid, Number(req.body?.log_index), req.body?.key)); } catch (e) { pfail(res, e); } });
router.post('/propose/versions/:vid/ai-check', editLimit, who, can, own, async (req, res) => { try { ok(res, await AI.check(req.params.vid)); } catch (e) { pfail(res, e); } });
router.post('/propose/versions/:vid/ai-check/:iid/resolve', editLimit, who, can, own, async (req, res) => { try { ok(res, await AI.resolveIssue(req.params.vid, req.params.iid, req.body || {}, U(req))); } catch (e) { pfail(res, e); } });
// 上傳 Word → AI 轉成系統格式（背景工作，結果回給編輯器）
const Docx = require('../services/regulationDocx');
const uploadDocx = multer({ storage: multer.memoryStorage(), limits: { fileSize: 40 * 1024 * 1024 } });
router.post('/propose/import-docx', editLimit, who, can, uploadDocx.single('file'), async (req, res) => {
  try {
    if (!Docx.isDocx(req.file)) throw new Error('請上傳 .docx 檔（舊的 .doc 請先在 Word 另存成 .docx）');
    ok(res, Docx.start(`app:${req.emp.app_number}`, req.file.buffer, { title: req.body?.title }));
  } catch (e) { pfail(res, e); }
});
router.get('/propose/import-docx/:job', who, (req, res) => { try { ok(res, Docx.get(`app:${req.emp.app_number}`, req.params.job)); } catch (e) { fail(res, e, 404); } });
// app_number 放 query（multipart 的 body 在 multer 之前讀不到）
router.post('/propose/upload', editLimit, who, can, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) throw new Error('沒有收到檔案');
    if (!/^image\//.test(req.file.mimetype)) throw new Error('只能上傳圖片');
    const buf = await sharp(req.file.buffer).rotate().resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 82 }).toBuffer();
    ok(res, { url: await storage.uploadPhoto(buf, 'photo.jpg', 'regulations'), size_before: req.file.size, size_after: buf.length });
  } catch (e) { pfail(res, e); }
});

module.exports = router;
