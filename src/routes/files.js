// routes/files.js
// 通用附件 REST API
// 掛載點：/api/files（需登入）

const express = require('express');
const multer  = require('multer');
const router  = express.Router();
const { authorize } = require('../middleware/auth');
const svc     = require('../services/fileService');

router.use(authorize('operation_staff', 'operation_lead', 'dept_head', 'super_admin'));

const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 50 * 1024 * 1024 },  // 50 MB
});

function ok(res, data) { res.json({ success: true, data }); }
function bad(res, msg) { res.status(400).json({ success: false, message: msg }); }
function fail(res, e)  {
  console.error('[Files]', e.message);
  res.status(500).json({ success: false, message: e.message || '伺服器錯誤' });
}

// POST /api/files/upload?entity_type=contract&entity_id=xxx[&category=&note=]
// form-data: file
router.post('/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return bad(res, '請附上檔案（form-data 欄位名 file）');
    const { entity_type, entity_id, category, note } = req.query;
    if (!entity_type) return bad(res, 'entity_type 必填（query）');
    if (!entity_id)   return bad(res, 'entity_id 必填（query）');

    const uploader = req.user?.member_id || null;
    const data = await svc.uploadFile({
      buffer:       req.file.buffer,
      mimeType:     req.file.mimetype,
      originalName: req.file.originalname,
      entity_type, entity_id, category, note,
    }, uploader);
    ok(res, data);
  } catch (e) { fail(res, e); }
});

// GET /api/files?entity_type=contract&entity_id=xxx
router.get('/', async (req, res) => {
  try {
    const { entity_type, entity_id } = req.query;
    if (!entity_type || !entity_id) return bad(res, 'entity_type 與 entity_id 必填');
    ok(res, await svc.listFiles(entity_type, entity_id));
  } catch (e) { fail(res, e); }
});

// DELETE /api/files/:id
router.delete('/:id', async (req, res) => {
  try { ok(res, await svc.deleteFile(req.params.id)); }
  catch (e) { fail(res, e); }
});

// GET /api/files/:storagePath/signed-url  (path 用 base64 encode)
router.get('/signed-url/:b64', async (req, res) => {
  try {
    const storagePath = Buffer.from(req.params.b64, 'base64').toString('utf-8');
    const url = await svc.getSignedUrl(storagePath, 3600);
    ok(res, { url });
  } catch (e) { fail(res, e); }
});

module.exports = router;
