// routes/vendor.js
// 廠商後台獨立入口：廠商登入 + 廠商帳單管理
// 與系統用戶完全分開，廠商只能看到自己的帳單

const express = require('express');
const router  = express.Router();
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const supabase = require('../config/supabase');
const svc      = require('../services/billingV2Service');

const JWT_SECRET  = process.env.VENDOR_JWT_SECRET || process.env.JWT_SECRET || 'vendor-secret-change-me';
const JWT_EXPIRES = '8h';

// ── 廠商 JWT 驗證 middleware ────────────────────────────────
const authenticateVendor = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, message: '未提供認證 Token' });
    }

    const token = authHeader.substring(7);
    let payload;
    try {
      payload = jwt.verify(token, JWT_SECRET);
    } catch {
      return res.status(401).json({ success: false, message: 'Token 無效或已過期' });
    }

    if (payload.type !== 'vendor') {
      return res.status(403).json({ success: false, message: '非廠商 Token' });
    }

    // 查廠商帳號
    const { data: account, error } = await supabase
      .from('vendor_accounts')
      .select('id, source_id, username, is_active')
      .eq('id', payload.accountId)
      .single();

    if (error || !account || !account.is_active) {
      return res.status(403).json({ success: false, message: '廠商帳號不存在或已停用' });
    }

    // 查來源單位
    const { data: source } = await supabase
      .from('billing_sources')
      .select('id, name, source_type, is_active')
      .eq('id', account.source_id)
      .single();

    if (!source || !source.is_active) {
      return res.status(403).json({ success: false, message: '對應廠商已停用' });
    }

    req.vendor = { ...account, source };
    next();
  } catch (err) {
    console.error('[VendorAuth] 驗證失敗：', err.message);
    return res.status(500).json({ success: false, message: '認證服務異常' });
  }
};

// ============================================================
// 廠商登入
// ============================================================

/**
 * POST /api/vendor/login
 * 廠商登入
 * body: { username, password }
 */
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ success: false, message: '請提供帳號與密碼' });
    }

    // 查廠商帳號
    const { data: account, error } = await supabase
      .from('vendor_accounts')
      .select('id, source_id, username, password_hash, is_active')
      .eq('username', username)
      .single();

    if (error || !account) {
      return res.status(401).json({ success: false, message: '帳號或密碼錯誤' });
    }

    if (!account.is_active) {
      return res.status(403).json({ success: false, message: '此廠商帳號已停用，請聯絡管理員' });
    }

    // 驗證密碼
    const valid = await bcrypt.compare(password, account.password_hash);
    if (!valid) {
      return res.status(401).json({ success: false, message: '帳號或密碼錯誤' });
    }

    // 查來源單位
    const { data: source } = await supabase
      .from('billing_sources')
      .select('id, name, source_type')
      .eq('id', account.source_id)
      .single();

    // 更新最後登入時間
    await supabase
      .from('vendor_accounts')
      .update({ last_login_at: new Date().toISOString() })
      .eq('id', account.id);

    // 簽發 JWT
    const token = jwt.sign(
      { type: 'vendor', accountId: account.id, sourceId: account.source_id },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES }
    );

    res.json({
      success: true,
      token,
      vendor: {
        id:          account.id,
        username:    account.username,
        source_id:   account.source_id,
        source_name: source?.name,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * GET /api/vendor/me
 * 取得目前廠商資訊
 */
router.get('/me', authenticateVendor, async (req, res) => {
  const { id, username, source } = req.vendor;
  res.json({
    success: true,
    data: { id, username, source_id: source.id, source_name: source.name },
  });
});

// ============================================================
// 廠商帳單（只能看自己的，只能建立 / 修改草稿）
// ============================================================

/**
 * GET /api/vendor/bills
 * 取得自己廠商的帳單列表
 * query: period, status, page, limit
 */
router.get('/bills', authenticateVendor, async (req, res) => {
  try {
    const { period, status, page = 1, limit = 20 } = req.query;
    const result = await svc.getBills({
      source_id: req.vendor.source_id,
      period, status,
      page: parseInt(page), limit: parseInt(limit),
    });
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * GET /api/vendor/bills/:id
 * 取得帳單詳情（確認是自己的帳單）
 */
router.get('/bills/:id', authenticateVendor, async (req, res) => {
  try {
    const data = await svc.getBillById(req.params.id);
    if (data.source_id !== req.vendor.source_id) {
      return res.status(403).json({ success: false, message: '無權查看此帳單' });
    }
    res.json({ success: true, data });
  } catch (err) {
    res.status(404).json({ success: false, message: err.message });
  }
});

/**
 * POST /api/vendor/bills
 * 廠商建立帳單（draft）
 * body: {
 *   accounting_category_id, period, title, description,
 *   total_amount, invoice_no, invoice_date, attachment_urls, notes
 * }
 * 注意：廠商不能設定 allocations，由後台確認後分配
 */
router.post('/bills', authenticateVendor, async (req, res) => {
  try {
    const {
      accounting_category_id, period, title, description,
      total_amount, invoice_no, invoice_date, attachment_urls, notes,
    } = req.body;

    if (!period || !title || total_amount === undefined) {
      return res.status(400).json({
        success: false,
        message: '缺少必填欄位：period, title, total_amount',
      });
    }

    // 確認 accounting_category 屬於自己的來源單位
    if (accounting_category_id) {
      const { data: cat } = await supabase
        .from('accounting_categories')
        .select('id, source_id')
        .eq('id', accounting_category_id)
        .single();
      if (!cat || cat.source_id !== req.vendor.source_id) {
        return res.status(400).json({ success: false, message: '不可使用此會計科目' });
      }
    }

    const data = await svc.createBill(
      {
        source_id: req.vendor.source_id,
        accounting_category_id, period, title, description,
        total_amount, invoice_no, invoice_date,
        attachment_urls: attachment_urls || [],
        notes,
        status: 'draft',
      },
      [],  // 廠商不設定分配，由後台處理
      'vendor',
      req.vendor.id,
    );

    res.status(201).json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * PATCH /api/vendor/bills/:id
 * 廠商更新草稿帳單
 */
router.patch('/bills/:id', authenticateVendor, async (req, res) => {
  try {
    // 確認是自己的帳單
    const existing = await svc.getBillById(req.params.id);
    if (existing.source_id !== req.vendor.source_id) {
      return res.status(403).json({ success: false, message: '無權修改此帳單' });
    }

    const allowed = [
      'accounting_category_id','period','title','description',
      'total_amount','invoice_no','invoice_date','attachment_urls','notes',
    ];
    const payload = {};
    allowed.forEach(k => { if (req.body[k] !== undefined) payload[k] = req.body[k]; });

    const data = await svc.updateBill(req.params.id, payload);
    res.json({ success: true, data });
  } catch (err) {
    const code = err.message.includes('只有草稿') ? 422 : 500;
    res.status(code).json({ success: false, message: err.message });
  }
});

/**
 * POST /api/vendor/bills/:id/submit
 * 廠商送審帳單（draft → submitted）
 */
router.post('/bills/:id/submit', authenticateVendor, async (req, res) => {
  try {
    const existing = await svc.getBillById(req.params.id);
    if (existing.source_id !== req.vendor.source_id) {
      return res.status(403).json({ success: false, message: '無權操作此帳單' });
    }
    if (existing.status !== 'draft') {
      return res.status(422).json({ success: false, message: '只有草稿狀態可以送審' });
    }

    const data = await svc.changeBillStatus(req.params.id, 'submitted', null);
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * GET /api/vendor/categories
 * 廠商取得自己的會計科目
 */
router.get('/categories', authenticateVendor, async (req, res) => {
  try {
    const data = await svc.getCategories(req.vendor.source_id, true);
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
