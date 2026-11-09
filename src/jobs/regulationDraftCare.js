// jobs/regulationDraftCare.js — 規範草稿提醒＋自動清除（2026-11-09 Louis；台北時間）
//   每 15 分：最後動作 3 小時後提醒一次（09:00～21:00）
//   每天 09:30：還有草稿的全部提醒
//   每天 03:00：最後動作超過 24 小時、且之後提醒過 → 清除（expired，可還原）
//   REGULATION_DRAFT_CARE=off 整個停用；細部設定 report_settings.regulation_draft_care
const cron = require('node-cron');
const Care = require('../services/regulationDraftCare');

function startRegulationDraftCareJob() {
  if (String(process.env.REGULATION_DRAFT_CARE || '').toLowerCase() === 'off') { console.log('[RegDraftCare] 已停用'); return; }
  const run = (name, fn) => async () => {
    try { const r = await fn(); if (r && (r.count || (r.expired && r.expired.length) || (r.waiting_remind && r.waiting_remind.length))) console.log(`[RegDraftCare] ${name}`, JSON.stringify(r).slice(0, 800)); }
    catch (e) { console.error(`[RegDraftCare] ${name} 失敗`, e.message); }
  };
  cron.schedule('*/15 * * * *', run('idle', () => Care.remindDrafts({ mode: 'idle' })), { timezone: 'Asia/Taipei' });
  cron.schedule('30 9 * * *', run('daily', () => Care.remindDrafts({ mode: 'daily' })), { timezone: 'Asia/Taipei' });
  cron.schedule('0 3 * * *', run('cleanup', () => Care.cleanupDrafts({})), { timezone: 'Asia/Taipei' });
  console.log('[RegDraftCare] 已排程：每 15 分提醒／09:30 每日提醒／03:00 清除');
}
module.exports = { startRegulationDraftCareJob };
