// jobs/checkNotify.js
// 支票到期通知：每天早上 10:00 推播當日出款清單（v2 schema）
// 依出款人分群推播

const cron = require('node-cron');
const { getTodayDueChecks, getNotifyTargets } = require('../services/checkService');
const { pushToUsers } = require('../services/linePushService');

const fmtAmt = (n) =>
  n != null && n > 0
    ? new Intl.NumberFormat('zh-TW', {
        style: 'currency', currency: 'TWD', maximumFractionDigits: 0,
      }).format(n)
    : '（未填金額）';

/**
 * 組成出款通知訊息
 * 格式：
 *   有 黃信儒 戶名，NT$150,000 要出款（共 3 張）
 *   有 黃志雄 戶名，NT$80,000 要出款（共 2 張）
 *   ⚠ 逾期未消除：有 黃信儒 戶名，NT$50,000 待出款
 *
 * @param {object} todayData - getTodayDueChecks() 回傳值
 */
function buildMessage(todayData) {
  const { date, today_count, overdue_count, summary } = todayData;
  const total = today_count + overdue_count;
  if (total === 0) return null;

  let msg = `🏦 應付票據提醒 ${date}\n`;
  msg += '─'.repeat(26) + '\n';

  // ── 今日到期 ─────────────────────────────────────────
  const todaySummary = summary.filter(s => s.today_count > 0);
  if (todaySummary.length > 0) {
    msg += '\n📋 今日應出款：\n';
    for (const s of todaySummary) {
      msg += `有 ${s.drawer_name} 戶名，${fmtAmt(s.today_amount)} 要出款`;
      if (s.today_count > 1) msg += `（共 ${s.today_count} 張）`;
      msg += '\n';
    }
  }

  // ── 逾期未消除 ───────────────────────────────────────
  const overdueSummary = summary.filter(s => s.overdue_count > 0);
  if (overdueSummary.length > 0) {
    msg += '\n⚠ 逾期尚未出款：\n';
    for (const s of overdueSummary) {
      msg += `有 ${s.drawer_name} 戶名，${fmtAmt(s.overdue_amount)} 待出款`;
      if (s.overdue_count > 1) msg += `（共 ${s.overdue_count} 張）`;
      msg += '\n';
    }
  }

  msg += '\n' + '─'.repeat(26) + '\n';
  msg += '請至系統確認出款並標記完成。';
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

module.exports = { startCheckNotifyJob, sendCheckDueNotification, buildMessage };
