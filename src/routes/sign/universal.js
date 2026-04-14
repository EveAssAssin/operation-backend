// routes/sign/universal.js
// ═══════════════════════════════════════════════════════════════
// 通用簽收 API — 模組註冊制
//
// 新系統只需：
//   1. 寫一個 handler（參考 handlers/maintenance.js）
//   2. 在下方 require + register
//   3. 前端加一個 Content 元件
// ═══════════════════════════════════════════════════════════════

const express  = require('express');
const crypto   = require('crypto');
const router   = express.Router();
const supabase = require('../../config/supabase');
const { register, getHandler, getAllTypes } = require('./registry');

// ── 註冊所有簽收模組 ─────────────────────────────────────────
// 營運部系統的簽收 handler 在此註冊
// register(require('./handlers/xxx'));
// 未來新增：
// register(require('./handlers/workorder'));
// register(require('./handlers/inspection'));

// ── LIFF / QR 設定 ──────────────────────────────────────────
const LIFF_ID      = process.env.LINE_LIFF_ID || '';  // 營運部 LIFF ID（需設定）
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';

// ── 工具 ─────────────────────────────────────────────────────
function getTaipeiNow() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
}

// ── 查 token：先查新表 sign_tokens，再向下相容查舊表 ────────
async function resolveToken(tokenStr) {
  // 1. 新表 sign_tokens
  const { data: st } = await supabase
    .from('sign_tokens')
    .select('*')
    .eq('token', tokenStr)
    .single();

  if (st) {
    return { source: 'unified', tokenData: st, type: st.type, referenceId: st.reference_id };
  }

  // 2. 向下相容 — 舊 maintenance_sign_tokens
  const { data: mt } = await supabase
    .from('maintenance_sign_tokens')
    .select('*')
    .eq('token', tokenStr)
    .single();
  if (mt) {
    return { source: 'legacy', tokenData: mt, type: 'maintenance', referenceId: mt.order_id };
  }

  // 3. 向下相容 — 舊 repair_sign_tokens
  const { data: rt } = await supabase
    .from('repair_sign_tokens')
    .select('*')
    .eq('token', tokenStr)
    .single();
  if (rt) {
    return { source: 'legacy', tokenData: rt, type: 'repair', referenceId: rt.repair_ticket_id };
  }

  return null;
}

// ── 共通 token 檢查 ─────────────────────────────────────────
function checkTokenValidity(tokenData) {
  if (tokenData.used_at) {
    return { valid: false, status: 400, message: '此 QR Code 已使用，簽收已完成' };
  }
  if (new Date(tokenData.expires_at) < getTaipeiNow()) {
    return { valid: false, status: 400, message: 'QR Code 已過期，請工務師重新產生' };
  }
  return { valid: true };
}

// ── 標記 token 已使用 ───────────────────────────────────────
async function markTokenUsed(resolved, employee) {
  const now = getTaipeiNow().toISOString();
  const { source, tokenData, type } = resolved;

  // 只更新 used_at（確定存在的欄位），簽收人資訊由 handler.confirmSign 寫入主表
  const table = source === 'unified' ? 'sign_tokens'
    : type === 'maintenance' ? 'maintenance_sign_tokens'
    : type === 'repair' ? 'repair_sign_tokens'
    : null;

  if (!table) return;

  const { error: updateErr } = await supabase
    .from(table)
    .update({ used_at: now })
    .eq('id', tokenData.id);

  if (updateErr) {
    console.error('[Universal] token 標記已使用失敗:', updateErr.message, 'source:', source, 'type:', type);
    throw new Error('簽收處理失敗（token 更新異常）');
  }
}

// ============================================================
// POST /api/sign/universal/generate-token
// 通用產生 QR Code token
// Body: { type, reference_id, expires_hours? }
// ============================================================
router.post('/generate-token', async (req, res) => {
  try {
    const { type, reference_id, expires_hours = 2 } = req.body;

    if (!type || !reference_id) {
      return res.status(400).json({ success: false, message: '請提供 type 和 reference_id' });
    }

    const handler = getHandler(type);
    if (!handler) {
      return res.status(400).json({
        success: false,
        message: `不支援的簽收類型：${type}`,
        supported: getAllTypes(),
      });
    }

    // 驗證單據狀態
    const validation = await handler.validateStatus(reference_id);
    if (!validation.valid) {
      return res.status(400).json({ success: false, message: validation.message });
    }

    // 刪除舊 token
    await supabase.from('sign_tokens').delete().eq('type', type).eq('reference_id', reference_id);

    // 產生新 token
    const token     = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + expires_hours * 60 * 60 * 1000).toISOString();

    const { data: tokenData, error: insertErr } = await supabase
      .from('sign_tokens')
      .insert({
        type,
        reference_id,
        token,
        expires_at: expiresAt,
      })
      .select()
      .single();

    if (insertErr) throw insertErr;

    // 組合 URL
    const liffUrl = `https://liff.line.me/${LIFF_ID}?liff.state=${encodeURIComponent('?token=' + token)}`;
    const webUrl  = `${FRONTEND_URL}/sign?token=${token}`;

    res.status(201).json({
      success: true,
      data: {
        token,
        type,
        expires_at: expiresAt,
        sign_url:   liffUrl,
        web_url:    webUrl,
      },
    });
  } catch (err) {
    console.error('[Universal Generate Token]', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ============================================================
// GET /api/sign/universal/verify/:token
// 驗證 token（Web 備援，不需 LINE UID）
// ============================================================
router.get('/verify/:token', async (req, res) => {
  try {
    const resolved = await resolveToken(req.params.token);
    if (!resolved) {
      return res.status(404).json({ success: false, message: 'QR Code 無效或已失效' });
    }

    const check = checkTokenValidity(resolved.tokenData);
    if (!check.valid) {
      return res.status(check.status).json({ success: false, message: check.message });
    }

    const handler = getHandler(resolved.type);
    if (!handler) {
      return res.status(400).json({ success: false, message: `不支援的簽收類型：${resolved.type}` });
    }

    // 驗證單據狀態
    const validation = await handler.validateStatus(resolved.referenceId);
    if (!validation.valid) {
      return res.status(400).json({ success: false, message: validation.message });
    }

    // 取得顯示內容
    const content = await handler.getContent(resolved.referenceId);

    res.json({
      success: true,
      type:    resolved.type,
      label:   handler.label,
      data:    { ...content, token: req.params.token, expires_at: resolved.tokenData.expires_at },
    });
  } catch (err) {
    console.error('[Universal Verify]', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ============================================================
// GET /api/sign/universal/:token
// LIFF 驗證（帶 LINE UID）
// Query: ?line_uid=Uxxxxxxx
// ============================================================
router.get('/:token', async (req, res) => {
  try {
    const { line_uid } = req.query;

    if (!line_uid) {
      return res.status(400).json({ success: false, message: '缺少 LINE UID，請透過 LINE App 掃描 QR Code' });
    }

    const resolved = await resolveToken(req.params.token);
    if (!resolved) {
      return res.status(404).json({ success: false, message: 'QR Code 無效或已失效' });
    }

    const check = checkTokenValidity(resolved.tokenData);
    if (!check.valid) {
      return res.status(check.status).json({ success: false, message: check.message });
    }

    // 驗證 LINE UID → 員工
    const { data: employee, error: empErr } = await supabase
      .from('employees')
      .select('id, app_number, name, jobtitle, store_erpid, store_name, line_uid')
      .eq('line_uid', line_uid)
      .eq('is_active', true)
      .single();

    if (empErr || !employee) {
      return res.status(403).json({
        success: false,
        message: `您的 LINE 帳號尚未綁定或不在有效員工清單中（LINE UID: ${line_uid}）`,
        line_uid,
      });
    }

    const handler = getHandler(resolved.type);
    if (!handler) {
      return res.status(400).json({ success: false, message: `不支援的簽收類型：${resolved.type}` });
    }

    // 驗證單據狀態
    const validation = await handler.validateStatus(resolved.referenceId);
    if (!validation.valid) {
      return res.status(400).json({ success: false, message: validation.message });
    }

    // 門市比對
    const storeErpid = await handler.getStoreErpid(resolved.referenceId);
    if (storeErpid && employee.store_erpid !== storeErpid) {
      // 取得門市名稱
      const content = await handler.getContent(resolved.referenceId);
      const storeName = content?.store_name || storeErpid;
      return res.status(403).json({
        success: false,
        message: `您是「${employee.store_name}」的員工，無法替「${storeName}」簽收。請由該門市人員掃描 QR Code。`,
      });
    }

    // 取得顯示內容
    const content = await handler.getContent(resolved.referenceId);

    res.json({
      success:  true,
      type:     resolved.type,
      label:    handler.label,
      data:     { ...content, token: req.params.token, expires_at: resolved.tokenData.expires_at },
      employee: {
        name:       employee.name,
        jobtitle:   employee.jobtitle,
        store_name: employee.store_name,
        store_erpid: employee.store_erpid,
      },
    });
  } catch (err) {
    console.error('[Universal LIFF Verify]', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ============================================================
// POST /api/sign/universal/confirm
// 通用簽收確認
// Body: { token, line_uid? , app_number? }
// ============================================================
router.post('/confirm', async (req, res) => {
  try {
    const { token, line_uid, app_number } = req.body;

    if (!token) {
      return res.status(400).json({ success: false, message: '請提供 token' });
    }
    if (!line_uid && !app_number) {
      return res.status(400).json({ success: false, message: '請提供 LINE UID 或員工編號' });
    }

    const resolved = await resolveToken(token);
    if (!resolved) {
      return res.status(404).json({ success: false, message: 'Token 無效' });
    }

    const check = checkTokenValidity(resolved.tokenData);
    if (!check.valid) {
      return res.status(check.status).json({ success: false, message: check.message });
    }

    // 驗證員工
    let empQuery = supabase.from('employees').select('id, app_number, name, store_erpid, store_name, line_uid');
    if (line_uid) {
      empQuery = empQuery.eq('line_uid', line_uid);
    } else {
      empQuery = empQuery.eq('app_number', app_number);
    }
    const { data: employee, error: empErr } = await empQuery.eq('is_active', true).single();

    if (empErr || !employee) {
      const idType = line_uid ? `LINE UID (${line_uid})` : `員工編號 (${app_number})`;
      return res.status(403).json({ success: false, message: `身分驗證失敗：${idType} 未綁定有效員工` });
    }

    const handler = getHandler(resolved.type);
    if (!handler) {
      return res.status(400).json({ success: false, message: `不支援的簽收類型：${resolved.type}` });
    }

    // 門市比對
    const storeErpid = await handler.getStoreErpid(resolved.referenceId);
    if (storeErpid && employee.store_erpid !== storeErpid) {
      const content = await handler.getContent(resolved.referenceId);
      const storeName = content?.store_name || storeErpid;
      return res.status(403).json({
        success: false,
        message: `您是「${employee.store_name}」的員工，無法替「${storeName}」簽收。請由該門市人員操作。`,
      });
    }

    // 標記 token 已使用
    await markTokenUsed(resolved, employee);

    // 呼叫對應 handler 執行簽收邏輯
    const result = await handler.confirmSign(resolved.referenceId, {
      id:         employee.id,
      name:       employee.name,
      app_number: employee.app_number,
      line_uid:   employee.line_uid || line_uid,
    });

    res.json({
      success: true,
      type:    resolved.type,
      label:   handler.label,
      data:    result,
      message: `${handler.label}簽收成功`,
    });
  } catch (err) {
    console.error('[Universal Confirm]', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ============================================================
// GET /api/sign/universal/types
// 取得所有已註冊的簽收類型（debug/admin 用）
// ============================================================
router.get('/meta/types', (req, res) => {
  const types = getAllTypes().map(t => {
    const h = getHandler(t);
    return { type: t, label: h.label };
  });
  res.json({ success: true, types });
});

module.exports = router;
