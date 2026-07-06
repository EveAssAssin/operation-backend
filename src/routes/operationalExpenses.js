// routes/operationalExpenses.js
// 營運費用 REST API
//   GET    /api/operational-expenses                        列出（可篩 ?from=&to=&category_id=&fact_id=&store_erpid=）
//   GET    /api/operational-expenses/:id
//   POST   /api/operational-expenses                        建立（body 可含 allocations）
//   PATCH  /api/operational-expenses/:id                    更新主表欄位
//   DELETE /api/operational-expenses/:id
//   PUT    /api/operational-expenses/:id/allocations        覆寫分帳（body: { allocations: [...] }）
//   GET    /api/operational-expenses/facts/:category_id     取分類底下的 facts（電號下拉用）

const express  = require('express');
const router   = express.Router();
const { authenticate } = require('../middleware/auth');
const svc      = require('../services/operationalExpenseService');

router.use(authenticate);

function ok(res, data)  { res.json({ success: true, data }); }
function bad(res, msg)  { res.status(400).json({ success: false, message: msg }); }
function fail(res, e)   {
  console.error('[OperationalExpenses]', e.message);
  res.status(500).json({ success: false, message: e.message || '伺服器錯誤' });
}

router.get('/', async (req, res) => {
  try { ok(res, await svc.listExpenses(req.query || {})); }
  catch (e) { fail(res, e); }
});

router.get('/facts/:category_id', async (req, res) => {
  try { ok(res, await svc.listFactsByCategory(req.params.category_id)); }
  catch (e) { fail(res, e); }
});

router.get('/:id', async (req, res) => {
  try { ok(res, await svc.getExpense(req.params.id)); }
  catch (e) { fail(res, e); }
});

router.post('/', async (req, res) => {
  try {
    const actor = req.user?.member_id || null;
    ok(res, await svc.createExpense(req.body || {}, actor));
  } catch (e) { fail(res, e); }
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

// ══════════════════════════════════════════════════════════
// 營運報表
// GET /api/operational-expenses/report?from=YYYY-MM&to=YYYY-MM&category_id=&store_erpid=&store_scope=
// GET /api/operational-expenses/report/export?...
// ══════════════════════════════════════════════════════════
const reportSvc = require('../services/opexReportService');
const XLSX      = require('xlsx');

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
// 異常偵測 + 歷史序列
// ══════════════════════════════════════════════════════════
const anomalySvc = require('../services/opexAnomalyService');

router.get('/anomalies', async (req, res) => {
  try {
    const month = req.query.month || new Date().toISOString().slice(0, 7);
    ok(res, await anomalySvc.detectAnomalies(month));
  } catch (e) { fail(res, e); }
});

router.get('/facts/:fact_id/history', async (req, res) => {
  try {
    const months = Math.min(24, parseInt(req.query.months) || 12);
    ok(res, await anomalySvc.getFactHistory(req.params.fact_id, months));
  } catch (e) { fail(res, e); }
});

module.exports = router;
