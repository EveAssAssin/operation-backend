// routes/processes/public.js
// 各類流程 — 公開端點（不需登入，由 LIFF UID / member_id 驗證）
//
// 用於 QR 掃描後的填寫頁
//   GET   /api/processes/public/handovers/:id          看交接表（依 stage 過濾欄位）
//   POST  /api/processes/public/handovers/:id/identify  用 line_uid 查員工身份
//   POST  /api/processes/public/handovers/:id/submit-original
//   POST  /api/processes/public/handovers/:id/submit-new
//   POST  /api/processes/public/handovers/:id/submit-third
//   POST  /api/processes/public/handovers/:id/upload-photo  (multipart)

const express = require('express');
const multer  = require('multer');
const router  = express.Router();
const supabase    = require('../../config/supabase');
const handover    = require('../../services/handoverService');
const { uploadPhoto } = require('../../services/storageService');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

function fail(res, e, prefix = 'Handover/Public') {
  console.error(`[${prefix}]`, e.message);
  res.status(400).json({ success: false, message: e.message || '操作失敗' });
}
function ok(res, data) { res.json({ success: true, data }); }

// ── 取得交接表（由 stage 控制資訊揭露）──────────────────────
router.get('/handovers/:id', async (req, res) => {
  try {
    const h = await handover.getHandover(req.params.id);
    // 全部欄位都回，前端依 stage 渲染（此模組沒有機密資訊）
    ok(res, h);
  } catch (e) { fail(res, e); }
});

// ── 員工身份辨識：用 line_uid 查 employees ─────────────────
router.post('/handovers/:id/identify', async (req, res) => {
  try {
    const { line_uid, app_number } = req.body || {};
    if (!line_uid && !app_number) {
      return res.status(400).json({ success: false, message: '請提供 line_uid 或 app_number' });
    }

    let q = supabase
      .from('employees')
      .select('id, erpid, app_number, name, jobtitle, store_erpid, store_name, line_uid, is_active')
      .eq('is_active', true)
      .limit(1);

    if (line_uid)        q = q.eq('line_uid', line_uid);
    else                 q = q.eq('app_number', String(app_number));

    const { data: emp, error } = await q.maybeSingle();
    if (error) throw error;
    if (!emp) return res.status(404).json({ success: false, message: '查無此員工（請確認已綁定 LINE 或填正確的員工編號）' });

    ok(res, {
      member_id: emp.app_number || String(emp.id),
      name:      emp.name,
      jobtitle:  emp.jobtitle,
      store_erpid: emp.store_erpid,
      store_name:  emp.store_name,
      erpid:     emp.erpid,
    });
  } catch (e) { fail(res, e, 'Handover/Identify'); }
});

// ── 提交原交接方 ───────────────────────────────────────────
router.post('/handovers/:id/submit-original', async (req, res) => {
  try {
    const { member_id, name, responses, extra_note } = req.body || {};
    const updated = await handover.submitOriginal(req.params.id, {
      member_id, name, responses, extra_note,
    });
    ok(res, updated);
  } catch (e) { fail(res, e, 'Handover/SubmitOriginal'); }
});

// ── 提交新交接方 ───────────────────────────────────────────
router.post('/handovers/:id/submit-new', async (req, res) => {
  try {
    const { member_id, name, extra_note } = req.body || {};
    const updated = await handover.submitNew(req.params.id, { member_id, name, extra_note });
    ok(res, updated);
  } catch (e) { fail(res, e, 'Handover/SubmitNew'); }
});

// ── 第三方確認 ─────────────────────────────────────────────
router.post('/handovers/:id/submit-third', async (req, res) => {
  try {
    const { member_id, name, note } = req.body || {};
    const updated = await handover.submitThird(req.params.id, { member_id, name, note });
    ok(res, updated);
  } catch (e) { fail(res, e, 'Handover/SubmitThird'); }
});

// ── 上傳照片（一次一張，回 publicUrl）────────────────────
router.post('/handovers/:id/upload-photo', upload.single('photo'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, message: '請上傳檔案（field=photo）' });
    const url = await uploadPhoto(req.file.buffer, req.file.originalname || 'photo.jpg', `handover/${req.params.id}`);
    ok(res, { url });
  } catch (e) { fail(res, e, 'Handover/UploadPhoto'); }
});

module.exports = router;
