// routes/ledger.js —— 門市月報帳本（P0，2026-10-20）
// 規劃：app/pet-feature/PLAN_門市月報與開帳_20261020.md
//   GET /api/ledger/accounts                 科目表
//   GET /api/ledger/lines?ym=2026-09[&store=120085]   帳本每一列（店、科目、金額、來源、原始單）
//   GET /api/ledger/summary?ym=2026-09[&store=]       每店×科目加總
// 權限：先限後台 billing 模組「查看」；店長看自己門市（只看金額）等 P1 月報頁再開
const express = require('express');
const router = express.Router();
const supabase = require('../config/supabase');
const { authenticate, authorizeModule } = require('../middleware/auth');

router.use(authenticate, authorizeModule('billing', 'view'));

const YM = /^\d{4}-(0[1-9]|1[0-2])$/;
const fail = (res, e) => { console.error('[ledger]', e.message); res.status(500).json({ success: false, message: e.message }); };

router.get('/accounts', async (req, res) => {
  try {
    const { data, error } = await supabase.from('ledger_accounts').select('*').order('sort_order');
    if (error) throw error;
    res.json({ success: true, data });
  } catch (e) { fail(res, e); }
});

async function rpc(fn, req, res) {
  const ym = String(req.query.ym || '');
  if (!YM.test(ym)) return res.status(400).json({ success: false, message: 'ym 要是 YYYY-MM' });
  try {
    let q = supabase.rpc(fn, { p_ym: ym });
    if (req.query.store) q = q.eq('store_erpid', String(req.query.store));
    const { data, error } = await q;
    if (error) throw error;
    res.json({ success: true, ym, data });
  } catch (e) { fail(res, e); }
}
router.get('/lines',   (req, res) => rpc('ledger_lines', req, res));
router.get('/summary', (req, res) => rpc('ledger_store_month', req, res));

module.exports = router;
