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

// ════════════════════════════════════════════════════════════
//           廠商請款 (vendor_payment_requests)
// ════════════════════════════════════════════════════════════
const vpSvc = require('../services/vendorPaymentService');

function vpOk(res, data) { res.json({ success: true, data }); }
function vpFail(res, e) {
  console.error('[VendorPayment][vendor]', e.message);
  res.status(500).json({ success: false, message: e.message || '伺服器錯誤' });
}
function actorVendor(req) {
  return { actorType: 'vendor', actorId: req.vendor?.id };
}

// 廠商自己的銀行帳號
router.get('/bank-accounts', authenticateVendor, async (req, res) => {
  try { vpOk(res, await vpSvc.listBankAccounts(req.vendor.source_id)); }
  catch (e) { vpFail(res, e); }
});
router.post('/bank-accounts', authenticateVendor, async (req, res) => {
  try { vpOk(res, await vpSvc.createBankAccount(req.vendor.source_id, req.body || {})); }
  catch (e) { vpFail(res, e); }
});
router.patch('/bank-accounts/:id', authenticateVendor, async (req, res) => {
  // 確認此帳號屬於當前 vendor
  const { data: bank } = await supabase.from('vendor_bank_accounts')
    .select('source_id').eq('id', req.params.id).maybeSingle();
  if (!bank || bank.source_id !== req.vendor.source_id) {
    return res.status(403).json({ success: false, message: '無權編輯此銀行帳號' });
  }
  try { vpOk(res, await vpSvc.updateBankAccount(req.params.id, req.body || {})); }
  catch (e) { vpFail(res, e); }
});
router.delete('/bank-accounts/:id', authenticateVendor, async (req, res) => {
  const { data: bank } = await supabase.from('vendor_bank_accounts')
    .select('source_id').eq('id', req.params.id).maybeSingle();
  if (!bank || bank.source_id !== req.vendor.source_id) {
    return res.status(403).json({ success: false, message: '無權刪除此銀行帳號' });
  }
  try { vpOk(res, await vpSvc.deleteBankAccount(req.params.id)); }
  catch (e) { vpFail(res, e); }
});

// 廠商基本資料（讀寫 billing_sources 的有限欄位）
router.get('/profile', authenticateVendor, async (req, res) => {
  try {
    const { data, error } = await supabase.from('billing_sources')
      .select('id, name, short_name, code, tax_id, contact_name, contact_phone, contact_email, contact_line_id, address, notes')
      .eq('id', req.vendor.source_id).maybeSingle();
    if (error) throw new Error(error.message);
    vpOk(res, data);
  } catch (e) { vpFail(res, e); }
});
router.patch('/profile', authenticateVendor, async (req, res) => {
  try {
    const allowed = {};
    ['short_name','contact_name','contact_phone','contact_email','contact_line_id','address','notes']
      .forEach(k => { if (req.body?.[k] !== undefined) allowed[k] = req.body[k]; });
    const { data, error } = await supabase.from('billing_sources')
      .update(allowed).eq('id', req.vendor.source_id).select().single();
    if (error) throw new Error(error.message);
    vpOk(res, data);
  } catch (e) { vpFail(res, e); }
});

// 廠商請款單（只看自己的）
router.get('/requests', authenticateVendor, async (req, res) => {
  try {
    vpOk(res, await vpSvc.listRequests({
      source_id: req.vendor.source_id,
      period:    req.query.period,
      status:    req.query.status,
      keyword:   req.query.keyword,
    }));
  } catch (e) { vpFail(res, e); }
});

router.get('/requests/:id', authenticateVendor, async (req, res) => {
  try {
    const r = await vpSvc.getRequest(req.params.id);
    if (r.source_id !== req.vendor.source_id) {
      return res.status(403).json({ success: false, message: '無權檢視' });
    }
    vpOk(res, r);
  } catch (e) { vpFail(res, e); }
});

router.post('/requests', authenticateVendor, async (req, res) => {
  try {
    const body = { ...(req.body || {}), source_id: req.vendor.source_id };
    vpOk(res, await vpSvc.createRequest(body, actorVendor(req)));
  } catch (e) { vpFail(res, e); }
});

router.patch('/requests/:id', authenticateVendor, async (req, res) => {
  try { vpOk(res, await vpSvc.updateRequest(req.params.id, req.body || {}, actorVendor(req))); }
  catch (e) { vpFail(res, e); }
});

router.delete('/requests/:id', authenticateVendor, async (req, res) => {
  try { vpOk(res, await vpSvc.deleteRequest(req.params.id, actorVendor(req))); }
  catch (e) { vpFail(res, e); }
});

router.post('/requests/:id/submit', authenticateVendor, async (req, res) => {
  try { vpOk(res, await vpSvc.submitRequest(req.params.id, actorVendor(req))); }
  catch (e) { vpFail(res, e); }
});

// 附件（廠商只能對自己的請款上傳）
// 附件：只收真的上傳（2026-10-20 起不再收廠商自己帶的 file_url）
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });
async function ownEditable(req, res) {
  const { data: r } = await supabase.from('vendor_payment_requests').select('source_id, status, created_by_vendor').eq('id', req.params.id).maybeSingle();
  if (!r || r.source_id !== req.vendor.source_id) { res.status(403).json({ success: false, message: '無權操作' }); return false; }
  if (!['draft', 'rejected'].includes(r.status)) { res.status(400).json({ success: false, message: '已送審的請款不能再改，要改請聯絡樂活會計' }); return false; }
  return true;
}
router.post('/requests/:id/files', authenticateVendor, (req, res) => res.status(410).json({ success: false, message: '請用上傳檔案' }));
router.post('/requests/:id/upload', authenticateVendor, upload.single('file'), async (req, res) => {
  try {
    if (!(await ownEditable(req, res))) return;
    if (!req.file) return res.status(400).json({ success: false, message: '請附上檔案' });
    vpOk(res, await vpSvc.uploadRequestFile(req.params.id, { buffer: req.file.buffer, mimeType: req.file.mimetype,
      originalName: Buffer.from(req.file.originalname || '', 'latin1').toString('utf8'), file_type: req.query.file_type }, 'vendor'));
  } catch (e) { res.status(400).json({ success: false, message: e.message }); }
});
// 分配門市：項目名稱／金額／門市（請款總額＝合計）
router.get('/targets', authenticateVendor, async (req, res) => { try { vpOk(res, await vpSvc.listTargets()); } catch (e) { vpFail(res, e); } });
router.put('/requests/:id/allocations', authenticateVendor, async (req, res) => {
  try {
    if (!(await ownEditable(req, res))) return;
    vpOk(res, await vpSvc.saveAllocations(req.params.id, (req.body || {}).rows, { actorType: 'vendor', actorId: req.vendor.id }));
  } catch (e) { res.status(400).json({ success: false, message: e.message }); }
});

// 我的合約（合約管理裡「廠商」選這家、且勾了給廠商看）
router.get('/contracts', authenticateVendor, async (req, res) => {
  try {
    const { data, error } = await supabase.from('contracts')
      .select('id, type, name, status, start_date, end_date, signed_date, monthly_amount, total_amount, type_data, file_url')
      .eq('source_id', req.vendor.source_id).eq('vendor_visible', true).neq('status', 'archived').order('start_date', { ascending: false });
    if (error) throw new Error(error.message);
    const ids = (data || []).map((c) => c.id);
    const { data: files } = ids.length ? await supabase.from('attachments').select('id, entity_id, original_name, storage_path, mime_type, size_bytes')
      .eq('entity_type', 'contract').in('entity_id', ids) : { data: [] };
    const paths = (files || []).map((f) => f.storage_path).filter(Boolean);
    const { data: signed } = paths.length ? await supabase.storage.from('attachments').createSignedUrls(paths, 3600) : { data: [] };
    const url = new Map((signed || []).map((x) => [x.path, x.signedUrl]));
    vpOk(res, (data || []).map((c) => {
      const td = c.type_data || {};
      return { id: c.id, name: c.name, status: c.status, start_date: c.start_date, end_date: c.end_date, signed_date: c.signed_date, total_amount: c.total_amount,
        benefits: td.benefits || null, terms: td.terms || td.payment_terms || null,
        files: (files || []).filter((f) => f.entity_id === c.id).map((f) => ({ id: f.id, name: f.original_name, mime: f.mime_type, url: url.get(f.storage_path) || null }))
          .concat(c.file_url && !(files || []).some((f) => f.entity_id === c.id) ? [{ id: 'main', name: '合約檔案', url: c.file_url }] : []) };
    }));
  } catch (e) { vpFail(res, e); }
});

router.delete('/files/:id', authenticateVendor, async (req, res) => {
  const { data: file } = await supabase.from('vendor_payment_files')
    .select('request_id').eq('id', req.params.id).maybeSingle();
  if (!file) return res.status(404).json({ success: false, message: '找不到附件' });
  const { data: req_row } = await supabase.from('vendor_payment_requests')
    .select('source_id, status').eq('id', file.request_id).maybeSingle();
  if (req_row?.source_id !== req.vendor.source_id) {
    return res.status(403).json({ success: false, message: '無權刪除' });
  }
  if (!['draft','rejected'].includes(req_row.status)) {
    return res.status(400).json({ success: false, message: '已送審的請款不能刪附件' });
  }
  try { await vpSvc.removeStoredFile(req.params.id); vpOk(res, await vpSvc.deleteFile(req.params.id)); }
  catch (e) { vpFail(res, e); }
});

module.exports = router;
