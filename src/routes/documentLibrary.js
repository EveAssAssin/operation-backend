// routes/documentLibrary.js
// 文件庫 REST API
//   GET    /api/doc-library/:type/categories
//   GET    /api/doc-library/:type/docs?category=...
//   POST   /api/doc-library/:type/upload  (multipart, query: category, category_ref?, tags?, description?)
//   PATCH  /api/doc-library/:id           (改 category / tags / description)
//   DELETE /api/doc-library/:id

const express = require('express');
const multer  = require('multer');
const router  = express.Router();
const { authorize } = require('../middleware/auth');
const svc     = require('../services/documentLibraryService');

router.use(authorize('operation_staff', 'operation_lead', 'dept_head', 'super_admin'));

const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 50 * 1024 * 1024 },
});

function ok(res, data) { res.json({ success: true, data }); }
function bad(res, msg) { res.status(400).json({ success: false, message: msg }); }
function fail(res, e)  {
  console.error('[DocLib]', e.message);
  res.status(500).json({ success: false, message: e.message || '伺服器錯誤' });
}

// 列分類
router.get('/:type/categories', async (req, res) => {
  try { ok(res, await svc.listCategories(req.params.type)); }
  catch (e) { fail(res, e); }
});

// 列某分類的文件
router.get('/:type/docs', async (req, res) => {
  try {
    const { category } = req.query;
    if (!category) return bad(res, 'category 必填');
    ok(res, await svc.listDocs(req.params.type, category));
  } catch (e) { fail(res, e); }
});

// 上傳文件
router.post('/:type/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return bad(res, '請附上 file');
    const { category, category_ref, tags, description, auto_create_store } = req.query;
    if (!category) return bad(res, 'category（分類名）必填');

    const uploader = req.user?.member_id || null;

    // 如果是門市 + 有指定自動建門市，先檢查 departments
    if (req.params.type === 'rent' && String(auto_create_store) === 'true') {
      await svc.ensureStoreInDepartments(category, category_ref);
    }

    const data = await svc.uploadDoc({
      buffer:       req.file.buffer,
      mimeType:     req.file.mimetype,
      originalName: req.file.originalname,
      doc_type:     req.params.type,
      category, category_ref,
      tags:         tags ? String(tags) : undefined,
      description,
    }, uploader);
    ok(res, data);
  } catch (e) { fail(res, e); }
});

// 更新（改 category / tags / description）
router.patch('/:id', async (req, res) => {
  try { ok(res, await svc.updateDoc(req.params.id, req.body || {})); }
  catch (e) { fail(res, e); }
});

// 刪除
router.delete('/:id', async (req, res) => {
  try { ok(res, await svc.deleteDoc(req.params.id)); }
  catch (e) { fail(res, e); }
});

module.exports = router;
