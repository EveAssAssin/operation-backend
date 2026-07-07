// routes/chiVendors.js
// 路奇創意科技鏡片來源 (chi-finance) 的廠商代號 ↔ 中文名對照
//
// GET    /api/chi-vendors           list（管理面板 + 篩選下拉都用這隻）
// POST   /api/chi-vendors           手動新增（一般由 sync auto-upsert，這隻是備援）
// PATCH  /api/chi-vendors/:code     改中文名 / 啟停用 / 排序

const express  = require('express');
const router   = express.Router();
const { authorize } = require('../middleware/auth');
const supabase = require('../config/supabase');

// GET list —— 所有登入者都可讀（篩選下拉要用）
router.get('/', async (req, res) => {
  try {
    const includeInactive = req.query.include_inactive === 'true' || req.query.include_inactive === '1';
    let q = supabase
      .from('chi_vendors')
      .select('code, name, is_active, display_order, updated_at')
      .order('display_order', { ascending: true })
      .order('code',          { ascending: true });
    if (!includeInactive) q = q.eq('is_active', true);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST 手動新增
router.post('/', authorize('billing.manage'), async (req, res) => {
  try {
    const { code, name, display_order = 0 } = req.body || {};
    if (!code || !name) return res.status(400).json({ success: false, message: '缺少 code / name' });
    const now = new Date().toISOString();
    const { data, error } = await supabase
      .from('chi_vendors')
      .insert({ code: String(code).trim(), name: String(name).trim(), display_order, updated_at: now })
      .select()
      .single();
    if (error) throw new Error(error.message);
    res.status(201).json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// PATCH 改名字 / 啟停用 / 排序
router.patch('/:code', authorize('billing.manage'), async (req, res) => {
  try {
    const allowed = ['name', 'is_active', 'display_order'];
    const payload = { updated_at: new Date().toISOString() };
    for (const k of allowed) if (req.body[k] !== undefined) payload[k] = req.body[k];
    if (Object.keys(payload).length === 1) {
      return res.status(400).json({ success: false, message: '沒有可更新的欄位' });
    }
    const { data, error } = await supabase
      .from('chi_vendors')
      .update(payload)
      .eq('code', req.params.code)
      .select()
      .single();
    if (error) throw new Error(error.message);
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
