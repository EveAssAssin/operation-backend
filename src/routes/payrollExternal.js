// routes/payrollExternal.js — 給 lohas-payroll 問「這個 app_number 在營運系統是什麼角色」（2026-11-03）
// 驗證：header x-payroll-key = PAYROLL_SYNC_KEY（兩邊 Render 都設同一把）
// 對應：super_admin／operation_lead → admin；payroll 模組可編 → hr；只能看 → accounting；其他 → null
const express = require('express');
const router = express.Router();
const supabase = require('../config/supabase');
const perm = require('../services/permissionService');

router.get('/payroll-role', async (req, res) => {
  const key = process.env.PAYROLL_SYNC_KEY || '';
  if (!key || req.get('x-payroll-key') !== key) return res.status(403).json({ success: false, message: 'forbidden' });
  const app = String(req.query.app_number || '').trim();
  if (!app) return res.status(400).json({ success: false, message: 'app_number' });
  const { data: u } = await supabase.from('system_users').select('member_id, erpid, name, role, is_active').eq('member_id', app).maybeSingle();
  if (!u || !u.is_active) return res.json({ success: true, data: null });
  const canView = await perm.canAccess(u.role, 'payroll', 'view');
  const canEdit = await perm.canAccess(u.role, 'payroll', 'edit');
  let role = null;
  if (['super_admin', 'operation_lead'].includes(u.role)) role = 'admin';
  else if (canEdit) role = 'hr';
  else if (canView) role = 'accounting';
  return res.json({ success: true, data: { app_number: u.member_id, erpid: u.erpid, name: u.name, op_role: u.role, role } });
});

// ── 給樂維斯「會計助理」的即時讀取（2026-11-09）：同一把 key ──
const keyOk = (req, res, next) => { const key = process.env.PAYROLL_SYNC_KEY || ''; if (!key || req.get('x-payroll-key') !== key) return res.status(403).json({ success: false, message: 'forbidden' }); next(); };
const MR = require('../services/monthlyReport'); const MA = require('../services/monthlyAudit'); const RA = require('../services/reportAi');
const wrapX = (fn) => async (req, res) => { try { res.json({ success: true, data: await fn(req) }); } catch (e) { res.status(500).json({ success: false, message: e.message }); } };
router.get('/report-ai/report', keyOk, wrapX(async (req) => { const r = await MR.build(String(req.query.ym), String(req.query.store), { withLines: true }); const s = RA.summarize(r); s.lines = [...(r.left || []), ...(r.right || [])].flatMap((g) => (g.rows || []).flatMap((row) => (row.lines || []).map((l) => ({ code: row.code, source: l.source, vendor: l.vendor || l.source_name || null, amount: Math.round(Number(l.amount) || 0), memo: l.memo || l.title || l.reason || null, id: l.id || l.ref || null, subject: l.subject_name || null })))).slice(0, 300); return s; }));
router.get('/report-ai/lines', keyOk, wrapX(async (req) => { const r = await MR.build(String(req.query.ym), String(req.query.store), { withLines: true }); const code = req.query.code ? String(req.query.code) : null; return [...(r.left || []), ...(r.right || [])].flatMap((g) => (g.rows || []).filter((row) => !code || row.code === code).flatMap((row) => (row.lines || []).map((l) => ({ code: row.code, code_name: row.name, source: l.source, vendor: l.vendor || l.source_name || null, amount: Math.round(Number(l.amount) || 0), memo: l.memo || l.title || l.reason || null, id: l.id || l.ref || null, subject: l.subject_name || null, fee_ym: l.fee_ym || null })))).slice(0, 400); }));
router.get('/report-ai/audit', keyOk, wrapX(async (req) => { const a = await MA.audit(String(req.query.ym)); const store = req.query.store ? String(req.query.store) : null; return { ym: a.ym, counts: a.counts, findings: a.findings.filter((f) => !store || f.store === store || f.store === '*').map((f) => ({ store: f.store, store_name: f.store_name, sev: f.sev, key: f.key, title: f.title, detail: f.detail ? String(f.detail).slice(0, 300) : null, amount: f.amount, ack: f.ack ? f.ack.status : null })).slice(0, 120) }; }));
router.get('/report-ai/overview', keyOk, wrapX(async (req) => { const o = await MR.overview(String(req.query.ym)); return { ym: o.ym, stores: o.stores.map((s) => ({ store: s.store, name: s.store_name, status: s.status, total_in: s.total_in, total_out: s.total_out, profit: s.profit, error: s.error })) }; }));
module.exports = router;
