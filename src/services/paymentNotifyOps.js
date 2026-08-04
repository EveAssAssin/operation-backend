// services/paymentNotifyOps.js
//
// 外部請款事件進來時（source_system=market / chi_lens），
// 推播 LINE 給營運部主管 + 會計（讓他們立刻知道要審核）。
//
// 由 marketPaymentIngest 與 chiFinanceLensIngest 共用。
//
// - 推播對象：system_users 中 role IN ('operation_lead','operation_accounting') 且 is_active
// - 訊息含：來源、廠商/工務師、金額、單號、修繕單/月份、快速點入連結
// - Fire-and-forget：失敗只 log 不擋主流程

const supabase = require('../config/supabase');
const linePush = require('./linePushService');

const TARGET_ROLES = ['operation_lead', 'operation_accounting'];

// 前端 base URL（可用 env 覆蓋；預設 onrender 正式）
const FRONTEND_BASE = (process.env.OPERATION_FRONTEND_URL || 'https://operation-frontend.onrender.com')
  .replace(/\/+$/, '');

// 查目標 app_number 清單
async function getTargetAppNumbers() {
  const { data, error } = await supabase
    .from('system_users')
    .select('member_id, role, is_active')
    .in('role', TARGET_ROLES)
    .eq('is_active', true);
  if (error) {
    console.error('[paymentNotifyOps] 查詢目標人員失敗：', error.message);
    return [];
  }
  return (data || []).map(u => u.member_id).filter(Boolean);
}

// 構建深連結；market 用 market_pr_id、chi_lens 用 chi_lens_pr_id
function buildDeepLink({ source_system, external_id }) {
  if (!external_id) return `${FRONTEND_BASE}/billing-v2`;
  if (source_system === 'market')   return `${FRONTEND_BASE}/billing-v2?market_pr_id=${encodeURIComponent(external_id)}`;
  if (source_system === 'chi_lens') return `${FRONTEND_BASE}/billing-v2?chi_lens_pr_id=${encodeURIComponent(external_id)}`;
  return `${FRONTEND_BASE}/billing-v2`;
}

/**
 * @param {object} args
 * @param {'market'|'chi_lens'} args.source_system
 * @param {string} args.external_id       market_payment_request_id 或 chi_lens 的 request id
 * @param {string} args.request_no        vendor_payment_requests.request_no
 * @param {string} args.title             請款標題（或姓名/廠商）
 * @param {string} args.subject_label     顯示的類型標籤（例：外部工務師 / 路奇天格）
 * @param {string} args.subject_name      工務師姓名 或 廠商名
 * @param {number} args.total_amount
 * @param {number} [args.item_count]      修繕單/明細數量
 * @param {string} [args.period]          帳單月份
 */
async function notifyOpsNewRequest(args) {
  try {
    const targets = await getTargetAppNumbers();
    if (!targets.length) {
      console.log('[paymentNotifyOps] 沒有可通知的營運主管/會計，跳過');
      return { sent: 0 };
    }
    const link = buildDeepLink({
      source_system: args.source_system,
      external_id:   args.external_id,
    });
    const lines = [
      '📥 新請款待審核',
      `來源：${args.subject_label || args.source_system}`,
      `對象：${args.subject_name || '—'}`,
      `金額：NT$${Number(args.total_amount || 0).toLocaleString()}`,
      args.item_count ? `明細：${args.item_count} 筆` : null,
      args.period ? `月份：${args.period}` : null,
      `單號：${args.request_no || '—'}`,
      '',
      `🔗 點此開啟：${link}`,
    ].filter(Boolean);
    const msg = lines.join('\n');

    const r = await linePush.pushToUsers(targets, msg);
    console.log(`[paymentNotifyOps] 已推播 ${args.source_system} 新請款給 ${targets.length} 位營運人員`);
    return { sent: targets.length, result: r };
  } catch (e) {
    console.error('[paymentNotifyOps] 推播失敗：', e.message);
    return { sent: 0, error: e.message };
  }
}

module.exports = { notifyOpsNewRequest, buildDeepLink };
