// routes/liveReport.js —— 即時月報設定（營運部）：鏡片成本表、參數、校正紀錄、手動重算、預覽（2026-11-17）
// 只有營運部（operation_*）與超級管理員
const express = require('express');
const router = express.Router();
const supabase = require('../config/supabase');
const LR = require('../services/liveReport');
const job = require('../jobs/liveReportDaily');

const canUse = (u) => { const r = String((u && u.role) || ''); return r === 'super_admin' || r.startsWith('operation_'); };
router.use((req, res, next) => (canUse(req.user) ? next() : res.status(403).json({ success: false, message: '只有營運部可以用' })));
const w = (fn) => async (req, res) => { try { res.json({ success: true, data: await fn(req) }); } catch (e) { res.status(400).json({ success: false, message: e.message }); } };
const who = (req) => (req.user && (req.user.name || req.user.member_id)) || null;

// 鏡片成本表＋最近賣出卻沒有成本的品項
router.get('/lens-costs', w(async () => {
  const [{ data: rows }, { data: unk }] = await Promise.all([
    supabase.from('live_lens_costs').select('*').order('brand').order('catena').order('name').limit(5000),
    supabase.from('report_settings').select('value').eq('key', 'live_report_unknown').maybeSingle(),
  ]);
  const u = (unk && unk.value) || {};
  const sold = Object.fromEntries((u.lens || []).filter((x) => x.bind).map((x) => [String(x.bind), x.n]));
  return { rows: (rows || []).map((r) => ({ ...r, sold_no_cost: sold[String(r.bind_id)] || 0 })), unknown: u.lens || [], unknown_at: u.day || null };
}));
router.put('/lens-costs/:bind', w(async (req) => {
  const bind = Number(req.params.bind); if (!(bind > 0)) throw new Error('bind_id 不對');
  const b = req.body || {};
  const cost = b.cost === '' || b.cost == null ? null : Number(b.cost);
  if (cost != null && !(cost >= 0)) throw new Error('成本要是 0 以上的數字');
  const row = { bind_id: bind, cost, note: b.note != null ? String(b.note).slice(0, 200) : undefined, updated_by: who(req), updated_at: new Date().toISOString() };
  if (b.name) Object.assign(row, { name: String(b.name).slice(0, 120), brand: b.brand || null, catena: b.catena || null, model: b.model || null });
  const { data, error } = await supabase.from('live_lens_costs').upsert(row, { onConflict: 'bind_id' }).select('*').single();
  if (error) throw new Error(error.message);
  return data;
}));
router.get('/settings', w(async () => LR.settings()));
router.put('/settings', w(async (req) => {
  const b = req.body || {}; const cur = await LR.settings();
  const v = { ...cur };
  for (const k of ['contact_ratio', 'lab_fee', 'ship_fee', 'hist_months']) if (b[k] != null && b[k] !== '') { const n = Number(b[k]); if (!(n >= 0)) throw new Error(`${k} 不對`); v[k] = n; }
  if (v.contact_ratio > 1) throw new Error('隱眼成本比例要 0～1（例 0.65）');
  await supabase.from('report_settings').upsert({ key: 'live_report', value: v, updated_by: who(req), updated_at: new Date().toISOString() }, { onConflict: 'key' });
  return v;
}));
router.get('/calibration', w(async () => {
  const [{ data }, f] = await Promise.all([supabase.from('live_calibration').select('*').order('ym', { ascending: false }).order('key').limit(120), LR.factors()]);
  return { rows: data || [], current: f };
}));
// 手動重算（背景跑，幾分鐘）
router.post('/run', w(async (req) => {
  if (job.isRunning()) return { running: true };
  const b = req.body || {};
  job.run({ day: /^\d{4}-\d{2}-\d{2}$/.test(String(b.day || '')) ? b.day : undefined, stores: Array.isArray(b.stores) ? b.stores : undefined }).catch((e) => console.error('[liveReport run]', e.message));
  return { started: true };
}));
router.get('/status', w(async () => {
  const { data } = await supabase.from('live_reports').select('store_erpid, ym, day, payload->totals, payload->store_name').order('day', { ascending: false }).limit(60);
  return { running: job.isRunning(), latest: data || [] };
}));
router.get('/store/:store', w(async (req) => LR.latest(req.params.store, req.query.ym || null)));
module.exports = router;
