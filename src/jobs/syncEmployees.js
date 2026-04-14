// jobs/syncEmployees.js
// 排程同步作業：每月 5 日 00:30 自動同步人員資料

const cron = require('node-cron');
const { runEmployeeSync } = require('../services/personnelSync');
const { SYNC_TYPE } = require('../config/constants');

const CRON_SCHEDULE = process.env.SYNC_EMPLOYEES_CRON || '30 0 5 * *';
// 預設：每月 5 日 00:30

function startScheduledSync() {
  console.log(`[排程] 人員同步已排程：${CRON_SCHEDULE}`);

  cron.schedule(CRON_SCHEDULE, async () => {
    console.log(`[排程] 開始執行人員自動同步 ${new Date().toISOString()}`);
    try {
      const result = await runEmployeeSync(SYNC_TYPE.SCHEDULED, null);
      console.log(`[排程] 同步完成：`, result);
    } catch (err) {
      console.error(`[排程] 同步失敗：`, err.message);
    }
  }, {
    timezone: 'Asia/Taipei',
  });
}

// 若直接執行此檔案（手動觸發測試）
if (require.main === module) {
  require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
  console.log('[手動] 立即執行一次同步...');
  runEmployeeSync(SYNC_TYPE.MANUAL, null)
    .then(result => { console.log('[手動] 同步結果：', result); process.exit(0); })
    .catch(err  => { console.error('[手動] 同步失敗：', err.message); process.exit(1); });
}

module.exports = { startScheduledSync };
