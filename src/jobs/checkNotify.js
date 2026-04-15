// jobs/checkNotify.js
// 支票到期通知：每天早上 10:00 推播當日到期支票清單給指定人員

const cron = require('node-cron');
const { getDueChecks, getNotifyTargets } = require('../services/checkService');
const { pushToUsers } = require('../services/linePushService');

const PAYEE_TYPE_LABEL = {
  vendor:   '廠商',
  landlord: '房東',
  other:    '其他',
};

/**
 * 組成支票到期通知訊息
 */
function buildMessage(checks, date) {
  const fmtAmt = (n) =>
    new Intl.NumberFormat('zh-TW', {
      style: 'currency', currency: 'TWD', maximumFractionDigits: 0,
    }).format(n);

  const totalAmt = checks.reduce((s, c) => s + parseFloat(c.amount), 0);

  let msg = `📋 支票到期提醒 ${date}\n`;
  msg += `共 ${checks.length} 張，合計 ${fmtAmt(totalAmt)}\n`;
  msg += '─'.repeat(22) + '\n';

  checks.forEach((c, i) => {
    const batch = c.check_batches;
    const type  = PAYEE_TYPE_LABEL[batch?.payee_type] || '';
    msg += `${i + 1}. ${batch?.payee_name || '—'}（${type}）\n`;
    msg += `   金額：${fmtAmt(c.amount)}`;
    if (c.check_no) msg += `  票號：${c.check_no}`;
    if (c.bank_name) msg += `  銀行：${c.bank_name}`;
    msg += '\n';
    if (batch?.purpose) msg += `   用途：${batch.purpose}\n`;
  });

  msg += '─'.repeat(22) + '\n';
  msg += '請確認付款並登入系統標記完成。';
  return msg;
}

/**
 * 執行支票到期通知推播
 * 回傳: { date, check_count, notified, skipped }
 */
async function sendCheckDueNotification(dateOverride = null) {
  const today    = dateOverride || new Date().toLocaleDateString('sv-SE');
  const checks   = await getDueChecks(today);
  const targets  = await getNotifyTargets(true);         // 只推啟用中的

  if (checks.length === 0) {
    console.log(`[CheckNotify] ${today} 無到期支票，略過推播`);
    return { date: today, check_count: 0, notified: 0, skipped: true };
  }

  if (targets.length === 0) {
    console.warn('[CheckNotify] 沒有設定通知目標，無法推播');
    return { date: today, check_count: checks.length, notified: 0, skipped: true };
  }

  const message    = buildMessage(checks, today);
  const appNumbers = targets.map(t => t.app_number);

  console.log(`[CheckNotify] ${today} 推播 ${checks.length} 張支票 → ${appNumbers.length} 人`);
  await pushToUsers(appNumbers, message);

  return {
    date:        today,
    check_count: checks.length,
    notified:    appNumbers.length,
    skipped:     false,
  };
}

/**
 * 啟動每日 10:00 排程
 */
function startCheckNotifyJob() {
  cron.schedule('0 10 * * *', async () => {
    console.log('[CheckNotify] 定時通知開始...');
    try {
      const result = await sendCheckDueNotification();
      console.log(`[CheckNotify] 完成：${JSON.stringify(result)}`);
    } catch (err) {
      console.error('[CheckNotify] 推播失敗：', err.message);
    }
  }, { timezone: 'Asia/Taipei' });

  console.log('[CheckNotify] 支票到期通知排程已啟動（每天 10:00）');
}

module.exports = { startCheckNotifyJob, sendCheckDueNotification };
