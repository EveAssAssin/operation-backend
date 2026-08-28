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
// 影片專用（額度大：500MB）
const uploadVideo = multer({ storage: multer.memoryStorage(), limits: { fileSize: 500 * 1024 * 1024 } });

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
        created_by_app_number: req.user?.member_id || null,
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

// GET /api/recruitment/applicants?date=YYYY-MM-DD&month=YYYY-MM&platform=&status=&all=true
// 篩選優先序：all > month > date（不帶 = 今日）
router.get('/applicants', async (req, res) => {
  try {
    const { date, month, platform, status, all } = req.query;
    let q = supabase
      .from('recruitment_applicants')
      .select('*, recruitment_interviews(*)')
      .order('date',       { ascending: false })
      .order('created_at', { ascending: false });

    // all=true → 不過濾日期
    // month=YYYY-MM → 該月份所有資料
    // date=YYYY-MM-DD → 該日
    // 都沒帶 → 今日
    if (all === 'true' || all === true) {
      // 不過濾
    } else if (month && /^\d{4}-\d{2}$/.test(month)) {
      // 該月 1 號到月底
      const [y, m] = month.split('-').map(Number);
      const start = `${month}-01`;
      const end   = new Date(y, m, 0).getDate();
      const endStr = `${month}-${String(end).padStart(2, '0')}`;
      q = q.gte('date', start).lte('date', endStr);
    } else if (date) {
      q = q.eq('date', date);
    }

    if (platform) q = q.eq('platform', platform);
    if (status)   q = q.eq('status', status);

    const { data, error } = await q;
    if (error) throw error;
    ok(res, data);
  } catch (e) { fail(res, e); }
});

// GET /api/recruitment/applicants/pending-follow-ups?days=3
// 待追蹤：履歷 + 面試 兩張表都撈，follow_up_date <= 今天 + days
// 回：{ today, overdue: [...], today_list: [...], upcoming: [...] }
//     每筆帶 source: 'applicant' | 'interview' 區分來源
router.get('/applicants/pending-follow-ups', async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 3;
    const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' });
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() + days);
    const cutoffStr = cutoff.toISOString().slice(0, 10);

    // 1) 履歷
    const { data: applicants, error: e1 } = await supabase
      .from('recruitment_applicants')
      .select('id, date, name, phone, platform, target_store_name, target_store_note, status, tag_stars, tag_notes, candidate_status, expected_reply_date, follow_up_date, follow_up_notes')
      .not('follow_up_date', 'is', null)
      .lte('follow_up_date', cutoffStr)
      .not('status', 'in', '("rejected","rejected_again")')
      .order('follow_up_date', { ascending: true });
    if (e1) throw e1;

    // 2) 面試（join applicants 拿姓名/門市等資料）
    const { data: interviews, error: e2 } = await supabase
      .from('recruitment_interviews')
      .select(`
        id, follow_up_date, follow_up_notes, tag_stars, tag_notes, candidate_status,
        expected_reply_date, result,
        applicant:recruitment_applicants(id, name, phone, platform, target_store_name, target_store_note, status)
      `)
      .not('follow_up_date', 'is', null)
      .lte('follow_up_date', cutoffStr)
      .order('follow_up_date', { ascending: true });
    if (e2) throw e2;

    // 合併：加 source 標記；面試展平帶回 applicant 欄位
    const merged = [];
    for (const a of (applicants || [])) {
      merged.push({ source: 'applicant', ...a });
    }
    for (const iv of (interviews || [])) {
      const ap = iv.applicant || {};
      // 若對應 applicant 已婉拒，跳過（避免推重複人選）
      if (ap.status === 'rejected' || ap.status === 'rejected_again') continue;
      merged.push({
        source:              'interview',
        id:                  iv.id,
        applicant_id:        ap.id || null,
        name:                ap.name || '—',
        phone:               ap.phone || null,
        platform:            ap.platform || null,
        target_store_name:   ap.target_store_name || null,
        target_store_note:   ap.target_store_note || null,
        status:              ap.status || null,
        interview_result:    iv.result || null,
        tag_stars:           iv.tag_stars,
        tag_notes:           iv.tag_notes,
        candidate_status:    iv.candidate_status,
        expected_reply_date: iv.expected_reply_date,
        follow_up_date:      iv.follow_up_date,
        follow_up_notes:     iv.follow_up_notes,
      });
    }
    merged.sort((a, b) => (a.follow_up_date || '').localeCompare(b.follow_up_date || ''));

    const overdue  = [];
    const todayArr = [];
    const upcoming = [];
    for (const item of merged) {
      if (item.follow_up_date < today)      overdue.push(item);
      else if (item.follow_up_date === today) todayArr.push(item);
      else                                    upcoming.push(item);
    }
    ok(res, { today, overdue, today_list: todayArr, upcoming });
  } catch (e) { fail(res, e); }
});

// GET /api/recruitment/applicants/check-rejection-history?name=xxx&phone=xxx
// 檢查同姓名 + 同手機 半年內的婉拒歷史（給新增投遞者時警告用）
router.get('/applicants/check-rejection-history', async (req, res) => {
  try {
    const { name, phone } = req.query;
    if (!name || !phone) {
      return ok(res, { has_history: false, count: 0, records: [] });
    }
    // 半年前的日期
    const sixMonthsAgo = new Date();
    sixMonthsAgo.setDate(sixMonthsAgo.getDate() - 180);
    const cutoff = sixMonthsAgo.toISOString();

    const { data, error } = await supabase
      .from('recruitment_applicants')
      .select('id, date, name, phone, target_store_name, reject_reason, status, created_at')
      .eq('name', name.trim())
      .eq('phone', phone.trim())
      .in('status', ['rejected', 'rejected_again'])
      .gte('created_at', cutoff)
      .order('created_at', { ascending: false });
    if (error) throw error;

    ok(res, {
      has_history: (data || []).length > 0,
      count: (data || []).length,
      records: data || [],
    });
  } catch (e) { fail(res, e); }
});

// POST /api/recruitment/applicants
router.post('/applicants', async (req, res) => {
  try {
    const { date, platform, name, code, phone, target_store_erpid, target_store_name, target_store_note, need_id } = req.body;
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
        target_store_note:  target_store_note  || null,
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

    const VALID_STATUSES = ['pending', 'rejected', 'rejected_again', 'invited', 'notified_intent', 'notified_chat', 'notified_invite', 'notified_intent_2', 'notified_no_response'];
    if (!VALID_STATUSES.includes(status)) {
      return bad(res, `status 必須為 ${VALID_STATUSES.join(' | ')}`);
    }
    if ((status === 'rejected' || status === 'rejected_again') && !reject_reason) {
      return bad(res, '婉拒時 reject_reason 為必填');
    }
    if (status === 'invited' && !interview_date) {
      return bad(res, '邀請面試時 interview_date 為必填');
    }

    const updates = { status, updated_at: new Date().toISOString() };
    if (status === 'rejected' || status === 'rejected_again') updates.reject_reason  = reject_reason;
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
// 編輯基本資料（姓名 / 代碼 / 手機 / 平台 / 投遞門市 / 面試日期 / 面試時間 / 狀態 / 婉拒原因）
router.put('/applicants/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const {
      name, code, phone, platform, target_store_erpid, target_store_name, target_store_note,
      interview_date, interview_time, status, reject_reason,
      // Batch 2 新增：標記 / 待追蹤
      tag_stars, tag_notes, candidate_status, expected_reply_date, follow_up_date, follow_up_notes,
    } = req.body;
    if (!name || !platform) return bad(res, 'name 與 platform 為必填');

    // 若使用者修改 follow_up_date，先撈舊值比對；有改動就清 notified_at 讓下次排程再推
    let followUpDateChanged = false;
    if (follow_up_date !== undefined) {
      const { data: old } = await supabase
        .from('recruitment_applicants')
        .select('follow_up_date')
        .eq('id', id)
        .maybeSingle();
      const oldVal = old?.follow_up_date || null;
      const newVal = follow_up_date || null;
      if (oldVal !== newVal) followUpDateChanged = true;
    }

    const updates = {
      name,
      code:               code               || null,
      phone:              phone              || null,
      platform,
      target_store_erpid: target_store_erpid || null,
      target_store_name:  target_store_name  || null,
      target_store_note:  target_store_note  || null,
      interview_date:     interview_date     || null,
      interview_time:     interview_time     || null,
      // Batch 2 欄位（NULL 化空值）
      tag_stars:           (tag_stars === undefined || tag_stars === null || tag_stars === '') ? null : Number(tag_stars),
      tag_notes:           tag_notes           || null,
      candidate_status:    candidate_status    || null,
      expected_reply_date: expected_reply_date || null,
      follow_up_date:      follow_up_date      || null,
      follow_up_notes:     follow_up_notes     || null,
      updated_at:         new Date().toISOString(),
    };
    if (followUpDateChanged) updates.follow_up_notified_at = null;

    // 狀態變更（選填）
    const VALID_STATUSES = ['pending', 'rejected', 'rejected_again', 'invited', 'notified_intent', 'notified_chat', 'notified_invite', 'notified_intent_2', 'notified_no_response'];
    if (status !== undefined && status !== null && status !== '') {
      if (!VALID_STATUSES.includes(status)) {
        return bad(res, `status 必須為 ${VALID_STATUSES.join(' | ')}`);
      }
      if ((status === 'rejected' || status === 'rejected_again') && !reject_reason) {
        return bad(res, '婉拒時 reject_reason 為必填');
      }
      updates.status = status;
      if (status === 'rejected' || status === 'rejected_again') {
        updates.reject_reason = reject_reason;
      } else {
        updates.reject_reason = null; // 非婉拒狀態清空原因
      }
    }

    const { data, error } = await supabase
      .from('recruitment_applicants')
      .update(updates)
      .eq('id', id)
      .select()
      .single();
    if (error) throw error;

    // 若改成 invited 但沒有既有面試紀錄，補建一筆
    if (status === 'invited') {
      const { data: existing } = await supabase
        .from('recruitment_interviews')
        .select('id')
        .eq('applicant_id', id)
        .maybeSingle();
      if (!existing) {
        await supabase
          .from('recruitment_interviews')
          .insert({ applicant_id: id });
      }
    }

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

// GET /api/recruitment/interviews?result=&month=YYYY-MM
// 篩選 month 時用 interview_date（面試日）為基準；沒設面試日的也會被排除
router.get('/interviews', async (req, res) => {
  try {
    const { result, month } = req.query;

    if (month && /^\d{4}-\d{2}$/.test(month)) {
      // 月份篩選：用 applicant 的 interview_date 字段
      const [y, m] = month.split('-').map(Number);
      const start = `${month}-01`;
      const end   = new Date(y, m, 0).getDate();
      const endStr = `${month}-${String(end).padStart(2, '0')}`;

      let q = supabase
        .from('recruitment_interviews')
        .select(`
          *,
          recruitment_applicants!inner (
            id, name, code, platform, date, phone,
            target_store_erpid, target_store_name, interview_date, interview_time
          )
        `)
        .gte('recruitment_applicants.interview_date', start)
        .lte('recruitment_applicants.interview_date', endStr)
        .order('created_at', { ascending: false });

      if (result === 'pending') q = q.is('result', null);
      else if (result)          q = q.eq('result', result);

      const { data, error } = await q;
      if (error) throw error;
      return ok(res, data);
    }

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
    const {
      notes, result, education_linked, onboarding_url, pending_reason,
      // Batch 2 新增
      tag_stars, tag_notes, candidate_status, expected_reply_date, follow_up_date, follow_up_notes,
    } = req.body;
    const updates = { updated_at: new Date().toISOString() };
    if (notes            !== undefined) updates.notes            = notes;
    if (result           !== undefined) updates.result           = result;
    if (education_linked !== undefined) updates.education_linked = education_linked;
    if (onboarding_url   !== undefined) updates.onboarding_url   = onboarding_url;
    if (pending_reason   !== undefined) updates.pending_reason   = pending_reason;
    // Batch 2 欄位（僅在有帶時才更新）
    if (tag_stars           !== undefined) updates.tag_stars           = (tag_stars === null || tag_stars === '') ? null : Number(tag_stars);
    if (tag_notes           !== undefined) updates.tag_notes           = tag_notes           || null;
    if (candidate_status    !== undefined) updates.candidate_status    = candidate_status    || null;
    if (expected_reply_date !== undefined) updates.expected_reply_date = expected_reply_date || null;
    if (follow_up_notes     !== undefined) updates.follow_up_notes     = follow_up_notes     || null;
    // follow_up_date 有變 → 清 notified_at 讓下次排程重推
    if (follow_up_date      !== undefined) {
      const { data: oldIv } = await supabase
        .from('recruitment_interviews')
        .select('follow_up_date')
        .eq('id', req.params.id)
        .maybeSingle();
      const oldVal = oldIv?.follow_up_date || null;
      const newVal = follow_up_date || null;
      updates.follow_up_date = newVal;
      if (oldVal !== newVal) updates.follow_up_notified_at = null;
    }
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

// POST /api/recruitment/interviews/:id/video
// multipart/form-data, field: video（限 500MB）
router.post('/interviews/:id/video', uploadVideo.single('video'), async (req, res) => {
  try {
    if (!req.file) return bad(res, '未收到影片檔案');
    const { id } = req.params;
    const ext    = (req.file.originalname.split('.').pop() || 'mp4').toLowerCase();
    const path   = `videos/${id}.${ext}`;

    const { error: upErr } = await supabase.storage
      .from('recruitment-audio')
      .upload(path, req.file.buffer, {
        contentType: req.file.mimetype || 'video/mp4',
        upsert: true,
      });
    if (upErr) throw upErr;

    const { data: urlData } = supabase.storage
      .from('recruitment-audio')
      .getPublicUrl(path);
    const videoUrl = urlData.publicUrl;

    const { data, error } = await supabase
      .from('recruitment_interviews')
      .update({ video_url: videoUrl, updated_at: new Date().toISOString() })
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
