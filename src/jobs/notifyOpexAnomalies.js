// jobs/notifyOpexAnomalies.js
// 營運費用異常每日推播：每天早上 09:00 掃當月異常，有異常就推 LINE

const cron     = require('node-cron');
const supabase = require('../config/supabase');
const svc      = require('../services/opexAnomalyService');
const { pushToUsers } = require('../services/linePushService');

const fmtAmt = (n) =>
  n != null && Number(n) !== 0
    ? new Intl.NumberFormat('zh-TW', { style: 'currency', currency: 'TWD', maximumFractionDigits: 0 }).format(Number(n))
    : '—';

/** 取訂閱者 app_number 清單（重用基本資料的訂閱名單） */
async function getSubscriberAppNumbers() {
  const { data, error } = await supabase
    .from('basic_data_notify_subscribers')
    .select('app_number, enabled')
    .eq('enabled', true);
  if (error) throw error;
  return (data || []).map(s => s.app_number).filter(Boolean);
}

function buildMessage(month, anomalies) {
  const severe = anomalies.filter(a => a.severity === 'severe');
  const warn   = anomalies.filter(a => a.severity === 'warn');

  const lines = [];
  lines.push(`⚠ 營運費用異常提醒（${month}）`);
  lines.push('──────────────────');
  if (severe.length > 0) {
    lines.push(`🔴 嚴重異常 ${severe.length} 筆（>+50%）`);
    for (const a of severe.slice(0, 8)) {
      lines.push(
        `• ${a.category_icon}${a.category_name}｜${a.store_name}` +
        ` ${fmtAmt(a.current)}（近${a.history_months}月均 ${fmtAmt(a.avg)}，+${Math.round(a.diff_ratio * 100)}%）`
      );
    }
    if (severe.length > 8) lines.push(`  ...還有 ${severe.length - 8} 筆`);
    lines.push('');
  }
  if (warn.length > 0) {
    lines.push(`🟡 提醒 ${warn.length} 筆（>+20%）`);
    for (const a of warn.slice(0, 8)) {
      lines.push(
        `• ${a.category_icon}${a.category_name}｜${a.store_name}` +
        ` ${fmtAmt(a.current)}（均 ${fmtAmt(a.avg)}，+${Math.round(a.diff_ratio * 100)}%）`
      );
    }
    if (warn.length > 8) lines.push(`  ...還有 ${warn.length - 8} 筆`);
  }
  lines.push('──────────────────');
  lines.push('請至「帳單管理 → 營運費用」查看詳情');
  return lines.join('\n');
}

async function runAnomalyCheck({ silent = false } = {}) {
  const now = new Date();
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

  const result = await svc.detectAnomalies(month);
  const { anomalies } = result;

  console.log(`[OpexAnomaly] ${month} 掃描：${anomalies.length} 筆異常`);

  if (anomalies.length === 0) return { pushed: false, reason: 'no_anomalies', month, anomalies: [] };

  const targets = await getSubscriberAppNumbers();
  if (targets.length === 0) return { pushed: false, reason: 'no_subscribers', month, anomalies };

  if (silent) return { pushed: false, reason: 'silent_mode', month, anomalies, would_push_to: targets };

  const message = buildMessage(month, anomalies);
  const resp = await pushToUsers(targets, message);
  return { pushed: true, month, targets: targets.length, anomaly_count: anomalies.length, line_response: resp };
}

function start() {
  // 每天 09:00（Asia/Taipei）
  cron.schedule('0 9 * * *', async () => {
    try {
      const r = await runAnomalyCheck();
      console.log('[OpexAnomaly] 每日推播結果:', r.pushed ? `已推 ${r.anomaly_count} 筆給 ${r.targets} 人` : `跳過 (${r.reason})`);
    } catch (e) {
      console.error('[OpexAnomaly] 每日推播失敗:', e.message);
    }
  }, { timezone: 'Asia/Taipei' });
  console.log('✓ 營運費用異常每日推播 (09:00 Asia/Taipei) 已啟動');
}

module.exports = { start, runAnomalyCheck, buildMessage };
