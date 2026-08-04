// jobs/notifyRecruitmentFollowUps.js
// 履歷追蹤提醒：每天 09:00 掃 follow_up_date <= today+3、還沒推過的投遞者
// 推播對象：basic_data_notify_subscribers 且 events 有 'recruitment_follow_up' 的訂閱者（人事專屬）
// 只推一次：推完把 follow_up_notified_at 設為 now()，之後不再推
//           若使用者改 follow_up_date，backend PUT 會清空 notified_at，下次排程再推

const cron     = require('node-cron');
const supabase = require('../config/supabase');
const { pushToUsers } = require('../services/linePushService');

function todayTaipei() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' });
}
function fmtDate(d) {
  if (!d) return '—';
  const dt = new Date(d);
  return dt.toLocaleDateString('zh-TW', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: 'Asia/Taipei' });
}

/** 取「有訂閱 recruitment_follow_up 事件」的訂閱者 app_number */
async function getSubscriberAppNumbers() {
  const { data, error } = await supabase
    .from('basic_data_notify_subscribers')
    .select('app_number, enabled, events')
    .eq('enabled', true);
  if (error) throw error;
  return (data || [])
    .filter(s => Array.isArray(s.events) && s.events.includes('recruitment_follow_up'))
    .map(s => s.app_number)
    .filter(Boolean);
}

/** 撈出應該推播的投遞者 + 面試：follow_up_date <= today+3、還沒推、非婉拒 */
async function findPendingFollowUps() {
  const today = todayTaipei();
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() + 3);
  const cutoffStr = cutoff.toISOString().slice(0, 10);

  // 1) 履歷
  const { data: applicants, error: e1 } = await supabase
    .from('recruitment_applicants')
    .select('id, name, phone, platform, target_store_name, target_store_note, status, follow_up_date, follow_up_notes, candidate_status')
    .not('follow_up_date', 'is', null)
    .lte('follow_up_date', cutoffStr)
    .is('follow_up_notified_at', null)
    .not('status', 'in', '("rejected","rejected_again")')
    .order('follow_up_date', { ascending: true });
  if (e1) throw e1;

  // 2) 面試（join applicant 拿姓名等）
  const { data: interviews, error: e2 } = await supabase
    .from('recruitment_interviews')
    .select(`
      id, follow_up_date, follow_up_notes, candidate_status,
      applicant:recruitment_applicants(id, name, phone, platform, target_store_name, target_store_note, status)
    `)
    .not('follow_up_date', 'is', null)
    .lte('follow_up_date', cutoffStr)
    .is('follow_up_notified_at', null)
    .order('follow_up_date', { ascending: true });
  if (e2) throw e2;

  // 合併並附 source 標記
  const merged = [];
  for (const a of (applicants || [])) {
    merged.push({ source: 'applicant', ...a });
  }
  for (const iv of (interviews || [])) {
    const ap = iv.applicant || {};
    if (ap.status === 'rejected' || ap.status === 'rejected_again') continue;
    merged.push({
      source:             'interview',
      id:                 iv.id,
      applicant_id:       ap.id || null,
      name:               ap.name || '—',
      phone:              ap.phone || null,
      platform:           ap.platform || null,
      target_store_name:  ap.target_store_name || null,
      target_store_note:  ap.target_store_note || null,
      status:             ap.status || null,
      follow_up_date:     iv.follow_up_date,
      follow_up_notes:    iv.follow_up_notes,
      candidate_status:   iv.candidate_status,
    });
  }
  merged.sort((a, b) => (a.follow_up_date || '').localeCompare(b.follow_up_date || ''));

  const overdue  = [];
  const todayArr = [];
  const upcoming = [];
  for (const item of merged) {
    if (item.follow_up_date < today)        overdue.push(item);
    else if (item.follow_up_date === today) todayArr.push(item);
    else                                     upcoming.push(item);
  }
  return { overdue, today_list: todayArr, upcoming };
}

/** 組推播訊息 */
function buildMessage({ overdue, today_list, upcoming }) {
  const total = overdue.length + today_list.length + upcoming.length;
  const lines = [];
  lines.push(`⏰ 履歷追蹤提醒（${todayTaipei()}）`);
  lines.push('──────────────────');
  lines.push(`待追蹤 ${total} 位求職者`);
  lines.push('');

  const renderItem = (a) => {
    const platform = a.platform ? `[${a.platform}] ` : '';
    const store    = a.target_store_name || '—';
    const note     = a.target_store_note ? `／${a.target_store_note}` : '';
    const cstat    = a.candidate_status ? `（${a.candidate_status}）` : '';
    const src      = a.source === 'interview' ? '🗣' : '📄';
    let line = `${src} ${fmtDate(a.follow_up_date)} ${platform}${a.name}${cstat}\n  ${store}${note}`;
    if (a.follow_up_notes) line += `\n  📝 ${a.follow_up_notes}`;
    return line;
  };

  if (overdue.length > 0) {
    lines.push(`🔴 逾期 ${overdue.length} 位（立即追蹤）`);
    for (const a of overdue.slice(0, 10)) lines.push(renderItem(a));
    if (overdue.length > 10) lines.push(`  ...還有 ${overdue.length - 10} 位`);
    lines.push('');
  }
  if (today_list.length > 0) {
    lines.push(`🟠 今天需追蹤 ${today_list.length} 位`);
    for (const a of today_list.slice(0, 10)) lines.push(renderItem(a));
    if (today_list.length > 10) lines.push(`  ...還有 ${today_list.length - 10} 位`);
    lines.push('');
  }
  if (upcoming.length > 0) {
    lines.push(`🟡 未來 3 天 ${upcoming.length} 位`);
    for (const a of upcoming.slice(0, 10)) lines.push(renderItem(a));
    if (upcoming.length > 10) lines.push(`  ...還有 ${upcoming.length - 10} 位`);
    lines.push('');
  }

  lines.push('請至「人力招募 → 履歷紀錄」處理');
  return lines.join('\n');
}

/** 執行檢查 + 推播 + 標記已推 */
async function runFollowUpNotify() {
  const groups = await findPendingFollowUps();
  const total = groups.overdue.length + groups.today_list.length + groups.upcoming.length;
  if (total === 0) {
    console.log('[FollowUp] 無待追蹤，略過');
    return { total: 0, pushed: 0, marked: 0 };
  }

  const subscribers = await getSubscriberAppNumbers();
  if (subscribers.length === 0) {
    console.log('[FollowUp] 有 ' + total + ' 位待追蹤但無訂閱者');
    return { total, pushed: 0, marked: 0, no_subscribers: true };
  }

  const message = buildMessage(groups);
  const results = await pushToUsers(subscribers, message);
  const pushed = (results || []).filter(r => r.ok).length;

  // 標記已推（避免重複）— 履歷 + 面試 分表更新
  const allItems = [...groups.overdue, ...groups.today_list, ...groups.upcoming];
  const applicantIds = allItems.filter(x => x.source === 'applicant').map(x => x.id);
  const interviewIds = allItems.filter(x => x.source === 'interview').map(x => x.id);
  const nowIso = new Date().toISOString();

  if (applicantIds.length > 0) {
    const { error: e1 } = await supabase
      .from('recruitment_applicants')
      .update({ follow_up_notified_at: nowIso })
      .in('id', applicantIds);
    if (e1) console.error('[FollowUp] 標記 applicants 失敗：', e1.message);
  }
  if (interviewIds.length > 0) {
    const { error: e2 } = await supabase
      .from('recruitment_interviews')
      .update({ follow_up_notified_at: nowIso })
      .in('id', interviewIds);
    if (e2) console.error('[FollowUp] 標記 interviews 失敗：', e2.message);
  }

  console.log(`[FollowUp] 推播完成：${total} 位（履歷 ${applicantIds.length}、面試 ${interviewIds.length}）、訂閱 ${subscribers.length} 人、成功 ${pushed} 位`);
  return { total, pushed, marked_applicants: applicantIds.length, marked_interviews: interviewIds.length };
}

/** 啟動排程：每天 09:00 Asia/Taipei */
function startFollowUpNotifyJob() {
  cron.schedule('0 9 * * *', async () => {
    console.log('[FollowUp] 定時檢查追蹤名單...');
    try {
      const result = await runFollowUpNotify();
      console.log('[FollowUp] 完成：', JSON.stringify(result));
    } catch (err) {
      console.error('[FollowUp] 失敗：', err.message);
    }
  }, { timezone: 'Asia/Taipei' });
  console.log('[FollowUp] 履歷追蹤推播排程已啟動（每天 09:00）');
}

module.exports = {
  startFollowUpNotifyJob,
  runFollowUpNotify,
  findPendingFollowUps,
  buildMessage,
};
