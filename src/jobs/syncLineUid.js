// jobs/syncLineUid.js
// 排程：LINE UID 同步（每天 01:00 自動執行）

const cron = require('node-cron');
const { runLineUidSync } = require('../services/lineUidSync');

const CRON_SCHEDULE = process.env.SYNC_LINE_UID_CRON || '0 1 * * *';
// 預設：每天 01:00

function startLineUidScheduledSync() {
  console.log(`[排程] LINE UID 同步已排程：${CRON_SCHEDULE}`);

  cron.schedule(CRON_SCHEDULE, async () => {
    console.log(`[排程] 開始 LINE UID 自動同步 ${new Date().toISOString()}`);
    try {
      const result = await runLineUidSync(null);
      console.log(`[排程] LINE UID 同步完成：`, result);
    } catch (err) {
      console.error(`[排程] LINE UID 同步失敗：`, err.message);
    }
  }, {
    timezone: 'Asia/Taipei',
  });
}

// 若直接執行（手動測試）
if (require.main === module) {
  require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
  console.log('[手動] 立即執行 LINE UID 同步...');
  runLineUidSync(null)
    .then(r => { console.log('[手動] 結果：', r); process.exit(0); })
    .catch(e => { console.error('[手動] 失敗：', e.message); process.exit(1); });
}

module.exports = { startLineUidScheduledSync };
