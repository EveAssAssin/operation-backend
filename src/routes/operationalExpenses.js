// routes/operationalExpenses.js
// 營運費用 REST API
//
// 注意：Express router 是按定義順序匹配的，所以 static path (/report, /anomalies, /facts/...)
//       必須放在動態 /:id 之前，否則會被 UUID 驗證擋掉

const express  = require('express');
const router   = express.Router();
const { authenticate } = require('../middleware/auth');
const svc      = require('../services/operationalExpenseService');
const reportSvc  = require('../services/opexReportService');
const anomalySvc = require('../services/opexAnomalyService');
const XLSX       = require('xlsx');

router.use(authenticate);

function ok(res, data)  { res.json({ success: true, data }); }
function bad(res, msg)  { res.status(400).json({ success: false, message: msg }); }
function fail(res, e)   {
  console.error('[OperationalExpenses]', e.message);
  res.status(500).json({ success: false, message: e.message || '伺服器錯誤' });
}

// ══════════════════════════════════════════════════════════
// (1) LIST + POST
// ══════════════════════════════════════════════════════════
router.get('/', async (req, res) => {
  try { ok(res, await svc.listExpenses(req.query || {})); }
  catch (e) { fail(res, e); }
});

router.post('/', async (req, res) => {
  try {
    const actor = req.user?.member_id || null;
    ok(res, await svc.createExpense(req.body || {}, actor));
  } catch (e) { fail(res, e); }
});

// ══════════════════════════════════════════════════════════
// (2) 營運報表（靜態 path，必須先於 /:id 定義）
// ══════════════════════════════════════════════════════════
router.get('/report', async (req, res) => {
  try {
    const opts = {
      from:        req.query.from,
      to:          req.query.to,
      categoryId:  req.query.category_id || null,
      storeErpid:  req.query.store_erpid || null,
      storeScope:  req.query.store_scope || 'all',
    };
    ok(res, await reportSvc.getReport(opts));
  } catch (e) { fail(res, e); }
});

router.get('/report/export', async (req, res) => {
  try {
    const opts = {
      from:        req.query.from,
      to:          req.query.to,
      categoryId:  req.query.category_id || null,
      storeErpid:  req.query.store_erpid || null,
      storeScope:  req.query.store_scope || 'all',
    };
    const data = await reportSvc.getReport(opts);
    const wsSummary = XLSX.utils.json_to_sheet(data.summary);
    const wsDetail  = XLSX.utils.json_to_sheet(data.detail);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, wsSummary, '月度彙總');
    XLSX.utils.book_append_sheet(wb, wsDetail, '明細');
    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    const filename = `營運報表_${opts.from}_${opts.to}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
    res.send(buffer);
  } catch (e) { fail(res, e); }
});

// ══════════════════════════════════════════════════════════
// (3) 異常偵測（靜態 path）
// ══════════════════════════════════════════════════════════
router.get('/anomalies', async (req, res) => {
  try {
    const month = req.query.month || new Date().toISOString().slice(0, 7);
    ok(res, await anomalySvc.detectAnomalies(month));
  } catch (e) { fail(res, e); }
});

// ══════════════════════════════════════════════════════════
// (4) facts 相關（靜態 path）
// ══════════════════════════════════════════════════════════
router.get('/facts/:category_id', async (req, res) => {
  try { ok(res, await svc.listFactsByCategory(req.params.category_id)); }
  catch (e) { fail(res, e); }
});

router.get('/facts/:fact_id/history', async (req, res) => {
  try {
    const months = Math.min(24, parseInt(req.query.months) || 12);
    ok(res, await anomalySvc.getFactHistory(req.params.fact_id, months));
  } catch (e) { fail(res, e); }
});

// ══════════════════════════════════════════════════════════

// ══════════════════════════════════════════════════════════
// (5) 動態 /:id 路由（放最後）
// ══════════════════════════════════════════════════════════
router.get('/:id', async (req, res) => {
  try { ok(res, await svc.getExpense(req.params.id)); }
  catch (e) { fail(res, e); }
});

router.patch('/:id', async (req, res) => {
  try { ok(res, await svc.updateExpense(req.params.id, req.body || {})); }
  catch (e) { fail(res, e); }
});

router.delete('/:id', async (req, res) => {
  try { ok(res, await svc.deleteExpense(req.params.id)); }
  catch (e) { fail(res, e); }
});

router.put('/:id/allocations', async (req, res) => {
  try {
    const allocs = Array.isArray(req.body?.allocations) ? req.body.allocations : [];
    ok(res, await svc.replaceAllocations(req.params.id, allocs));
  } catch (e) { fail(res, e); }
});

module.exports = router;
