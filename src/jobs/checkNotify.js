// jobs/checkNotify.js
// 支票到期通知：每天早上 10:00 推播當日出款清單（v2 schema）
// 依出款人分群推播

const cron = require('node-cron');
const { getTodayDueChecks, getNotifyTargets } = require('../services/checkService');
const { pushToUsers } = require('../services/linePushService');

const fmtAmt = (n) =>
  n != null
    ? new Intl.NumberFormat('zh-TW', {
        style: 'currency', currency: 'TWD', maximumFractionDigits: 0,
      }).format(n)
    : '（未填金額）';

/**
 * 組成出款通知訊息
 * @param {object} todayData - getTodayDueChecks() 回傳值
 */
function buildMessage(todayData) {
  const { date, total, grouped } = todayData;

  if (total === 0) return null;

  let msg = `🏦 今日應付票據提醒\n📅 ${date}（共 ${total} 張）\n`;
  msg += '─'.repeat(24) + '\n';

  for (const [drawerName, checks] of Object.entries(grouped)) {
    const subtotal = checks.reduce((s, c) => s + (parseFloat(c.amount) || 0), 0);
    msg += `\n【${drawerName}】`;
    if (subtotal > 0) msg += ` 合計 ${fmtAmt(subtotal)}`;
    msg += '\n';

    checks.forEach((c, i) => {
      const subject = c.batch?.subject?.name || '—';
      const seq     = c.seq_no || '';
      msg += `  ${i + 1}. ${subject}`;
      if (seq) msg += ` 第${seq}張`;
      msg += ` ${fmtAmt(c.amount)}`;
      if (c.check_no) msg += `（票號：${c.check_no}）`;
      msg += ` 到期：${c.due_date}\n`;
    });
  }

  msg += '\n' + '─'.repeat(24) + '\n';
  msg += '請確認已出款並在系統標記完成。';
  return msg;
}

/**
 * 執行推播
 */
async function sendCheckDueNotification() {
  const today    = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' });
  const todayData = await getTodayDueChecks();
  const targets  = (await getNotifyTargets()).filter(t => t.is_active);

  if (todayData.total === 0) {
    console.log(`[CheckNotify] ${today} 無應付票據，略過推播`);
    return { date: today, check_count: 0, notified: 0, skipped: true };
  }

  if (targets.length === 0) {
    console.warn('[CheckNotify] 沒有設定通知目標');
    return { date: today, check_count: todayData.total, notified: 0, skipped: true };
  }

  const message    = buildMessage(todayData);
  const appNumbers = targets.map(t => t.app_number);

  console.log(`[CheckNotify] ${today} 推播 ${todayData.total} 張支票 → ${appNumbers.length} 人`);
  await pushToUsers(appNumbers, message);

  return {
    date:        today,
    check_count: todayData.total,
    notified:    appNumbers.length,
    skipped:     false,
  };
}

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
