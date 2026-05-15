// routes/processes/admin.js
// 各類流程 — 管理端（需登入）
//
// 模板：
//   GET    /api/processes/templates?store_erpid=
//   GET    /api/processes/templates/:id
//   POST   /api/processes/templates
//   PATCH  /api/processes/templates/:id
//   DELETE /api/processes/templates/:id
//
// 交接：
//   GET    /api/processes/handovers?status=&store_erpid=&limit=
//   GET    /api/processes/handovers/:id
//   POST   /api/processes/handovers          (從模板 / 自訂品項建立)
//   POST   /api/processes/handovers/:id/cancel
//
// 選單：
//   GET    /api/processes/options/stores

const express  = require('express');
const router   = express.Router();
const supabase = require('../../config/supabase');
const { authorize } = require('../../middleware/auth');
const handover = require('../../services/handoverService');

router.use(authorize('operation_staff', 'operation_lead', 'dept_head', 'super_admin'));

function ok(res, data)        { res.json({ success: true, data }); }
function bad(res, msg, c=400) { res.status(c).json({ success: false, message: msg }); }
function fail(res, e, p='Processes') {
  console.error(`[${p}]`, e.message);
  res.status(500).json({ success: false, message: e.message });
}

// ════════════════════════════════════════════════════════════
// 門市選項（從 employees 表 distinct）
// ════════════════════════════════════════════════════════════
router.get('/options/stores', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('employees')
      .select('store_erpid, store_name')
      .eq('is_active', true);
    if (error) throw error;

    const map = new Map();
    for (const r of data || []) {
      if (r.store_erpid && !map.has(r.store_erpid)) {
        map.set(r.store_erpid, { erpid: r.store_erpid, name: r.store_name || r.store_erpid });
      }
    }
    const list = Array.from(map.values()).sort((a, b) => (a.name || '').localeCompare(b.name || '', 'zh-TW'));
    ok(res, list);
  } catch (e) { fail(res, e); }
});

// ════════════════════════════════════════════════════════════
// 模板
// ════════════════════════════════════════════════════════════
router.get('/templates', async (req, res) => {
  try {
    const { store_erpid } = req.query;
    let q = supabase
      .from('handover_templates')
      .select('*')
      .order('store_name', { ascending: true })
      .order('created_at', { ascending: false });
    if (store_erpid) q = q.eq('store_erpid', store_erpid);

    const { data, error } = await q;
    if (error) throw error;
    ok(res, data);
  } catch (e) { fail(res, e); }
});

router.get('/templates/:id', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('handover_templates').select('*').eq('id', req.params.id).single();
    if (error) {
      if (error.code === 'PGRST116') return bad(res, '找不到模板', 404);
      throw error;
    }
    ok(res, data);
  } catch (e) { fail(res, e); }
});

router.post('/templates', async (req, res) => {
  try {
    const { store_erpid, store_name, name, items, is_active } = req.body || {};
    if (!store_erpid || !store_name) return bad(res, 'store_erpid / store_name 為必填');
    if (!Array.isArray(items)) return bad(res, 'items 必須為陣列');

    const { data, error } = await supabase
      .from('handover_templates')
      .insert({
        store_erpid,
        store_name,
        name: name || '預設交接表',
        items,
        is_active: is_active !== false,
        created_by_id: req.user?.id || null,
        created_by_name: req.user?.name || '營運部',
      })
      .select()
      .single();
    if (error) throw error;
    ok(res, data);
  } catch (e) { fail(res, e); }
});

router.patch('/templates/:id', async (req, res) => {
  try {
    const { name, items, is_active } = req.body || {};
    const patch = { updated_at: new Date().toISOString() };
    if (name !== undefined) patch.name = name;
    if (items !== undefined) patch.items = items;
    if (is_active !== undefined) patch.is_active = !!is_active;

    const { data, error } = await supabase
      .from('handover_templates').update(patch).eq('id', req.params.id).select().single();
    if (error) throw error;
    ok(res, data);
  } catch (e) { fail(res, e); }
});

router.delete('/templates/:id', async (req, res) => {
  try {
    const { error } = await supabase
      .from('handover_templates').delete().eq('id', req.params.id);
    if (error) throw error;
    ok(res, { ok: true });
  } catch (e) { fail(res, e); }
});

// ════════════════════════════════════════════════════════════
// 交接
// ════════════════════════════════════════════════════════════
router.get('/handovers', async (req, res) => {
  try {
    const { stage, store_erpid } = req.query;
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);

    let q = supabase
      .from('handovers')
      .select('id, store_erpid, store_name, stage, original_name, original_filled_at, new_name, new_filled_at, third_name, third_confirmed_at, created_by_name, created_at')
      .order('created_at', { ascending: false })
      .limit(limit);

    if (stage)       q = q.eq('stage', stage);
    if (store_erpid) q = q.eq('store_erpid', store_erpid);

    const { data, error } = await q;
    if (error) throw error;
    ok(res, data);
  } catch (e) { fail(res, e); }
});

router.get('/handovers/:id', async (req, res) => {
  try {
    const data = await handover.getHandover(req.params.id);
    ok(res, data);
  } catch (e) { fail(res, e); }
});

router.post('/handovers', async (req, res) => {
  try {
    const { template_id, custom_items, store_erpid, store_name } = req.body || {};
    const created = await handover.createHandoverFromTemplate({
      templateId: template_id || null,
      customItems: custom_items || null,
      store_erpid, store_name,
      user: req.user,
    });
    ok(res, created);
  } catch (e) { fail(res, e); }
});

router.post('/handovers/:id/cancel', async (req, res) => {
  try {
    const { reason } = req.body || {};
    const data = await handover.cancelHandover(req.params.id, reason);
    ok(res, data);
  } catch (e) { fail(res, e); }
});

module.exports = router;
