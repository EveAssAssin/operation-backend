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
  console.log('[liveReportDaily] 已排程：每天 03:30（台北）');
}
module.exports = { run, startLiveReportDaily, isRunning: () => running };
