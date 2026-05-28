// services/scheduledNotifyService.js
// 「排程推播」模組業務邏輯
//   - CRUD
//   - 訊息變數展開：{date} {time} {weekday} {year} {month} {day} {ym} {days_left}
//   - 計算下次執行時間（Asia/Taipei）
//   - 收件人解析：個別 app_number + 角色群
//   - 立即執行

const supabase = require('../config/supabase');
const { pushToUsers } = require('./linePushService');

// ── 時區工具（Asia/Taipei） ──────────────────────────────────
const TZ = 'Asia/Taipei';

function nowInTaipei() {
  // 回傳「以 Taipei 為基準的當前時間」的 Date 物件（仍為 UTC，但數值代表 Taipei 牆上時間）
  return new Date(new Date().toLocaleString('en-US', { timeZone: TZ }));
}

/**
 * 將「Taipei 牆上時間」(year, month, day, hh, mm) 轉成 UTC 的 Date 物件
 * Taipei = UTC+8（無夏令時間）
 */
function taipeiToUtc(y, m, d, hh = 0, mm = 0) {
  return new Date(Date.UTC(y, m - 1, d, hh - 8, mm, 0));
}

// 把 Date 物件用 Asia/Taipei 格式化成 { y, m, d, hh, mm, weekday(1-7) }
function partsInTaipei(date) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    weekday: 'short',
  });
  const parts = fmt.formatToParts(date).reduce((o, p) => (o[p.type] = p.value, o), {});
  const weekdayMap = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
  return {
    y:  Number(parts.year),
    m:  Number(parts.month),
    d:  Number(parts.day),
    hh: Number(parts.hour),
    mm: Number(parts.minute),
    weekday: weekdayMap[parts.weekday] || 1,
  };
}

function daysInMonth(y, m) {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

// ── 變數展開 ────────────────────────────────────────────────
function renderMessage(template) {
  if (!template) return '';
  const p = partsInTaipei(new Date());
  const weekdayCh = ['', '週一','週二','週三','週四','週五','週六','週日'];
  const totalDays = daysInMonth(p.y, p.m);
  const daysLeft  = totalDays - p.d;
  const vars = {
    date:        `${p.y}-${String(p.m).padStart(2,'0')}-${String(p.d).padStart(2,'0')}`,
    time:        `${String(p.hh).padStart(2,'0')}:${String(p.mm).padStart(2,'0')}`,
    weekday:     weekdayCh[p.weekday],
    year:        String(p.y),
    month:       String(p.m),
    day:         String(p.d),
    ym:          `${p.y}-${String(p.m).padStart(2,'0')}`,
    days_left:   String(daysLeft),
  };
  return String(template).replace(/\{(\w+)\}/g, (m, k) => Object.prototype.hasOwnProperty.call(vars, k) ? vars[k] : m);
}

// ── 計算下次執行時間 ────────────────────────────────────────
/**
 * @param {string} type   once / daily / weekly / monthly
 * @param {object} cfg
 * @param {Date}   fromDate  起算點（不含），預設 = 現在
 * @returns {Date|null}      下次執行時間（UTC Date 物件），找不到回 null
 */
function computeNextRunAt(type, cfg, fromDate = new Date()) {
  cfg = cfg || {};
  const p = partsInTaipei(fromDate);

  if (type === 'once') {
    if (!cfg.datetime) return null;
    const d = new Date(cfg.datetime);
    if (isNaN(d)) return null;
    return d > fromDate ? d : null;       // 過去的不再排
  }

  if (type === 'daily') {
    const [hh, mm] = parseHHMM(cfg.time);
    if (hh == null) return null;
    // 今天 hh:mm 還沒到 → 今天；否則 → 明天
    const todayTarget = taipeiToUtc(p.y, p.m, p.d, hh, mm);
    if (todayTarget > fromDate) return todayTarget;
    // 加一天（在 Taipei 牆上）
    const tomorrow = addDaysInTaipei(p.y, p.m, p.d, 1);
    return taipeiToUtc(tomorrow.y, tomorrow.m, tomorrow.d, hh, mm);
  }

  if (type === 'weekly') {
    const [hh, mm] = parseHHMM(cfg.time);
    if (hh == null) return null;
    const days = (cfg.days_of_week || []).map(Number).filter(d => d >= 1 && d <= 7);
    if (days.length === 0) return null;
    // 從今天起算 0~7 天，找第一個符合 weekday 且時間還沒到的
    for (let i = 0; i <= 7; i++) {
      const t = addDaysInTaipei(p.y, p.m, p.d, i);
      if (days.includes(t.weekday)) {
        const target = taipeiToUtc(t.y, t.m, t.d, hh, mm);
        if (target > fromDate) return target;
      }
    }
    return null;
  }

  if (type === 'monthly') {
    const [hh, mm] = parseHHMM(cfg.time);
    if (hh == null) return null;
    const dom      = Number(cfg.day_of_month);
    const fallback = cfg.fallback || 'prev';  // prev / skip / next
    if (!dom || dom < 1 || dom > 31) return null;

    // 本月、下月、再下月 各嘗試一次
    for (let offset = 0; offset < 3; offset++) {
      const y = p.y + Math.floor((p.m - 1 + offset) / 12);
      const m = ((p.m - 1 + offset) % 12) + 1;
      const total = daysInMonth(y, m);
      let actualDay;
      if (dom <= total) {
        actualDay = dom;
      } else if (fallback === 'prev') {
        actualDay = total;
      } else if (fallback === 'next') {
        // 推到下個月 1 號（在下一輪會處理到）
        continue;
      } else {
        // skip
        continue;
      }
      const target = taipeiToUtc(y, m, actualDay, hh, mm);
      if (target > fromDate) return target;
    }
    return null;
  }

  return null;
}

function parseHHMM(s) {
  if (!s || typeof s !== 'string') return [null, null];
  const mm = s.match(/^(\d{1,2}):(\d{2})$/);
  if (!mm) return [null, null];
  const hh = Number(mm[1]), mn = Number(mm[2]);
  if (hh < 0 || hh > 23 || mn < 0 || mn > 59) return [null, null];
  return [hh, mn];
}

function addDaysInTaipei(y, m, d, days) {
  // 用 UTC 加減，最後轉回 Taipei 牆上的 parts
  const base = Date.UTC(y, m - 1, d);
  const next = new Date(base + days * 86400 * 1000);
  return partsInTaipei(next);
}

// ── 收件人解析 ──────────────────────────────────────────────
async function resolveRecipients({ recipient_app_numbers = [], recipient_roles = [] } = {}) {
  const set = new Set();

  // 1) 個人
  for (const a of recipient_app_numbers || []) {
    if (a) set.add(String(a));
  }

  // 2) 角色群 → 從 system_users 撈出
  const roles = (recipient_roles || []).filter(Boolean);
  if (roles.length > 0) {
    const { data, error } = await supabase
      .from('system_users')
      .select('member_id, role, is_active')
      .in('role', roles)
      .eq('is_active', true);
    if (error) throw new Error(error.message);
    for (const u of data || []) {
      if (u.member_id) set.add(String(u.member_id));
    }
  }

  return Array.from(set);
}

// ════════════════════════════════════════════════════════════
//                         CRUD
// ════════════════════════════════════════════════════════════

async function list() {
  const { data, error } = await supabase
    .from('scheduled_notifications')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) throw new Error(error.message);
  return data || [];
}

async function get(id) {
  const { data, error } = await supabase
    .from('scheduled_notifications').select('*').eq('id', id).maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

async function create(payload, actor) {
  validatePayload(payload);
  const nextRun = computeNextRunAt(payload.schedule_type, payload.schedule_config || {});
  const { data, error } = await supabase.from('scheduled_notifications').insert([{
    title:                  payload.title,
    message:                payload.message,
    schedule_type:          payload.schedule_type,
    schedule_config:        payload.schedule_config || {},
    recipient_app_numbers:  payload.recipient_app_numbers || [],
    recipient_roles:        payload.recipient_roles || [],
    enabled:                payload.enabled !== false,
    next_run_at:            nextRun,
    created_by_app_number:  actor?.app_number || null,
    created_by_name:        actor?.name || null,
  }]).select().single();
  if (error) throw new Error(error.message);
  return data;
}

async function update(id, patch, actor) {
  const before = await get(id);
  if (!before) throw new Error('找不到排程');

  const merged = {
    title:          patch.title          ?? before.title,
    message:        patch.message        ?? before.message,
    schedule_type:  patch.schedule_type  ?? before.schedule_type,
    schedule_config: patch.schedule_config ?? before.schedule_config,
    recipient_app_numbers: patch.recipient_app_numbers ?? before.recipient_app_numbers,
    recipient_roles:       patch.recipient_roles       ?? before.recipient_roles,
    enabled:        patch.enabled  ?? before.enabled,
  };
  validatePayload(merged);

  const nextRun = computeNextRunAt(merged.schedule_type, merged.schedule_config || {});
  const updateData = {
    ...merged,
    next_run_at: merged.enabled ? nextRun : null,
    // once 型重新啟用時要把 completed 清掉
    completed:   (merged.schedule_type === 'once' && before.completed && patch.enabled) ? false : before.completed,
  };

  const { data, error } = await supabase.from('scheduled_notifications')
    .update(updateData).eq('id', id).select().single();
  if (error) throw new Error(error.message);
  return data;
}

async function remove(id) {
  const { error } = await supabase.from('scheduled_notifications').delete().eq('id', id);
  if (error) throw new Error(error.message);
  return { id };
}

function validatePayload(p) {
  if (!p.title)   throw new Error('title 必填');
  if (!p.message) throw new Error('message 必填');
  if (!['once','daily','weekly','monthly'].includes(p.schedule_type)) {
    throw new Error('schedule_type 必須是 once / daily / weekly / monthly');
  }
  const hasIndividual = (p.recipient_app_numbers || []).length > 0;
  const hasRole       = (p.recipient_roles || []).length > 0;
  if (!hasIndividual && !hasRole) {
    throw new Error('至少要指定一個收件人（個人或角色群）');
  }
}

// ════════════════════════════════════════════════════════════
//                       執行 / 立即測試
// ════════════════════════════════════════════════════════════

/**
 * 執行一筆排程：渲染訊息 → 解析收件人 → 推播 → 寫 log → 更新 next_run_at
 * @param {object} notif    scheduled_notifications row
 * @param {boolean} isManual 是否手動觸發（影響 log + 不會更新 next_run_at）
 */
async function executeNotification(notif, { isManual = false } = {}) {
  const rendered = renderMessage(notif.message);
  let recipients = [];
  let status = 'success';
  let errorMsg = null;

  try {
    recipients = await resolveRecipients({
      recipient_app_numbers: notif.recipient_app_numbers,
      recipient_roles:       notif.recipient_roles,
    });
    if (recipients.length === 0) {
      status = 'failed';
      errorMsg = '無有效收件人';
    } else {
      await pushToUsers(recipients, rendered);
    }
  } catch (e) {
    status = 'failed';
    errorMsg = e.message || String(e);
  }

  // 寫 log
  await supabase.from('scheduled_notification_logs').insert([{
    notification_id:  notif.id,
    title:            notif.title,
    message_rendered: rendered,
    recipient_count:  recipients.length,
    recipient_sample: recipients.slice(0, 10),
    status,
    error:            errorMsg,
    is_manual:        isManual,
  }]);

  // 自動觸發 → 更新 last_run + next_run
  if (!isManual) {
    const updates = {
      last_run_at:              new Date().toISOString(),
      last_run_status:          status,
      last_run_error:           errorMsg,
      last_run_recipient_count: recipients.length,
    };
    if (notif.schedule_type === 'once') {
      updates.completed   = true;
      updates.next_run_at = null;
    } else {
      const nextRun = computeNextRunAt(notif.schedule_type, notif.schedule_config || {}, new Date());
      updates.next_run_at = nextRun;
    }
    await supabase.from('scheduled_notifications').update(updates).eq('id', notif.id);
  }

  return { status, recipient_count: recipients.length, error: errorMsg, rendered };
}

async function executeNow(id) {
  const notif = await get(id);
  if (!notif) throw new Error('找不到排程');
  return executeNotification(notif, { isManual: true });
}

// ════════════════════════════════════════════════════════════
//                       到期掃描
// ════════════════════════════════════════════════════════════

async function findDue() {
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from('scheduled_notifications')
    .select('*')
    .eq('enabled', true)
    .eq('completed', false)
    .not('next_run_at', 'is', null)
    .lte('next_run_at', now)
    .order('next_run_at', { ascending: true })
    .limit(50);
  if (error) throw new Error(error.message);
  return data || [];
}

/** dispatcher 每分鐘呼叫一次 */
async function runDueNotifications() {
  const due = await findDue();
  if (due.length === 0) return { count: 0 };
  console.log(`[ScheduledNotify] 找到 ${due.length} 筆到期排程`);
  for (const n of due) {
    try {
      await executeNotification(n, { isManual: false });
    } catch (e) {
      console.error(`[ScheduledNotify] 執行 ${n.id} 失敗:`, e.message);
    }
  }
  return { count: due.length };
}

// ════════════════════════════════════════════════════════════
//                         歷史紀錄
// ════════════════════════════════════════════════════════════

async function listLogs({ notification_id, limit = 100 } = {}) {
  let q = supabase.from('scheduled_notification_logs')
    .select('*')
    .order('triggered_at', { ascending: false })
    .limit(Math.min(500, Number(limit) || 100));
  if (notification_id) q = q.eq('notification_id', notification_id);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return data || [];
}

// ════════════════════════════════════════════════════════════
//                  輔助：列出可選的角色 / 人員
// ════════════════════════════════════════════════════════════

const ROLE_OPTIONS = [
  { value: 'operation_staff', label: '營運部部員' },
  { value: 'operation_lead',  label: '營運部主管' },
  { value: 'dept_head',       label: '部門主管'   },
  { value: 'super_admin',     label: '超級管理員' },
];

async function listSystemUsers() {
  const { data, error } = await supabase
    .from('system_users')
    .select('member_id, name, role, is_active')
    .eq('is_active', true)
    .order('name', { ascending: true });
  if (error) throw new Error(error.message);
  return (data || []).map(u => ({ app_number: u.member_id, name: u.name, role: u.role }));
}

function listRoles() { return ROLE_OPTIONS; }

// ── 變數說明（給前端顯示）─────────────────────────────────
function listVariables() {
  return [
    { key: 'date',      desc: '日期', example: '2026-05-28' },
    { key: 'time',      desc: '時間', example: '09:00' },
    { key: 'weekday',   desc: '星期', example: '週四' },
    { key: 'year',      desc: '年',   example: '2026' },
    { key: 'month',     desc: '月',   example: '5' },
    { key: 'day',       desc: '日',   example: '28' },
    { key: 'ym',        desc: '年月', example: '2026-05' },
    { key: 'days_left', desc: '本月剩餘天數', example: '3' },
  ];
}

module.exports = {
  // CRUD
  list, get, create, update, remove,
  // 執行
  executeNow, runDueNotifications,
  // 歷史
  listLogs,
  // 輔助
  listSystemUsers, listRoles, listVariables, renderMessage, computeNextRunAt,
};
