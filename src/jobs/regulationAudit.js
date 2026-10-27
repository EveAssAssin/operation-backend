// jobs/regulationAudit.js — 規範每週巡檢（預設每週一 03:00 台北時間，每次掃最久沒巡檢的 60 份）
//   REGULATION_AUDIT_CRON=off 停用；REGULATION_AUDIT_CRON='0 3 * * 1' 自訂；REGULATION_AUDIT_BATCH=60
const cron = require('node-cron');
const AI   = require('../services/regulationAi');
const svc  = require('../services/regulationService');

function startRegulationAuditJob() {
  const expr = process.env.REGULATION_AUDIT_CRON || '0 3 * * 1';
  if (expr === 'off') { console.log('[RegAudit] 已停用'); return; }
  if (!cron.validate(expr)) { console.warn('[RegAudit] cron 設定錯誤：', expr); return; }
  cron.schedule(expr, async () => {
    if (!AI.enabled()) { console.log('[RegAudit] 沒有 ANTHROPIC_API_KEY，略過'); return; }
    try {
      const r = await AI.runAudit({ notify: svc.notifyAuditSummary });
      console.log('[RegAudit] 完成', r);
    } catch (e) { console.error('[RegAudit] 失敗', e.message); }
  }, { timezone: 'Asia/Taipei' });
  console.log(`[RegAudit] 已排程：${expr}`);
}
module.exports = { startRegulationAuditJob };
