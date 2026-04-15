// routes/dashboard.js
// 首頁今日重點：聚合端點，統一代理各外部系統 + 查本地 DB
// 每個模組獨立 try-catch，某模組掛掉不影響其他

const express  = require('express');
const router   = express.Router();
const axios    = require('axios');
const supabase = require('../config/supabase');
const { authenticate } = require('../middleware/auth');

router.use(authenticate);

// ── 工具：今天台北日期 ────────────────────────────────────
function todayTaipei() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' });
}

// ══════════════════════════════════════════════════════════
// 工務部模組：查本地 Supabase
// ══════════════════════════════════════════════════════════
async function getEngineeringHighlight() {
  const today = todayTaipei();

  // ── A / B：保養排程（今日 + 逾期）──────────────────────
  const [{ data: maintToday }, { data: maintOverdue }] = await Promise.all([
    supabase
      .from('maintenance_schedules')
      .select('id, store_name, engineer_name, scheduled_date, maintenance_orders(id, status)')
      .eq('scheduled_date', today)
      .neq('status', 'cancelled'),
    supabase
      .from('maintenance_schedules')
      .select('id, store_name, engineer_name, scheduled_date, maintenance_orders(id, status)')
      .lt('scheduled_date', today)
      .neq('status', 'cancelled'),
  ]);

  // ── C / D：報修排程（今日 + 逾期）──────────────────────
  const [{ data: repairToday }, { data: repairOverdue }] = await Promise.all([
    supabase
      .from('repair_schedules')
      .select('id, scheduled_date, repair_tickets(id, store_name, engineer_name, status, ticket_no)')
      .eq('scheduled_date', today),
    supabase
      .from('repair_schedules')
      .select('id, scheduled_date, repair_tickets(id, store_name, engineer_name, status, ticket_no)')
      .lt('scheduled_date', today),
  ]);

  // ── 狀態判斷：保養 ─────────────────────────────────────
  function maintExec(order) {
    if (!order) return { exec_status: 'not_started', exec_label: '未開始' };
    const m = { completed: ['completed', '已完成（已簽收）'], pending_sign: ['pending_sign', '已完工（待簽收）'], draft: ['in_progress', '進行中'] };
    return m[order.status]
      ? { exec_status: m[order.status][0], exec_label: m[order.status][1] }
      : { exec_status: 'not_started', exec_label: '未開始' };
  }

  // ── 狀態判斷：報修 ─────────────────────────────────────
  function repairExec(ticket) {
    if (!ticket) return { exec_status: 'not_started', exec_label: '未開始' };
    const m = { signed: ['completed', '已簽收'], completed: ['pending_sign', '已完工'], in_progress: ['in_progress', '維修中'], scheduled: ['scheduled', '排定維修'] };
    return m[ticket.status]
      ? { exec_status: m[ticket.status][0], exec_label: m[ticket.status][1] }
      : { exec_status: 'not_started', exec_label: '未開始' };
  }

  // ── 組裝保養列表（逾期在前）────────────────────────────
  const maintenanceItems = [];

  for (const s of (maintOverdue || [])) {
    const order = Array.isArray(s.maintenance_orders) ? s.maintenance_orders[0] : s.maintenance_orders;
    const { exec_status } = maintExec(order);
    if (exec_status === 'completed') continue; // 逾期但已完成 → 過濾
    maintenanceItems.push({
      store_name: s.store_name, engineer_name: s.engineer_name,
      scheduled_date: s.scheduled_date, order_id: order?.id || null,
      exec_status: 'overdue',
      exec_label: `超時（原定 ${s.scheduled_date}）`,
      is_overdue: true,
    });
  }
  for (const s of (maintToday || [])) {
    const order = Array.isArray(s.maintenance_orders) ? s.maintenance_orders[0] : s.maintenance_orders;
    maintenanceItems.push({
      store_name: s.store_name, engineer_name: s.engineer_name,
      scheduled_date: s.scheduled_date, order_id: order?.id || null,
      ...maintExec(order),
      is_overdue: false,
    });
  }

  // ── 組裝報修列表（逾期在前）────────────────────────────
  const repairItems = [];

  for (const s of (repairOverdue || [])) {
    const ticket = Array.isArray(s.repair_tickets) ? s.repair_tickets[0] : s.repair_tickets;
    if (!ticket) continue;
    const { exec_status } = repairExec(ticket);
    if (exec_status === 'completed') continue; // 逾期但已完成 → 過濾
    repairItems.push({
      store_name: ticket.store_name, engineer_name: ticket.engineer_name,
      scheduled_date: s.scheduled_date,
      ticket_id: ticket.id, ticket_no: ticket.ticket_no,
      exec_status: 'overdue',
      exec_label: `超時（原定 ${s.scheduled_date}）`,
      is_overdue: true,
    });
  }
  for (const s of (repairToday || [])) {
    const ticket = Array.isArray(s.repair_tickets) ? s.repair_tickets[0] : s.repair_tickets;
    if (!ticket) continue;
    repairItems.push({
      store_name: ticket.store_name, engineer_name: ticket.engineer_name,
      scheduled_date: s.scheduled_date,
      ticket_id: ticket.id, ticket_no: ticket.ticket_no,
      ...repairExec(ticket),
      is_overdue: false,
    });
  }

  // ── 摘要統計 ───────────────────────────────────────────
  const countBy = (arr, status) => arr.filter(i => i.exec_status === status).length;
  const summary = {
    maintenance: {
      total:       maintenanceItems.length,
      completed:   countBy(maintenanceItems, 'completed'),
      in_progress: countBy(maintenanceItems, 'in_progress'),
      overdue:     countBy(maintenanceItems, 'overdue'),
      not_started: countBy(maintenanceItems, 'not_started'),
    },
    repair: {
      total:       repairItems.length,
      completed:   countBy(repairItems, 'completed') + countBy(repairItems, 'pending_sign'),
      in_progress: countBy(repairItems, 'in_progress'),
      overdue:     countBy(repairItems, 'overdue'),
      scheduled:   countBy(repairItems, 'scheduled'),
    },
  };

  return { maintenance: maintenanceItems, repair: repairItems, summary };
}

// ══════════════════════════════════════════════════════════
// GET /api/dashboard/highlights
// 聚合所有模組的今日重點
// ══════════════════════════════════════════════════════════
router.get('/highlights', async (req, res) => {
  const { date } = req.query;
  const params   = date ? { date } : {};
  const results  = {};

  // ── 教育訓練（外部 API）────────────────────────────────
  try {
    const r = await axios.get(
      'https://lohas-lms-backend.onrender.com/external/training-highlight',
      { headers: { 'x-api-key': 'lohas-highlight-2026' }, params, timeout: 10000 }
    );
    results.training = { success: true, data: r.data };
  } catch (e) {
    results.training = { success: false, message: e.response?.data?.message || e.message };
  }

  // ── 工務部（本地 Supabase）─────────────────────────────
  try {
    results.engineering = { success: true, data: await getEngineeringHighlight() };
  } catch (e) {
    results.engineering = { success: false, message: e.message };
  }

  // ── 未來其他模組在此新增 ───────────────────────────────

  res.json({ success: true, data: results });
});

module.exports = router;
