// jobs/syncBilling.js
// 開帳系統：每日增量同步排程
// 每天凌晨 02:00 自動拉取市場系統最新帳單資料

const cron = require('node-cron');
const { incrementalSync } = require('../services/billingService');

/**
 * 啟動每日帳單同步排程
 * 時間：每天 02:00（Asia/Taipei）
 */
function startBillingScheduledSync() {
  // 每天 02:00 執行
  cron.schedule('0 2 * * *', async () => {
    console.log('[BillingSync] 定時增量同步開始...');
    try {
      const result = await incrementalSync();
      console.log(`[BillingSync] 增量同步完成，更新 ${result.orders_synced} 筆`);
    } catch (err) {
      console.error('[BillingSync] 增量同步失敗：', err.message);
    }
  }, { timezone: 'Asia/Taipei' });

  console.log('[BillingSync] 每日帳單同步排程已啟動（每天 02:00）');
}

module.exports = { startBillingScheduledSync };
