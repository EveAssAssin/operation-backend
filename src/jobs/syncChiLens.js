// jobs/syncChiLens.js
// 路奇創意科技（天格／康德）鏡片帳單自動同步
// 每天 02:30（台北）同步「上個月＋這個月」；每月 1～10 日多補「上上個月」（路奇月底後才補退回單）。
// 原本掛在 incrementalSync（02:00）後面，但那支打工程部 API 失敗就整段跳過 → 10 月起一次都沒跑到。
// 結果記在 report_settings key=chi_lens_auto_sync（最近一次各月份結果）。

const cron = require('node-cron');
const supabase = require('../config/supabase');
const { syncChiFinanceLens } = require('../services/chiFinanceLensSync');

function ymOf(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; }
function tpeNow() { return new Date(Date.now() + 8 * 3600e3 + new Date().getTimezoneOffset() * 60e3); }

function periodsToSync(now = tpeNow()) {
  const out = [];
  const back = now.getDate() <= 10 ? 2 : 1;
  for (let k = back; k >= 0; k--) out.push(ymOf(new Date(now.getFullYear(), now.getMonth() - k, 1)));
  return out;
}

let running = false;
async function runChiLensAutoSync(reason = 'cron') {
  if (running) return { skipped: 'running' };
  running = true;
  const log = { at: new Date().toISOString(), reason, months: {} };
  try {
    for (const p of periodsToSync()) {
      try {
        const r = await syncChiFinanceLens(p);
        log.months[p] = r.skipped
          ? { skipped: r.reason }
          : { stores: r.synced_stores, inserted: r.inserted_count, updated: r.updated_count, net: r.total_net,
              unmapped: (r.unmapped_branches || []).length, errors: (r.write_errors || []).length };
      } catch (e) {
        log.months[p] = { error: e.message };
        console.error(`[ChiLensAuto] ${p} 失敗：`, e.message);
      }
    }
    console.log('[ChiLensAuto] 完成', JSON.stringify(log.months));
    await supabase.from('report_settings').upsert(
      { key: 'chi_lens_auto_sync', value: log, updated_by: 'system', updated_at: new Date().toISOString() },
      { onConflict: 'key' });
    return log;
  } finally { running = false; }
}

function startChiLensSyncJob() {
  cron.schedule('30 2 * * *', () => { runChiLensAutoSync('cron').catch((e) => console.error('[ChiLensAuto]', e.message)); },
    { timezone: 'Asia/Taipei' });
  console.log('[ChiLensAuto] 路奇鏡片帳單自動同步已啟動（每天 02:30）');
}

module.exports = { startChiLensSyncJob, runChiLensAutoSync, periodsToSync };
