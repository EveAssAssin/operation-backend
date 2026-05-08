// jobs/syncAppointedUnits.js
// 排程：每天 04:00 同步特約單位列表（API 23）
//        每 2 小時同步特約單位旗下會員（API 26）
//        補抓特約單位類別（API 25）— 在每日同步單位後執行一次

const cron  = require('node-cron');
const auSvc = require('../services/appointedUnitService');

const UNITS_CRON   = process.env.SYNC_APPOINTED_UNITS_CRON         || '0 4 * * *';
const MEMBERS_CRON = process.env.SYNC_APPOINTED_UNIT_MEMBERS_CRON  || '0 */2 * * *';

function startAppointedUnitJobs() {
  console.log(`[排程] 特約單位同步：${UNITS_CRON}`);
  console.log(`[排程] 特約廠商員工同步：${MEMBERS_CRON}`);

  // 每日同步特約單位列表 + 補類別
  cron.schedule(UNITS_CRON, async () => {
    console.log(`[排程][AU] 同步特約單位開始 ${new Date().toISOString()}`);
    try {
      const r = await auSvc.syncAllUnits();
      console.log(`[排程][AU] 單位同步完成`, r);
      const e = await auSvc.enrichUnitCategories({ limit: 200 });
      console.log(`[排程][AU] 補類別完成`, e);
    } catch (err) {
      console.error(`[排程][AU] 單位同步失敗：`, err.message);
    }
  }, { timezone: 'Asia/Taipei' });

  // 每 2 小時同步廠商員工
  cron.schedule(MEMBERS_CRON, async () => {
    console.log(`[排程][AU] 同步特約廠商員工開始 ${new Date().toISOString()}`);
    try {
      const r = await auSvc.syncAllMembers();
      console.log(`[排程][AU] 員工同步完成`, r);
    } catch (err) {
      console.error(`[排程][AU] 員工同步失敗：`, err.message);
    }
  }, { timezone: 'Asia/Taipei' });
}

if (require.main === module) {
  require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
  (async () => {
    console.log('[手動][AU] 開始同步單位 + 員工 ...');
    try {
      const u = await auSvc.syncAllUnits();
      console.log('單位：', u);
      const e = await auSvc.enrichUnitCategories({ limit: 500 });
      console.log('類別補抓：', e);
      const m = await auSvc.syncAllMembers();
      console.log('員工：', m);
      process.exit(0);
    } catch (err) {
      console.error('失敗：', err);
      process.exit(1);
    }
  })();
}

module.exports = { startAppointedUnitJobs };
