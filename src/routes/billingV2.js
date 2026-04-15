// routes/billingV2.js
// 開帳系統 v2 API：來源單位 / 會計科目 / 帳單 / 分配 / 月報 / 廠商帳號

const express = require('express');
const router  = express.Router();
const bcrypt  = require('bcryptjs');
const { authenticate, authorize } = require('../middleware/auth');
const svc      = require('../services/billingV2Service');
const supabase = require('../config/supabase');

// 所有路由需登入
router.use(authenticate);

// ============================================================
// 來源單位（/sources）
// ============================================================

/**
 * GET /api/billing-v2/sources
 * 取得所有來源單位
 * query: source_type=admin_dept|vendor|operational, is_active=true|false
 */
router.get('/sources', async (req, res) => {
  try {
    const { source_type, is_active } = req.query;
    const opts = {};
    if (source_type) opts.source_type = source_type;
    if (is_active !== undefined) opts.is_active = is_active === 'true';
    const data = await svc.getSources(opts);
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * GET /api/billing-v2/sources/:id
 * 取得單一來源單位
 */
router.get('/sources/:id', async (req, res) => {
  try {
    const data = await svc.getSourceById(req.params.id);
    res.json({ success: true, data });
  } catch (err) {
    res.status(404).json({ success: false, message: err.message });
  }
});

/**
 * POST /api/billing-v2/sources
 * 建立來源單位（operation_lead 以上）
 * body: { source_type, code, name, dept_erpid, contact_name, contact_phone, contact_email, notes }
 */
router.post('/sources', authorize('billing.manage'), async (req, res) => {
  try {
    const { source_type, code, name, dept_erpid, contact_name, contact_phone, contact_email, notes } = req.body;
    if (!source_type || !name) {
      return res.status(400).json({ success: false, message: '缺少必填欄位：source_type, name' });
    }
    const data = await svc.createSource({ source_type, code, name, dept_erpid, contact_name, contact_phone, contact_email, notes });
    res.status(201).json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * PATCH /api/billing-v2/sources/:id
 * 更新來源單位（operation_lead 以上）
 */
router.patch('/sources/:id', authorize('billing.manage'), async (req, res) => {
  try {
    const allowed = ['code','name','dept_erpid','contact_name','contact_phone','contact_email','notes','is_active'];
    const payload = {};
    allowed.forEach(k => { if (req.body[k] !== undefined) payload[k] = req.body[k]; });

    const data = await svc.updateSource(req.params.id, payload);
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ============================================================
// 會計科目（/sources/:sourceId/categories）
// ============================================================

/**
 * GET /api/billing-v2/sources/:sourceId/categories
 * 取得某來源單位的會計科目
 * query: all=true 包含停用
 */
router.get('/sources/:sourceId/categories', async (req, res) => {
  try {
    const onlyActive = req.query.all !== 'true';
    const data = await svc.getCategories(req.params.sourceId, onlyActive);
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * POST /api/billing-v2/sources/:sourceId/categories
 * 建立會計科目
 * body: { code, name, description, sort_order }
 */
router.post('/sources/:sourceId/categories', authorize('billing.manage'), async (req, res) => {
  try {
    const { code, name, description, sort_order } = req.body;
    if (!name) return res.status(400).json({ success: false, message: '缺少必填欄位：name' });
    const data = await svc.createCategory(req.params.sourceId, { code, name, description, sort_order });
    res.status(201).json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * PATCH /api/billing-v2/categories/:id
 * 更新會計科目
 */
router.patch('/categories/:id', authorize('billing.manage'), async (req, res) => {
  try {
    const allowed = ['code','name','description','sort_order','is_active'];
    const payload = {};
    allowed.forEach(k => { if (req.body[k] !== undefined) payload[k] = req.body[k]; });
    const data = await svc.updateCategory(req.params.id, payload);
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ============================================================
// 帳單（/bills）
// ============================================================

/**
 * GET /api/billing-v2/bills
 * 查詢帳單列表
 * query: period=YYYY-MM, source_id, status, page, limit
 */
router.get('/bills', async (req, res) => {
  try {
    const { period, source_id, status, page = 1, limit = 20 } = req.query;
    const result = await svc.getBills({
      period, source_id, status,
      page:  parseInt(page),
      limit: parseInt(limit),
    });
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * GET /api/billing-v2/bills/:id
 * 取得帳單詳情（含分配明細）
 */
router.get('/bills/:id', async (req, res) => {
  try {
    const data = await svc.getBillById(req.params.id);
    res.json({ success: true, data });
  } catch (err) {
    res.status(404).json({ success: false, message: err.message });
  }
});

/**
 * POST /api/billing-v2/bills
 * 建立帳單（operation_staff 以上）
 * body: {
 *   source_id, accounting_category_id, period, title, description,
 *   total_amount, invoice_no, invoice_date, attachment_urls, notes,
 *   allocations: [{ store_erpid, store_name, allocated_amount, allocation_note }]
 * }
 */
router.post('/bills', authorize('billing.create'), async (req, res) => {
  try {
    const {
      source_id, accounting_category_id, period, title, description,
      total_amount, invoice_no, invoice_date, attachment_urls, notes,
      allocations = [],
    } = req.body;

    if (!source_id || !period || !title || total_amount === undefined) {
      return res.status(400).json({
        success: false,
        message: '缺少必填欄位：source_id, period, title, total_amount',
      });
    }

    const data = await svc.createBill(
      {
        source_id, accounting_category_id, period, title, description,
        total_amount, invoice_no, invoice_date,
        attachment_urls: attachment_urls || [],
        notes,
        status: 'draft',
      },
      allocations,
      'system',
      req.user.id,
    );

    res.status(201).json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * PATCH /api/billing-v2/bills/:id
 * 更新帳單基本資訊（僅 draft 狀態）
 */
router.patch('/bills/:id', authorize('billing.create'), async (req, res) => {
  try {
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
 * PUT /api/billing-v2/bills/:id/allocations
 * 更新帳單門市分配（全量替換，僅 draft）
 * body: { allocations: [{ store_erpid, store_name, allocated_amount, allocation_note }] }
 */
router.put('/bills/:id/allocations', authorize('billing.create'), async (req, res) => {
  try {
    const { allocations = [] } = req.body;
    await svc.updateBillAllocations(req.params.id, allocations);
    const data = await svc.getBillById(req.params.id);
    res.json({ success: true, data });
  } catch (err) {
    const code = err.message.includes('只有草稿') ? 422 : 500;
    res.status(code).json({ success: false, message: err.message });
  }
});

/**
 * POST /api/billing-v2/bills/:id/submit
 * 送審帳單（draft → submitted）
 */
router.post('/bills/:id/submit', authorize('billing.create'), async (req, res) => {
  try {
    const data = await svc.changeBillStatus(req.params.id, 'submitted', req.user.id);
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * POST /api/billing-v2/bills/:id/confirm
 * 確認帳單（submitted → confirmed，operation_lead 以上）
 */
router.post('/bills/:id/confirm', authorize('billing.confirm'), async (req, res) => {
  try {
    const data = await svc.changeBillStatus(req.params.id, 'confirmed', req.user.id);
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * POST /api/billing-v2/bills/:id/distribute
 * 分配至門市（confirmed → distributed，operation_lead 以上）
 */
router.post('/bills/:id/distribute', authorize('billing.confirm'), async (req, res) => {
  try {
    const data = await svc.changeBillStatus(req.params.id, 'distributed', req.user.id);
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * POST /api/billing-v2/bills/:id/void
 * 作廢帳單（operation_lead 以上）
 * body: { void_reason }
 */
router.post('/bills/:id/void', authorize('billing.confirm'), async (req, res) => {
  try {
    const { void_reason } = req.body;
    const data = await svc.changeBillStatus(req.params.id, 'void', req.user.id, { void_reason });
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ============================================================
// 月報
// ============================================================

/**
 * GET /api/billing-v2/report/:period
 * 取得某月份門市帳單彙總
 */
router.get('/report/:period', async (req, res) => {
  try {
    const { period } = req.params;
    if (!/^\d{4}-\d{2}$/.test(period)) {
      return res.status(400).json({ success: false, message: 'period 格式應為 YYYY-MM' });
    }
    const data = await svc.getMonthSummaryV2(period);
    res.json({ success: true, period, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ============================================================
// 廠商帳號管理（/vendors，後台管理員用）
// ============================================================

/**
 * GET /api/billing-v2/vendors
 * 取得所有廠商帳號（含對應來源單位）
 * query: source_id, is_active
 */
router.get('/vendors', authorize('billing.manage'), async (req, res) => {
  try {
    const { source_id, is_active } = req.query;

    let query = supabase
      .from('vendor_accounts')
      .select(`
        id, username, is_active, last_login_at, created_at, notes,
        billing_sources!source_id ( id, name, source_type )
      `)
      .order('created_at', { ascending: false });

    if (source_id) query = query.eq('source_id', source_id);
    if (is_active !== undefined) query = query.eq('is_active', is_active === 'true');

    const { data, error } = await query;
    if (error) throw new Error(error.message);
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * POST /api/billing-v2/vendors
 * 建立廠商帳號
 * body: { source_id, username, password, notes }
 */
router.post('/vendors', authorize('billing.manage'), async (req, res) => {
  try {
    const { source_id, username, password, notes } = req.body;
    if (!source_id || !username || !password) {
      return res.status(400).json({
        success: false,
        message: '缺少必填欄位：source_id, username, password',
      });
    }

    // 確認來源單位存在且為 vendor 類型
    const { data: source, error: srcErr } = await supabase
      .from('billing_sources')
      .select('id, name, source_type')
      .eq('id', source_id)
      .single();

    if (srcErr || !source) {
      return res.status(400).json({ success: false, message: '找不到此來源單位' });
    }
    if (source.source_type !== 'vendor') {
      return res.status(400).json({ success: false, message: '只有廠商類型的來源單位可建立登入帳號' });
    }

    // 確認帳號不重複
    const { data: existing } = await supabase
      .from('vendor_accounts')
      .select('id')
      .eq('username', username)
      .maybeSingle();

    if (existing) {
      return res.status(400).json({ success: false, message: '帳號名稱已被使用' });
    }

    const password_hash = await bcrypt.hash(password, 10);

    const { data, error } = await supabase
      .from('vendor_accounts')
      .insert({
        source_id, username, password_hash, notes,
        is_active:  true,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .select(`
        id, username, is_active, last_login_at, created_at, notes,
        billing_sources!source_id ( id, name, source_type )
      `)
      .single();

    if (error) throw new Error(error.message);
    res.status(201).json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * PATCH /api/billing-v2/vendors/:id
 * 更新廠商帳號（啟用/停用、重設密碼、備註）
 * body: { is_active, password, notes }
 */
router.patch('/vendors/:id', authorize('billing.manage'), async (req, res) => {
  try {
    const { is_active, password, notes } = req.body;
    const update = { updated_at: new Date().toISOString() };

    if (is_active !== undefined) update.is_active = is_active;
    if (notes     !== undefined) update.notes     = notes;
    if (password) {
      if (password.length < 6) {
        return res.status(400).json({ success: false, message: '密碼至少 6 個字元' });
      }
      update.password_hash = await bcrypt.hash(password, 10);
    }

    const { data, error } = await supabase
      .from('vendor_accounts')
      .update(update)
      .eq('id', req.params.id)
      .select(`
        id, username, is_active, last_login_at, created_at, notes,
        billing_sources!source_id ( id, name, source_type )
      `)
      .single();

    if (error) throw new Error(error.message);
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
