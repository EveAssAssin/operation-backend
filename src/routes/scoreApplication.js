// routes/scoreApplication.js
// 分數加分申請 — REST 路由
//
//   公開（員工自助）/api/score-application/public
//     GET   /types                          上架中的申請類型
//     POST  /applications                   提交申請 { app_number, type_id, apply_reason, attachments }
//     GET   /applications?app_number=       我的申請紀錄
//     POST  /applications/upload-attachment 上傳附件（multipart，回 { url, name, mime, size }）
//
//   管理（需登入）/api/score-application
//     GET    /types
//     POST   /types
//     PUT    /types/:id
//     DELETE /types/:id
//     GET    /applications?status=&erpid=&limit=
//     POST   /applications/:id/approve  { score }
//     POST   /applications/:id/reject   { reason }

const express = require('express');
const multer  = require('multer');
const router  = express.Router();
const { authenticate } = require('../middleware/auth');
const svc = require('../services/scoreApplicationService');
const { uploadPhoto } = require('../services/storageService');

function ok(res, data)             { res.json({ success: true, data }); }
function fail(res, e, code = 400)  {
  console.error('[ScoreApplication]', e.message);
  res.status(code).json({ success: false, message: e.message || '操作失敗' });
}

// multer：暫存記憶體；附件最大 20 MB
const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 20 * 1024 * 1024 },
});

// 允許的附件 mime
const ALLOWED_MIMES = new Set([
  'image/jpeg', 'image/png', 'image/heic', 'image/heif', 'image/webp', 'image/gif',
  'application/pdf',
]);

// ═══════════════════════════════════════════════════════════
// 公開端點（員工自助，用 app_number 驗證）
// ═══════════════════════════════════════════════════════════

// 上架中的類型清單
router.get('/public/types', async (req, res) => {
  try {
    const list = await svc.listTypes({ activeOnly: true });
    ok(res, list);
  } catch (e) { fail(res, e); }
});

// 上傳附件（單檔，回 url；前端要傳幾個就 call 幾次）
router.post('/public/applications/upload-attachment',
  upload.single('file'),
  async (req, res) => {
    try {
      if (!req.file) throw new Error('請選檔案（field=file）');
      const mime = req.file.mimetype || '';
      if (!ALLOWED_MIMES.has(mime)) {
        throw new Error(`不支援的檔案格式：${mime}（只接受圖片或 PDF）`);
      }
      // 沿用 storageService，folder=score-application
      const url = await uploadPhoto(req.file.buffer, req.file.originalname || 'file', 'score-application');
      ok(res, {
        url,
        name: req.file.originalname || '',
        mime,
        size: req.file.size || 0,
      });
    } catch (e) { fail(res, e); }
  }
);

// 提交申請
router.post('/public/applications', async (req, res) => {
  try {
    const { app_number, type_id, apply_reason, attachments } = req.body || {};
    if (!app_number) throw new Error('缺少 app_number');
    if (!type_id)    throw new Error('請選申請類型');
    const saved = await svc.submitApplication({ app_number, type_id, apply_reason, attachments });
    ok(res, saved);
  } catch (e) { fail(res, e); }
});

// 我的申請紀錄
router.get('/public/applications', async (req, res) => {
  try {
    const { app_number } = req.query;
    if (!app_number) throw new Error('缺少 app_number');
    const { verifyEmployee } = require('../services/pointRedemptionService');
    const emp = await verifyEmployee(app_number);
    const list = await svc.listApplications({ erpid: emp.erpid });
    ok(res, list);
  } catch (e) { fail(res, e); }
});

// ═══════════════════════════════════════════════════════════
// 管理端（需登入）
// ═══════════════════════════════════════════════════════════
router.use(authenticate);

// ── 類型 CRUD ─────────────────────────────────────────────
router.get('/types', async (req, res) => {
  try { ok(res, await svc.listTypes({ activeOnly: false })); }
  catch (e) { fail(res, e); }
});

router.post('/types', async (req, res) => {
  try { ok(res, await svc.createType(req.body || {}, req.user)); }
  catch (e) { fail(res, e); }
});

router.put('/types/:id', async (req, res) => {
  try { ok(res, await svc.updateType(req.params.id, req.body || {})); }
  catch (e) { fail(res, e); }
});

router.delete('/types/:id', async (req, res) => {
  try { await svc.deleteType(req.params.id); ok(res, { id: req.params.id }); }
  catch (e) { fail(res, e); }
});

// ── 審核 ───────────────────────────────────────────────────
router.get('/applications', async (req, res) => {
  try {
    const { status, erpid, limit } = req.query;
    ok(res, await svc.listApplications({ status, erpid, limit }));
  } catch (e) { fail(res, e); }
});

router.post('/applications/:id/approve', async (req, res) => {
  try {
    const approver = req.user?.name || '營運部';
    const { score } = req.body || {};
    ok(res, await svc.approveApplication(req.params.id, approver, score));
  } catch (e) { fail(res, e); }
});

router.post('/applications/:id/reject', async (req, res) => {
  try {
    const approver = req.user?.name || '營運部';
    const { reason } = req.body || {};
    ok(res, await svc.rejectApplication(req.params.id, approver, reason));
  } catch (e) { fail(res, e); }
});

module.exports = router;
