// routes/recruitmentExternal.js
// 人力招募模組：跨系統公開端點（API Key 驗證，不需 SSO 登入）
// 供市場部後端 / 教育訓練系統直接呼叫

const express  = require('express');
const router   = express.Router();
const supabase = require('../config/supabase');

const MARKET_API_KEY    = process.env.MARKET_RECRUITMENT_API_KEY    || '';
const EDUCATION_API_KEY = process.env.EDUCATION_RECRUITMENT_API_KEY || '';

// ── API Key 驗證 middleware（市場部）──────────────────────
function verifyMarketKey(req, res, next) {
  if (!MARKET_API_KEY) {
    return res.status(503).json({ success: false, message: '尚未設定 MARKET_RECRUITMENT_API_KEY' });
  }
  const key = req.headers['x-api-key'];
  if (!key || key !== MARKET_API_KEY) {
    return res.status(401).json({ success: false, message: 'API Key 無效' });
  }
  next();
}

// ── API Key 驗證 middleware（教育訓練系統）──────────────────
function verifyEducationKey(req, res, next) {
  if (!EDUCATION_API_KEY) {
    return res.status(503).json({ success: false, message: '尚未設定 EDUCATION_RECRUITMENT_API_KEY' });
  }
  const key = req.headers['x-api-key'];
  if (!key || key !== EDUCATION_API_KEY) {
    return res.status(401).json({ success: false, message: 'API Key 無效' });
  }
  next();
}

// ════════════════════════════════════════════════════════════
// POST /api/recruitment/external/needs
// 市場部後端呼叫，新增人力需求
//
// Headers:
//   x-api-key: {MARKET_RECRUITMENT_API_KEY}
//
// Body:
//   store_erpid    string  必填  門市代號
//   store_name     string  必填  門市名稱
//   total_needed   number  必填  總缺人數（≥1）
//   urgent_needed  number  選填  急缺人數（預設 0）
//   note           string  選填  備註
//   request_id     string  選填  市場部自訂的唯一請求 ID（防重複）
//
// 回傳：
//   { success: true, data: { id, store_name, total_needed, ... } }
//   重複的 request_id 回傳 { success: true, duplicate: true, data: 既有記錄 }
// ════════════════════════════════════════════════════════════
router.post('/needs', verifyMarketKey, async (req, res) => {
  const { store_erpid, store_name, total_needed, urgent_needed, note, request_id } = req.body || {};

  if (!store_erpid || !store_name) {
    return res.status(400).json({ success: false, message: 'store_erpid 與 store_name 為必填' });
  }
  if (!total_needed || Number(total_needed) < 1) {
    return res.status(400).json({ success: false, message: 'total_needed 必須 ≥ 1' });
  }

  try {
    // 防重複：request_id 相同時直接回傳既有資料
    if (request_id) {
      const { data: existing } = await supabase
        .from('recruitment_needs')
        .select('*')
        .eq('hub_message_id', `ext-${request_id}`)
        .maybeSingle();

      if (existing) {
        return res.json({ success: true, duplicate: true, data: existing });
      }
    }

    const { data, error } = await supabase
      .from('recruitment_needs')
      .insert({
        store_erpid,
        store_name,
        total_needed:  Number(total_needed),
        urgent_needed: Number(urgent_needed) || 0,
        note:          note || null,
        source:        'market_api',
        hub_message_id: request_id ? `ext-${request_id}` : null,
      })
      .select()
      .single();

    if (error) throw error;

    console.log(`[Recruitment] 市場部 API 新增需求：${store_name} 缺 ${total_needed} 人`);
    res.json({ success: true, data });

  } catch (e) {
    console.error('[Recruitment External]', e.message);
    res.status(500).json({ success: false, message: e.message });
  }
});

// ════════════════════════════════════════════════════════════
// POST /api/recruitment/external/arrival
// 教育訓練系統呼叫：新人已完成建檔，回傳到職連結
//
// Headers:
//   x-api-key: {EDUCATION_RECRUITMENT_API_KEY}
//
// Body:
//   interview_id   string  必填  面試紀錄 UUID
//   onboarding_url string  必填  新人到職連結
//   request_id     string  選填  防重複唯一 ID
//
// 回傳：
//   { success: true, data: { interview, need } }
//   重複的 request_id 回傳 { success: true, duplicate: true, data: 既有記錄 }
// ════════════════════════════════════════════════════════════
router.post('/arrival', verifyEducationKey, async (req, res) => {
  const { interview_id, onboarding_url, request_id } = req.body || {};

  if (!interview_id) {
    return res.status(400).json({ success: false, message: 'interview_id 為必填' });
  }
  if (!onboarding_url) {
    return res.status(400).json({ success: false, message: 'onboarding_url 為必填' });
  }

  try {
    // 防重複：同一 request_id 若已處理過，直接回傳
    if (request_id) {
      const { data: existing } = await supabase
        .from('recruitment_interviews')
        .select('*')
        .eq('id', interview_id)
        .eq('arrival_request_id', request_id)
        .maybeSingle();

      if (existing) {
        return res.json({ success: true, duplicate: true, data: { interview: existing } });
      }
    }

    // 1. 更新面試紀錄：onboarding_url + education_linked + arrival_request_id
    const { data: interview, error: e1 } = await supabase
      .from('recruitment_interviews')
      .update({
        onboarding_url,
        education_linked:    true,
        arrival_request_id:  request_id || null,
        updated_at:          new Date().toISOString(),
      })
      .eq('id', interview_id)
      .select(`*, recruitment_applicants(id, name, need_id, target_store_erpid, target_store_name)`)
      .single();

    if (e1) throw e1;

    // 2. 若 applicant 有關聯的 need_id → 自動 +1 filled
    const applicant = interview.recruitment_applicants;
    let need = null;

    if (applicant?.need_id) {
      const { data: cur } = await supabase
        .from('recruitment_needs')
        .select('id, total_needed, filled, status')
        .eq('id', applicant.need_id)
        .maybeSingle();

      if (cur && cur.status === 'open') {
        const newFilled = (cur.filled || 0) + 1;
        const newStatus = newFilled >= cur.total_needed ? 'fulfilled' : 'open';

        const { data: updatedNeed } = await supabase
          .from('recruitment_needs')
          .update({ filled: newFilled, status: newStatus, updated_at: new Date().toISOString() })
          .eq('id', cur.id)
          .select()
          .single();

        need = updatedNeed;
      }
    } else if (applicant?.target_store_erpid) {
      // 若沒有明確 need_id，找同門市最新的 open 需求自動 +1
      const { data: cur } = await supabase
        .from('recruitment_needs')
        .select('id, total_needed, filled, status')
        .eq('store_erpid', applicant.target_store_erpid)
        .eq('status', 'open')
        .order('created_at', { ascending: false })
        .maybeSingle();

      if (cur) {
        const newFilled = (cur.filled || 0) + 1;
        const newStatus = newFilled >= cur.total_needed ? 'fulfilled' : 'open';

        const { data: updatedNeed } = await supabase
          .from('recruitment_needs')
          .update({ filled: newFilled, status: newStatus, updated_at: new Date().toISOString() })
          .eq('id', cur.id)
          .select()
          .single();

        need = updatedNeed;
      }
    }

    console.log(`[Recruitment] 教育系統到職回呼：面試 ${interview_id}，${applicant?.name || '?'}，到職連結已儲存`);
    res.json({ success: true, data: { interview, need } });

  } catch (e) {
    console.error('[Recruitment External arrival]', e.message);
    res.status(500).json({ success: false, message: e.message });
  }
});

module.exports = router;
