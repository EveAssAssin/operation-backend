// jobs/vendorPayoutNotify.js —— 廠商出款提醒（2026-10-20）
// 每天 10:00（跟支票一樣）推播給「支票通知對象」：今天要出的廠商款＋之前排了還沒出的。
const cron = require('node-cron');
const payout = require('../services/vendorPayoutService');
const { getNotifyTargets } = require('../services/checkService');
const { pushToUsers } = require('../services/linePushService');

const fmt = (n) => 'NT$' + Math.round(n || 0).toLocaleString('en-US');

function buildMessage(d) {
  if (!d.total) return null;
  let msg = `💸 廠商出款提醒 ${d.date}\n` + '─'.repeat(26) + '\n';
  for (const g of d.groups) {
    msg += `\n🏦 ${g.bank_label}：${fmt(g.amount)}（${g.count} 筆）`;
    if (g.overdue) msg += `，其中 ${g.overdue} 筆是之前排的還沒出`;
    if (g.missing_payee) msg += `\n   ⚠ ${g.missing_payee} 筆廠商收款帳號缺／有誤，匯出檔不會放`;
    msg += '\n';
  }
  msg += '\n' + '─'.repeat(26) + '\n請到營運部系統「帳單管理 → 💸 今日出款」匯出元大檔，銀行付完按「已出款」。';
  return msg;
}

async function sendVendorPayoutNotification({ force = false } = {}) {
  const d = await payout.day(payout.twToday());
  if (!d.total) return { date: d.date, count: 0, notified: 0, skipped: true };
  const targets = (await getNotifyTargets()).filter(t => t.is_active);
  if (!targets.length) return { date: d.date, count: d.total, notified: 0, skipped: true, reason: '沒有通知對象（支票通知對象）' };
  await pushToUsers(targets.map(t => t.app_number), buildMessage(d));
  return { date: d.date, count: d.total, amount: d.amount, notified: targets.length, skipped: false, force };
}

function startVendorPayoutNotifyJob() {
  cron.schedule('0 10 * * *', async () => {
    try { console.log('[VendorPayoutNotify]', JSON.stringify(await sendVendorPayoutNotification())); }
    catch (e) { console.error('[VendorPayoutNotify] 推播失敗：', e.message); }
  }, { timezone: 'Asia/Taipei' });
  console.log('[VendorPayoutNotify] 廠商出款提醒排程已啟動（每天 10:00）');
}

module.exports = { startVendorPayoutNotifyJob, sendVendorPayoutNotification, buildMessage };
