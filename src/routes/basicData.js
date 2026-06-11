// routes/basicData.js
// 「基本資料」模組 REST API
// 掛載點：/api/basic-data（需登入，operation_staff 以上）

const express = require('express');
const router  = express.Router();
const { authorize } = require('../middleware/auth');
const svc     = require('../services/basicDataService');

router.use(authorize('operation_staff', 'operation_lead', 'dept_head', 'super_admin'));

function ok(res, data)  { res.json({ success: true, data }); }
function bad(res, msg)  { res.status(400).json({ success: false, message: msg }); }
function fail(res, e)   {
  console.error('[BasicData]', e.message);
  res.status(500).json({ success: false, message: e.message || '伺服器錯誤' });
}

function actorFromReq(req) {
  return {
    app_number: req.user?.member_id || null,
    name:       req.user?.name || null,
  };
}

// ── 選項 ─────────────────────────────────────────────────────
router.get   ('/options/stores',           async (req, res) => { try { ok(res, await svc.listStores()); }       catch (e) { fail(res, e); } });
router.post  ('/options/stores',           async (req, res) => { try { ok(res, await svc.createStore(req.body || {})); } catch (e) { fail(res, e); } });
router.delete('/options/stores/:erpid',    async (req, res) => { try { ok(res, await svc.deleteStore(req.params.erpid)); } catch (e) { fail(res, e); } });
router.get   ('/options/system-users',     async (req, res) => { try { ok(res, await svc.listSystemUsers()); }  catch (e) { fail(res, e); } });

// ── 分類 ─────────────────────────────────────────────────────
router.get   ('/categories',     async (req, res) => { try { ok(res, await svc.listCategories()); }                                    catch (e) { fail(res, e); } });
router.post  ('/categories',     async (req, res) => { try { ok(res, await svc.createCategory(req.body || {}, actorFromReq(req))); }   catch (e) { fail(res, e); } });
router.patch ('/categories/:id', async (req, res) => { try { ok(res, await svc.updateCategory(req.params.id, req.body || {}, actorFromReq(req))); } catch (e) { fail(res, e); } });
router.delete('/categories/:id', async (req, res) => { try { ok(res, await svc.deleteCategory(req.params.id, actorFromReq(req))); }    catch (e) { fail(res, e); } });

// ── 欄位 ─────────────────────────────────────────────────────
router.get   ('/categories/:id/fields', async (req, res) => { try { ok(res, await svc.listFields(req.params.id)); }                                     catch (e) { fail(res, e); } });
router.post  ('/categories/:id/fields', async (req, res) => { try { ok(res, await svc.createField(req.params.id, req.body || {}, actorFromReq(req))); } catch (e) { fail(res, e); } });
router.patch ('/fields/:id',            async (req, res) => { try { ok(res, await svc.updateField(req.params.id, req.body || {}, actorFromReq(req))); } catch (e) { fail(res, e); } });
router.delete('/fields/:id',            async (req, res) => { try { ok(res, await svc.deleteField(req.params.id, actorFromReq(req))); }                  catch (e) { fail(res, e); } });

// ── 資料 ─────────────────────────────────────────────────────
router.get   ('/facts',     async (req, res) => {
  try {
    ok(res, await svc.listFacts({
      category_id: req.query.category_id,
      store_erpid: req.query.store_erpid,
      keyword:     req.query.keyword,
    }));
  } catch (e) { fail(res, e); }
});
router.post  ('/facts',     async (req, res) => { try { ok(res, await svc.createFact(req.body || {}, actorFromReq(req))); }              catch (e) { fail(res, e); } });
router.patch ('/facts/:id', async (req, res) => { try { ok(res, await svc.updateFact(req.params.id, req.body || {}, actorFromReq(req))); } catch (e) { fail(res, e); } });
router.delete('/facts/:id', async (req, res) => { try { ok(res, await svc.deleteFact(req.params.id, actorFromReq(req))); }                catch (e) { fail(res, e); } });

// ── 歷史紀錄 ─────────────────────────────────────────────────
router.get('/history', async (req, res) => {
  try {
    ok(res, await svc.listHistory({
      category_id: req.query.category_id,
      store_erpid: req.query.store_erpid,
      limit:       req.query.limit,
    }));
  } catch (e) { fail(res, e); }
});

// ── 推播訂閱 ─────────────────────────────────────────────────
router.get   ('/subscribers',     async (req, res) => { try { ok(res, await svc.listSubscribers()); }                                     catch (e) { fail(res, e); } });
router.post  ('/subscribers',     async (req, res) => { try { ok(res, await svc.upsertSubscriber(req.body || {}, actorFromReq(req))); }   catch (e) { fail(res, e); } });
router.delete('/subscribers/:id', async (req, res) => { try { ok(res, await svc.deleteSubscriber(req.params.id)); }                       catch (e) { fail(res, e); } });

module.exports = router;
