// routes/paymentBatch.js
// 匯款批次 REST API
// 掛載：/api/payment-batch（需登入，會計以上）

const express = require('express');
const router  = express.Router();
const { authorize } = require('../middleware/auth');
const svc     = require('../services/paymentBatchService');

router.use(authorize('operation_staff', 'operation_accounting', 'operation_hr', 'operation_lead', 'dept_head', 'super_admin'));

function ok(res, data)  { res.json({ success: true, data }); }
function fail(res, e)   {
  console.error('[PaymentBatch]', e.message);
  res.status(500).json({ success: false, message: e.message || '伺服器錯誤' });
}

// 批次 CRUD
router.get('/batches', async (req, res) => {
  try {
    ok(res, await svc.list({
      status:            req.query.status,
      payment_date_from: req.query.payment_date_from,
      payment_date_to:   req.query.payment_date_to,
      limit:             req.query.limit,
    }));
  } catch (e) { fail(res, e); }
});

router.get   ('/batches/:id', async (req, res) => { try { ok(res, await svc.get(req.params.id)); } catch (e) { fail(res, e); } });
router.post  ('/batches',     async (req, res) => { try { ok(res, await svc.createBatch(req.body || {}, req.user?.id)); } catch (e) { fail(res, e); } });

// 可加入批次的請款（已通過 + 未在任何批次中）
router.get('/eligible-requests', async (req, res) => {
  try { ok(res, await svc.listEligibleRequests({ period: req.query.period })); }
  catch (e) { fail(res, e); }
});

// 匯出元大 xlsx
router.get('/batches/:id/export', async (req, res) => {
  try {
    const { buffer, filename } = await svc.exportBatch(req.params.id, req.user?.id);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
    res.send(buffer);
  } catch (e) { fail(res, e); }
});

// 標記已撥款
router.post('/batches/:id/mark-paid', async (req, res) => {
  try { ok(res, await svc.markBatchPaid(req.params.id, req.user?.id)); }
  catch (e) { fail(res, e); }
});

// 取消批次
router.post('/batches/:id/cancel', async (req, res) => {
  try { ok(res, await svc.cancelBatch(req.params.id, req.body?.reason, req.user?.id)); }
  catch (e) { fail(res, e); }
});

// 進項發票
router.get('/input-invoices', async (req, res) => {
  try { ok(res, await svc.listInputInvoices(req.query.period)); }
  catch (e) { fail(res, e); }
});

router.get('/input-invoices/export', async (req, res) => {
  try {
    const period = req.query.period;
    const { buffer, filename } = await svc.exportInputInvoicesCsv(period, req.user?.id);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
    res.send(buffer);
  } catch (e) { fail(res, e); }
});

router.get('/input-invoices/export-log', async (req, res) => {
  try { ok(res, await svc.listExportLog({ limit: req.query.limit })); }
  catch (e) { fail(res, e); }
});

module.exports = router;
