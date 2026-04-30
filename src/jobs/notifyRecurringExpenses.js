// jobs/notifyRecurringExpenses.js
// 常態費用每日推播：每天早上 9:00 通知當天到期且未付的費用
// 推播對象：全體營運部 staff（system_users.role IN operation_staff/operation_lead）

const cron     = require('node-cron');
const supabase = require('../config/supabase');
const svc      = require('../services/recurringExpenseService');
const { pushToUsers } = require('../services/linePushService');

const fmtAmt = (n) =>
  n != null && Number(n) > 0
    ? new Intl.NumberFormat('zh-TW', {
        style: 'currency', currency: 'TWD', maximumFractionDigits: 0,
      }).format(Number(n))
    : '（未填金額）';

/**
 * 取得所有應該收到推播的營運部 staff app_number
 * 規則：system_users 中 role IN ('operation_staff','operation_lead') 且 is_active = true
 */
async function getOperationStaffAppNumbers() {
  const { data, error } = await supabase
    .from('system_users')
    .select('member_id, name, role, is_active')
    .in('role', ['operation_staff', 'operation_lead'])
    .eq('is_active', true);
  if (error) throw error;
  return (data || [])
    .map(u => u.member_id)
    .filter(Boolean);
}

/**
 * 組推播訊息
 * 範例：
 *   📋 今日應付常態費用 2026-04-30
 *   ──────────────────────────
 *   • 房租（台北門市）NT$30,000
 *   • 水電（高雄門市）NT$5,500
 *   ──────────────────────────
 *   合計 NT$35,500（共 2 筆）
 *   請至系統確認支付並標記完成。
 */
function buildMessage(date, payments) {
  if (!payments.length) return null;

  const total = payments.reduce((s, p) => s + Number(p.amount || 0), 0);
  let msg = `📋 今日應付常態費用 ${date}\n`;
  msg += '─'.repeat(26) + '\n';

  for (const p of payments) {
    const name = p.recurring_expenses?.name || '（未知項目）';
    msg += `• ${name}（${p.bill_target_name}）${fmtAmt(p.amount)}\n`;
  }

  msg += '─'.repeat(26) + '\n';
  msg += `合計 ${fmtAmt(total)}（共 ${payments.length} 筆）\n`;
  msg += '請至系統確認支付並標記完成。';
  return msg;
}

/**
 * 執行推播（也供手動觸發測試用）
 */
async function sendDailyNotification() {
  // 1. 確保本月所有 expense 都有 payment row
  const ensureResult = await svc.ensureCurrentMonthPayments();
  console.log('[RecurringExpense] ensureCurrentMonthPayments：', ensureResult);

  // 2. 取今日到期且未付清單
  const { date, payments } = await svc.getTodayDuePayments();

  if (payments.length === 0) {
    console.log(`[RecurringExpense] ${date} 無到期常態費用，略過推播`);
    return { date, count: 0, notified: 0, skipped: true };
  }

  // 3. 取營運部 staff
  const appNumbers = await getOperationStaffAppNumbers();
  if (appNumbers.length === 0) {
    console.warn('[RecurringExpense] 找不到任何營運部 staff，略過推播');
    return { date, count: payments.length, notified: 0, skipped: true };
  }

  // 4. 推播
  const message = buildMessage(date, payments);
  console.log(`[RecurringExpense] ${date} 推播 ${payments.length} 筆 → ${appNumbers.length} 人`);
  await pushToUsers(appNumbers, message);

  // 5. 紀錄已通知
  await svc.markNotified(payments.map(p => p.id));

  return {
    date,
    count:    payments.length,
    notified: appNumbers.length,
    skipped:  false,
  };
}

/**
 * 啟動排程：每天早上 9:00（Asia/Taipei）
 */
function startRecurringExpenseNotifyJob() {
  cron.schedule('0 9 * * *', async () => {
    console.log('[RecurringExpense] 定時推播開始...');
    try {
      const result = await sendDailyNotification();
      console.log('[RecurringExpense] 完成：', JSON.stringify(result));
    } catch (err) {
      console.error('[RecurringExpense] 推播失敗：', err.message);
    }
  }, { timezone: 'Asia/Taipei' });

  console.log('[RecurringExpense] 常態費用每日推播排程已啟動（每天 09:00）');
}

module.exports = {
  startRecurringExpenseNotifyJob,
  sendDailyNotification,
  buildMessage,
};
