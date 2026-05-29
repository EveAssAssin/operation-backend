// routes/vendorPayment.js
// 廠商請款 REST API（系統人員端 + 廠商前台端）
//
// 掛載：
//   /api/vendor-payment        系統人員（需 SSO 登入，會計或以上）
//   /api/vendor-payment/vendor 廠商自助（需廠商 JWT）

const express = require('express');
const router  = express.Router();
const supabase = require('../config/supabase');
const svc      = require('../services/vendorPaymentService');
const { authenticate, authorize } = require('../middleware/auth');

function ok(res, data) { res.json({ success: true, data }); }
function fail(res, e)  {
  console.error('[VendorPayment]', e.message);
  res.status(500).json({ success: false, message: e.message || '伺服器錯誤' });
}

// ════════════════════════════════════════════════════════════
//                  公司付款方資料（admin 才能改）
// ════════════════════════════════════════════════════════════
router.get('/company-profile',
  authenticate,
  async (req, res) => {
    try { ok(res, await svc.getCompanyProfile()); } catch (e) { fail(res, e); }
  });

router.put('/company-profile',
  authenticate, authorize('super_admin', 'dept_head', 'operation_lead'),
  async (req, res) => {
    try { ok(res, await svc.upsertCompanyProfile(req.body || {})); } catch (e) { fail(res, e); }
  });

// ════════════════════════════════════════════════════════════
//                  系統人員端（會計審核）
// ════════════════════════════════════════════════════════════
router.use(authenticate);
router.use(authorize('operation_staff','operation_accounting','operation_hr','operation_lead','dept_head','super_admin'));

// helper
function actorSys(req) { return { actorType: 'system', actorId: req.user?.id }; }

// 銀行帳號
router.get   ('/sources/:sourceId/bank-accounts',
  async (req, res) => { try { ok(res, await svc.listBankAccounts(req.params.sourceId)); } catch (e) { fail(res, e); } });
router.post  ('/sources/:sourceId/bank-accounts',
  async (req, res) => { try { ok(res, await svc.createBankAccount(req.params.sourceId, req.body || {})); } catch (e) { fail(res, e); } });
router.patch ('/bank-accounts/:id',
  async (req, res) => { try { ok(res, await svc.updateBankAccount(req.params.id, req.body || {})); } catch (e) { fail(res, e); } });
router.delete('/bank-accounts/:id',
  async (req, res) => { try { ok(res, await svc.deleteBankAccount(req.params.id)); } catch (e) { fail(res, e); } });

// 請款單
router.get('/requests', async (req, res) => {
  try {
    ok(res, await svc.listRequests({
      source_id: req.query.source_id,
      period:    req.query.period,
      status:    req.query.status,
      keyword:   req.query.keyword,
      limit:     req.query.limit,
    }));
  } catch (e) { fail(res, e); }
});
router.get   ('/requests/:id',
  async (req, res) => { try { ok(res, await svc.getRequest(req.params.id)); } catch (e) { fail(res, e); } });
router.post  ('/requests',
  async (req, res) => { try { ok(res, await svc.createRequest(req.body || {}, actorSys(req))); } catch (e) { fail(res, e); } });
router.patch ('/requests/:id',
  async (req, res) => { try { ok(res, await svc.updateRequest(req.params.id, req.body || {}, actorSys(req))); } catch (e) { fail(res, e); } });
router.delete('/requests/:id',
  async (req, res) => { try { ok(res, await svc.deleteRequest(req.params.id, actorSys(req))); } catch (e) { fail(res, e); } });

router.post('/requests/:id/submit',  async (req, res) => { try { ok(res, await svc.submitRequest(req.params.id, actorSys(req))); }                catch (e) { fail(res, e); } });
router.post('/requests/:id/approve', async (req, res) => { try { ok(res, await svc.approveRequest(req.params.id, req.user?.id)); }              catch (e) { fail(res, e); } });
router.post('/requests/:id/reject',  async (req, res) => { try { ok(res, await svc.rejectRequest(req.params.id, req.body?.reason, req.user?.id)); } catch (e) { fail(res, e); } });
router.post('/requests/:id/mark-paid', async (req, res) => { try { ok(res, await svc.markPaid(req.params.id, req.user?.id)); }                  catch (e) { fail(res, e); } });

// 附件
router.post  ('/requests/:id/files',
  async (req, res) => { try { ok(res, await svc.addFile(req.params.id, req.body || {}, 'system')); } catch (e) { fail(res, e); } });
router.delete('/files/:id',
  async (req, res) => { try { ok(res, await svc.deleteFile(req.params.id)); } catch (e) { fail(res, e); } });

// 發票
router.post  ('/requests/:id/invoices',
  async (req, res) => { try { ok(res, await svc.addInvoice(req.params.id, req.body || {})); } catch (e) { fail(res, e); } });
router.patch ('/invoices/:id',
  async (req, res) => { try { ok(res, await svc.updateInvoice(req.params.id, req.body || {})); } catch (e) { fail(res, e); } });
router.delete('/invoices/:id',
  async (req, res) => { try { ok(res, await svc.deleteInvoice(req.params.id)); } catch (e) { fail(res, e); } });

module.exports = router;
