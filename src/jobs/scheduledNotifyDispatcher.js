// jobs/scheduledNotifyDispatcher.js
// 排程推播 dispatcher
// 每分鐘掃 scheduled_notifications.next_run_at <= now 的排程，觸發推播

const cron = require('node-cron');
const svc  = require('../services/scheduledNotifyService');

let isRunning = false;   // 防重入：避免上一輪還沒跑完又被觸發

async function tick() {
  if (isRunning) {
    console.log('[ScheduledNotifyDispatcher] 上一輪還在跑，跳過');
    return;
  }
  isRunning = true;
  try {
    await svc.runDueNotifications();
  } catch (e) {
    console.error('[ScheduledNotifyDispatcher] tick 失敗:', e.message);
  } finally {
    isRunning = false;
  }
}

function startScheduledNotifyDispatcher() {
  // 每分鐘的第 5 秒檢查（避開整點，分散 DB 壓力）
  cron.schedule('5 * * * * *', tick, { timezone: 'Asia/Taipei' });
  console.log('[ScheduledNotifyDispatcher] 啟動：每分鐘掃描到期排程');
}

module.exports = { startScheduledNotifyDispatcher, tick };
