// routes/dashboard.js
// 首頁今日重點：各模組獨立端點
// 前端平行呼叫，各卡片獨立顯示，互不阻塞

const express  = require('express');
const router   = express.Router();
const axios    = require('axios');
const supabase = require('../config/supabase');
const { authenticate } = require('../middleware/auth');

router.use(authenticate);

// ── 工具 ─────────────────────────────────────────────────
function ok(res, data)  { res.json({ success: true, data }); }
function fail(res, e)   { res.json({ success: false, message: e.response?.data?.message || e.message }); }

// ══════════════════════════════════════════════════════════
// 業績系統
// ══════════════════════════════════════════════════════════
router.get('/highlights/sales', async (req, res) => {
  try {
    const { month } = req.query;
    const r = await axios.get(
      'https://sales-analysis-backend-vc4f.onrender.com/sales/highlight',
      { headers: { 'x-api-key': 'lohas-highlight-2026' },
        params: month ? { month } : {},
        timeout: 30000 }   // 業績系統可能冷啟動，給較長 timeout
    );
    ok(res, r.data);
  } catch (e) { fail(res, e); }
});

// ══════════════════════════════════════════════════════════
// 教育訓練
// ══════════════════════════════════════════════════════════
router.get('/highlights/training', async (req, res) => {
  try {
    const { date } = req.query;
    const r = await axios.get(
      'https://lohas-lms-backend.onrender.com/external/training-highlight',
      { headers: { 'x-api-key': 'lohas-highlight-2026' },
        params: date ? { date } : {},
        timeout: 15000 }
    );
    ok(res, r.data);
  } catch (e) { fail(res, e); }
});

// ══════════════════════════════════════════════════════════
// 稽察
// ══════════════════════════════════════════════════════════
router.get('/highlights/audit', async (req, res) => {
  try {
    const { date } = req.query;
    const r = await axios.get(
      'https://market-backend-0544.onrender.com/api/dashboard/highlight/audit',
      { headers: { Authorization: req.headers['authorization'] || '' },
        params: date ? { date } : {},
        timeout: 15000 }
    );
    ok(res, r.data?.data ?? r.data);
  } catch (e) { fail(res, e); }
});

// ══════════════════════════════════════════════════════════
// 人員評價系統
// ══════════════════════════════════════════════════════════
router.get('/highlights/evaluation', async (req, res) => {
  try {
    const r = await axios.get(
      'https://review-system-backend-3zs3.onrender.com/api/daily-digest/today',
      { headers: { 'x-hub-key': 'lohas-ai-hub-2026' },
        timeout: 15000 }
    );
    ok(res, r.data);
  } catch (e) { fail(res, e); }
});

// ══════════════════════════════════════════════════════════
// 工務部
// ══════════════════════════════════════════════════════════
router.get('/highlights/engineering', async (req, res) => {
  try {
    const { date } = req.query;
    const r = await axios.get(
      'https://market-backend-0544.onrender.com/external/engineering-highlight',
      { headers: { 'x-api-key': 'lohas-engineering-highlight-2026' },
        params: date ? { date } : {},
        timeout: 15000 }
    );
    ok(res, r.data);
  } catch (e) { fail(res, e); }
});

// ══════════════════════════════════════════════════════════
// 人力招募重點（直接查詢本系統 Supabase）
// ══════════════════════════════════════════════════════════
router.get('/highlights/recruitment', async (req, res) => {
  try {
    // 台北今日日期
    const todayStr = new Date()
      .toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' });

    // ── 1. 今日面試（interview_date = today, status = 'invited'）
    const { data: todayInterviews } = await supabase
      .from('recruitment_applicants')
      .select('id, name, interview_date, interview_time, target_store_name')
      .eq('status', 'invited')
      .eq('interview_date', todayStr)
      .order('interview_time', { ascending: true, nullsFirst: false });

    // ── 2. 待安排面試（status = 'pending' 或 'screening'）
    const { data: pendingApplicants } = await supabase
      .from('recruitment_applicants')
      .select('id, name, target_store_name, created_at')
      .in('status', ['pending', 'screening'])
      .order('created_at', { ascending: true });

    // ── 3. 面試結果未填（result is null，面試日已過）
    const { data: missingResults } = await supabase
      .from('recruitment_interviews')
      .select('id, recruitment_applicants(name, interview_date, target_store_name)')
      .is('result', null)
      .not('recruitment_applicants', 'is', null)
      .lte('recruitment_applicants.interview_date', todayStr);

    // 過濾：只留 interview_date < today（純過去未填的）
    const overdue = (missingResults || []).filter(iv => {
      const d = iv.recruitment_applicants?.interview_date;
      return d && d < todayStr;
    });

    // ── 4. 開缺概況
    const { data: openNeeds } = await supabase
      .from('recruitment_needs')
      .select('id, store_name, total_needed, filled, urgent_needed')
      .eq('status', 'open');

    const totalOpen    = openNeeds?.length || 0;
    const totalUrgent  = (openNeeds || []).filter(n => n.urgent_needed > 0).length;

    ok(res, {
      today_str: todayStr,
      today_interviews:  (todayInterviews  || []).map(a => ({
        id:         a.id,
        name:       a.name,
        time:       a.interview_time || null,
        store_name: a.target_store_name,
      })),
      pending_scheduling: (pendingApplicants || []).map(a => ({
        id:         a.id,
        name:       a.name,
        store_name: a.target_store_name,
      })),
      missing_results: overdue.map(iv => ({
        id:            iv.id,
        name:          iv.recruitment_applicants?.name,
        interview_date: iv.recruitment_applicants?.interview_date,
        store_name:    iv.recruitment_applicants?.target_store_name,
      })),
      open_needs: { total: totalOpen, urgent: totalUrgent },
    });
  } catch (e) { fail(res, e); }
});

module.exports = router;
