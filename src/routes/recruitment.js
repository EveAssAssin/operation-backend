// routes/recruitment.js
// 人力招募模組 API
// 需 operation_staff 以上權限

const express     = require('express');
const router      = express.Router();
const multer      = require('multer');
const { authorize }  = require('../middleware/auth');
const supabase    = require('../config/supabase');
const { sendSms } = require('../services/smsService');

// multer：暫存記憶體，上傳後轉 Supabase Storage
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

router.use(authorize('operation_staff', 'operation_lead', 'dept_head', 'super_admin'));

// ────────────────────────────────────────────────────────────
// 工具函式
// ────────────────────────────────────────────────────────────
function ok(res, data)   { res.json({ success: true, data }); }
function bad(res, msg)   { res.status(400).json({ success: false, message: msg }); }
function fail(res, e)    { console.error('[Recruitment]', e.message); res.status(500).json({ success: false, message: e.message }); }

// ════════════════════════════════════════════════════════════
// 人力需求
// ════════════════════════════════════════════════════════════

// GET /api/recruitment/needs?status=open
router.get('/needs', async (req, res) => {
  try {
    const { status } = req.query;
    let q = supabase
      .from('recruitment_needs')
      .select('*')
      .order('created_at', { ascending: false });
    if (status) q = q.eq('status', status);

    const { data, error } = await q;
    if (error) throw error;
    ok(res, data);
  } catch (e) { fail(res, e); }
});

// POST /api/recruitment/needs  — 手動建立需求
router.post('/needs', async (req, res) => {
  try {
    const { store_erpid, store_name, total_needed, urgent_needed, note } = req.body;
    if (!store_erpid || !store_name) return bad(res, 'store_erpid 與 store_name 為必填');
    if (!total_needed || total_needed < 1) return bad(res, 'total_needed 必須 ≥ 1');

    const { data, error } = await supabase
      .from('recruitment_needs')
      .insert({
        store_erpid, store_name,
        total_needed:  Number(total_needed)  || 1,
        urgent_needed: Number(urgent_needed) || 0,
        note: note || null,
        source: 'manual',
      })
      .select()
      .single();
    if (error) throw error;
    ok(res, data);
  } catch (e) { fail(res, e); }
});

// PATCH /api/recruitment/needs/:id
router.patch('/needs/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const allowed = ['total_needed', 'urgent_needed', 'filled', 'status', 'note'];
    const updates = {};
    for (const k of allowed) {
      if (req.body[k] !== undefined) updates[k] = req.body[k];
    }
    updates.updated_at = new Date().toISOString();

    // 自動判斷 fulfilled
    if (updates.filled !== undefined || updates.total_needed !== undefined) {
      const { data: cur } = await supabase.from('recruitment_needs').select('total_needed, filled').eq('id', id).single();
      const total  = updates.total_needed ?? cur.total_needed;
      const filled = updates.filled       ?? cur.filled;
      if (filled >= total) updates.status = 'fulfilled';
    }

    const { data, error } = await supabase
      .from('recruitment_needs')
      .update(updates)
      .eq('id', id)
      .select()
      .single();
    if (error) throw error;
    ok(res, data);
  } catch (e) { fail(res, e); }
});

// ════════════════════════════════════════════════════════════
// 履歷投遞者
// ════════════════════════════════════════════════════════════

// GET /api/recruitment/applicants?date=YYYY-MM-DD&platform=&status=&all=true
// date 不帶時只取今日；all=true 時取全部（不限日期）
router.get('/applicants', async (req, res) => {
  try {
    const { date, platform, status, all } = req.query;
    let q = supabase
      .from('recruitment_applicants')
      .select('*, recruitment_interviews(*)')
      .order('date',       { ascending: false })
      .order('created_at', { ascending: false });

    // all=true 不過濾日期；否則以 date 參數過濾（前端若帶空字串也視為不過濾）
    if (!all && date) q = q.eq('date', date);
    if (platform)     q = q.eq('platform', platform);
    if (status)       q = q.eq('status', status);

    const { data, error } = await q;
    if (error) throw error;
    ok(res, data);
  } catch (e) { fail(res, e); }
});

// POST /api/recruitment/applicants
router.post('/applicants', async (req, res) => {
  try {
    const { date, platform, name, code, phone, target_store_erpid, target_store_name, need_id } = req.body;
    if (!platform || !name) return bad(res, 'platform 與 name 為必填');

    const { data, error } = await supabase
      .from('recruitment_applicants')
      .insert({
        date: date || new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' }),
        platform, name,
        code:               code               || null,
        phone:              phone              || null,
        target_store_erpid: target_store_erpid || null,
        target_store_name:  target_store_name  || null,
        need_id:            need_id            || null,
        status: 'pending',
      })
      .select()
      .single();
    if (error) throw error;
    ok(res, data);
  } catch (e) { fail(res, e); }
});

// PATCH /api/recruitment/applicants/:id
// body: { status, reject_reason, interview_date, interview_time }
router.patch('/applicants/:id', async (req, res) => {
  try {
    const { id }    = req.params;
    const { status, reject_reason, interview_date, interview_time } = req.body;

    const VALID_STATUSES = ['pending', 'rejected', 'invited', 'notified_intent', 'notified_chat', 'notified_invite'];
    if (!VALID_STATUSES.includes(status)) {
      return bad(res, `status 必須為 ${VALID_STATUSES.join(' | ')}`);
    }
    if (status === 'rejected' && !reject_reason) {
      return bad(res, '婉拒時 reject_reason 為必填');
    }
    if (status === 'invited' && !interview_date) {
      return bad(res, '邀請面試時 interview_date 為必填');
    }

    const updates = { status, updated_at: new Date().toISOString() };
    if (status === 'rejected') updates.reject_reason  = reject_reason;
    if (status === 'invited')  {
      updates.interview_date = interview_date;
      updates.interview_time = interview_time || null;
    }

    const { data: applicant, error: e1 } = await supabase
      .from('recruitment_applicants')
      .update(updates)
      .eq('id', id)
      .select()
      .single();
    if (e1) throw e1;

    // 邀請面試時自動建立面試紀錄
    if (status === 'invited') {
      const { data: existing } = await supabase
        .from('recruitment_interviews')
        .select('id')
        .eq('applicant_id', id)
        .maybeSingle();

      if (!existing) {
        const { error: e2 } = await supabase
          .from('recruitment_interviews')
          .insert({ applicant_id: id });
        if (e2) throw e2;
      }
    }

    ok(res, applicant);
  } catch (e) { fail(res, e); }
});

// PUT /api/recruitment/applicants/:id
// 編輯基本資料（姓名 / 代碼 / 手機 / 平台 / 投遞門市 / 面試日期 / 面試時間）
router.put('/applicants/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { name, code, phone, platform, target_store_erpid, target_store_name,
            interview_date, interview_time } = req.body;
    if (!name || !platform) return bad(res, 'name 與 platform 為必填');

    const { data, error } = await supabase
      .from('recruitment_applicants')
      .update({
        name,
        code:               code               || null,
        phone:              phone              || null,
        platform,
        target_store_erpid: target_store_erpid || null,
        target_store_name:  target_store_name  || null,
        interview_date:     interview_date     || null,
        interview_time:     interview_time     || null,
        updated_at:         new Date().toISOString(),
      })
      .eq('id', id)
      .select()
      .single();
    if (error) throw error;
    ok(res, data);
  } catch (e) { fail(res, e); }
});

// DELETE /api/recruitment/applicants/:id
// 刪除投遞者（同時刪除相關面試紀錄）
router.delete('/applicants/:id', async (req, res) => {
  try {
    const { id } = req.params;

    // 先刪面試紀錄（避免 FK 錯誤）
    await supabase
      .from('recruitment_interviews')
      .delete()
      .eq('applicant_id', id);

    const { error } = await supabase
      .from('recruitment_applicants')
      .delete()
      .eq('id', id);
    if (error) throw error;

    res.json({ success: true, message: '已刪除' });
  } catch (e) { fail(res, e); }
});

// ════════════════════════════════════════════════════════════
// 面試紀錄
// ════════════════════════════════════════════════════════════

// GET /api/recruitment/interviews?result=
router.get('/interviews', async (req, res) => {
  try {
    const { result } = req.query;
    let q = supabase
      .from('recruitment_interviews')
      .select(`
        *,
        recruitment_applicants (
          id, name, code, platform, date, phone,
          target_store_erpid, target_store_name, interview_date, interview_time
        )
      `)
      .order('created_at', { ascending: false });

    if (result === 'pending') q = q.is('result', null);
    else if (result)          q = q.eq('result', result);

    const { data, error } = await q;
    if (error) throw error;
    ok(res, data);
  } catch (e) { fail(res, e); }
});

// GET /api/recruitment/interviews/:id
router.get('/interviews/:id', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('recruitment_interviews')
      .select(`*, recruitment_applicants(*)`)
      .eq('id', req.params.id)
      .single();
    if (error) throw error;
    ok(res, data);
  } catch (e) { fail(res, e); }
});

// PATCH /api/recruitment/interviews/:id
router.patch('/interviews/:id', async (req, res) => {
  try {
    const { notes, result, education_linked, onboarding_url, pending_reason } = req.body;
    const updates = { updated_at: new Date().toISOString() };
    if (notes            !== undefined) updates.notes            = notes;
    if (result           !== undefined) updates.result           = result;
    if (education_linked !== undefined) updates.education_linked = education_linked;
    if (onboarding_url   !== undefined) updates.onboarding_url   = onboarding_url;
    if (pending_reason   !== undefined) updates.pending_reason   = pending_reason;
    if (result && !updates.completed_at) updates.completed_at = new Date().toISOString();

    const { data, error } = await supabase
      .from('recruitment_interviews')
      .update(updates)
      .eq('id', req.params.id)
      .select()
      .single();
    if (error) throw error;
    ok(res, data);
  } catch (e) { fail(res, e); }
});

// POST /api/recruitment/interviews/:id/audio
// multipart/form-data, field: audio
router.post('/interviews/:id/audio', upload.single('audio'), async (req, res) => {
  try {
    if (!req.file) return bad(res, '未收到音訊檔案');
    const { id } = req.params;
    const ext    = req.file.originalname.split('.').pop() || 'webm';
    const path   = `interviews/${id}.${ext}`;

    // 上傳到 Supabase Storage bucket: recruitment-audio
    const { error: upErr } = await supabase.storage
      .from('recruitment-audio')
      .upload(path, req.file.buffer, {
        contentType: req.file.mimetype,
        upsert: true,
      });
    if (upErr) throw upErr;

    const { data: urlData } = supabase.storage
      .from('recruitment-audio')
      .getPublicUrl(path);

    const audioUrl = urlData.publicUrl;

    const { data, error } = await supabase
      .from('recruitment_interviews')
      .update({ audio_url: audioUrl, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select()
      .single();
    if (error) throw error;
    ok(res, data);
  } catch (e) { fail(res, e); }
});

// POST /api/recruitment/interviews/:id/sms
// body: { phone, onboarding_url? }  — 發送到職簡訊給新人
router.post('/interviews/:id/sms', async (req, res) => {
  try {
    const { id }    = req.params;
    const { phone, onboarding_url: urlOverride } = req.body;
    if (!phone) return bad(res, 'phone 為必填');

    // 取出面試紀錄（onboarding_url 可由前端覆蓋）
    const { data: iv, error: e1 } = await supabase
      .from('recruitment_interviews')
      .select('id, onboarding_url, recruitment_applicants(name)')
      .eq('id', id)
      .single();
    if (e1) throw e1;

    const onboardingUrl = urlOverride || iv.onboarding_url;
    if (!onboardingUrl) return bad(res, '請輸入到職連結');

    const name    = iv.recruitment_applicants?.name || '您';
    const msgBody = `親愛的 ${name}，歡迎加入樂活眼鏡！請點選以下連結完成到職手續：${onboardingUrl}`;

    const result = await sendSms(phone, msgBody);

    // 記錄已發送（存到 interview 備用欄位，這裡不另建欄位，只 log）
    console.log(`[Recruitment] SMS 已發送至 ${phone}，面試 ${id}`);
    ok(res, { phone, batchNo: result.batchNo });
  } catch (e) { fail(res, e); }
});

module.exports = router;
