// routes/recruitmentExternal.js
// 人力招募模組：跨系統公開端點（API Key 驗證，不需 SSO 登入）
// 供市場部後端直接呼叫，通知營運部門市缺人需求

const express  = require('express');
const router   = express.Router();
const supabase = require('../config/supabase');

const MARKET_API_KEY = process.env.MARKET_RECRUITMENT_API_KEY || '';

// ── API Key 驗證 middleware ───────────────────────────────
function verifyApiKey(req, res, next) {
  if (!MARKET_API_KEY) {
    return res.status(503).json({ success: false, message: '尚未設定 MARKET_RECRUITMENT_API_KEY' });
  }
  const key = req.headers['x-api-key'];
  if (!key || key !== MARKET_API_KEY) {
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
router.post('/needs', verifyApiKey, async (req, res) => {
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

module.exports = router;
