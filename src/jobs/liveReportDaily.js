// jobs/liveReportDaily.js —— 即時月報：每天 03:30（台北）算全部門市「到昨天為止」（services/liveReport.runAll）
const cron = require('node-cron');
let running = false;
async function run(opts) {
  if (running) return { skipped: '上一輪還在跑' };
  running = true;
  try { const r = await require('../services/liveReport').runAll(opts); console.log('[liveReportDaily]', JSON.stringify({ ym: r.ym, day: r.day, stores: r.stores, errors: r.errors.length, cal: r.calibration })); return r; }
  finally { running = false; }
}
function startLiveReportDaily() {
  cron.schedule('30 3 * * *', () => { run().catch((e) => console.error('[liveReportDaily]', e.message)); }, { timezone: 'Asia/Taipei' });
  // 開機 2 分鐘後：昨天的還沒算過（剛上線／03:30 那時剛好在重啟）就補算一次
  setTimeout(async () => {
    try {
      const day = new Date(Date.now() + 8 * 3600e3 - 864e5).toISOString().slice(0, 10);
      const { count } = await require('../config/supabase').from('live_reports').select('store_erpid', { count: 'exact', head: true }).eq('day', day);
      if (!count) await run();
    } catch (e) { console.error('[liveReportDaily@boot]', e.message); }
  }, 120e3).unref();
  console.log('[liveReportDaily] 已排程：每天 03:30（台北）');
}
module.exports = { run, startLiveReportDaily, isRunning: () => running };
