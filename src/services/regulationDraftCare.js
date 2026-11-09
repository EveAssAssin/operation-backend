// services/regulationDraftCare.js — 規範草稿：編輯鎖、送審被擋、提醒、自動清除（2026-11-09 Louis）
//
// 為什麼：人員送審被 AI 擋下就停在草稿，不知道下一步；草稿一直鎖著這份規範，別人要改時（以前是開始改才看到、
//   後台甚至會直接進到別人的草稿）不知道誰在改、改到什麼時候。
// 規則：
//   鎖＝這份規範有 draft／returned／pending 版本（regulationService.OPEN_STATUSES）。pending 鎖到審核結束；
//     draft／returned「最後動作」超過 24 小時、且之後已提醒過作者 → 每天 03:00 清除（status=expired，軟刪除，可還原）。
//   提醒（LINE 推播，同營運部其他推播 linePushService）：
//     ① 送審被擋當下立刻一次  ② 最後動作後 3 小時還沒動、這段時間還沒提醒過 → 一次  ③ 每天 09:30 還有草稿的都提醒
//     ①② 只在 09:00～21:00 發（晚上延到隔天 09:00）。
//   設定 report_settings.regulation_draft_care = { enabled, remind_idle_hours, expire_hours, test_only_apps:[] }
//     test_only_apps 有值 → 只推給名單裡的人（其他人照常記錄但不推）。
const supabase = require('../config/supabase');
const linePush = require('./linePushService');

const FRONTEND = (process.env.OPERATION_FRONTEND_URL || 'https://operation-frontend.onrender.com').replace(/\/$/, '');
const TZ = 8 * 3600e3;
const DEF = { enabled: true, remind_idle_hours: 3, expire_hours: 24, test_only_apps: [] };
const must = (r, msg) => { if (r.error) throw new Error(`${msg}：${r.error.message}`); return r.data; };

async function cfg() {
  const { data } = await supabase.from('report_settings').select('value').eq('key', 'regulation_draft_care').maybeSingle();
  return { ...DEF, ...(data?.value || {}) };
}
const tpe = (d) => new Date(new Date(d).getTime() + TZ);
const hm = (d) => { const t = tpe(d); return `${String(t.getUTCHours()).padStart(2, '0')}:${String(t.getUTCMinutes()).padStart(2, '0')}`; };
const md = (d) => { const t = tpe(d); return `${t.getUTCMonth() + 1}/${t.getUTCDate()}`; };
const fmt = (d) => (d ? `${md(d)} ${hm(d)}` : '');
const tpeHour = (now = new Date()) => tpe(now).getUTCHours();

/** 最後動作後 expire_hours 小時，下一個 03:00（台北）＝ 預計自動清除時間 */
function releaseAt(lastAt, expireHours = DEF.expire_hours) {
  const t = new Date(new Date(lastAt).getTime() + expireHours * 3600e3);
  const x = tpe(t); const at3 = Date.UTC(x.getUTCFullYear(), x.getUTCMonth(), x.getUTCDate(), 3, 0, 0) - TZ;
  return new Date(at3 >= t.getTime() ? at3 : at3 + 864e5);
}

const next03After = (t) => { const x = tpe(t); const at3 = Date.UTC(x.getUTCFullYear(), x.getUTCMonth(), x.getUTCDate(), 3, 0, 0) - TZ; return new Date(at3 > new Date(t).getTime() ? at3 : at3 + 864e5); };
/** 實際預計清除時間：還沒提醒過的要等下一次提醒（白天立刻、晚上等隔天 09:00）之後的 03:00 */
function releaseFor(v, c = DEF, now = new Date()) {
  let rel = releaseAt(v.updated_at || v.created_at, c.expire_hours);
  const reminded = v.last_reminded_at && new Date(v.last_reminded_at) >= new Date(v.updated_at || v.created_at);
  if (!reminded) {
    const h = tpeHour(now);
    let nextRemind = now;
    if (h < 9 || h >= 21) { const x = tpe(now); nextRemind = new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth(), x.getUTCDate() + (h >= 21 ? 1 : 0), 9, 0, 0) - TZ); }
    const idleAt = new Date(new Date(v.updated_at || v.created_at).getTime() + c.remind_idle_hours * 3600e3);
    if (idleAt > nextRemind) nextRemind = idleAt;
    const after = next03After(nextRemind);
    if (after > rel) rel = after;
  } else if (rel <= now) rel = next03After(now);
  return rel;
}

/** 這份規範現在被誰鎖住（沒有＝null） */
async function lockOf(regId, c = null) {
  const { data } = await supabase.from('regulation_versions')
    .select('id, version, status, created_by_id, created_by_name, created_at, updated_at, submitted_at, last_reminded_at')
    .eq('regulation_id', Number(regId)).in('status', ['draft', 'returned', 'pending']).order('version', { ascending: false }).limit(1);
  const v = data && data[0];
  if (!v) return null;
  c = c || await cfg();
  const rel = v.status === 'pending' ? null : releaseFor(v, c);
  return {
    version_id: v.id, status: v.status, by_id: v.created_by_id || null, by_name: String(v.created_by_name || '其他人').replace(/（App）|（企劃 AI）/g, ''),
    started_at: v.created_at, last_at: v.updated_at || v.created_at, submitted_at: v.submitted_at, release_at: rel ? rel.toISOString() : null,
    text: v.status === 'pending'
      ? `這份規範已有修改在送審中（${String(v.created_by_name || '').replace(/（App）|（企劃 AI）/g, '')}，${fmt(v.submitted_at)} 送審），審核完成前不能再改。`
      : `${String(v.created_by_name || '其他人').replace(/（App）|（企劃 AI）/g, '')} 正在修改（開始於 ${fmt(v.created_at)}，最後動作 ${fmt(v.updated_at || v.created_at)}）${rel ? `，沒有繼續動作的話 ${fmt(rel)} 會自動釋放` : ''}。`,
  };
}
function lockedError(lock) {
  const e = new Error(lock.text); e.status = 409; e.code = 'LOCKED'; e.lock = lock; return e;
}

/** 草稿的作者 APP 編號（App 提的＝app:xxx；後台建的＝system_users.erpid → employees） */
async function authorApp(v) {
  return require('./regulationService').lookupSubmitterAppNumber(v);
}
function linkFor(v, app) {
  return /^app:/.test(String(v.created_by_id || ''))
    ? `${FRONTEND}/rules?tab=propose&app_number=${encodeURIComponent(app)}&v=${v.id}`
    : `${FRONTEND}/regulations?reg=${v.regulation_id}`;
}
async function push(app, msg, c) {
  if (!app) return { sent: false, why: 'no_app' };
  const only = (c.test_only_apps || []).map(String);
  if (only.length && !only.includes(String(app))) return { sent: false, why: 'test_only' };
  try { const r = await linePush.pushToUser(String(app), msg); const ok = !!r && r.success !== false && !r.error; return ok ? { sent: true } : { sent: false, why: 'push_error', detail: r && (r.error || r.message) }; }
  catch (e) { console.warn('[RegDraftCare] 推播失敗', app, e.message); return { sent: false, why: 'push_error' }; }
}
const titleOf = (v) => v.doc?.title || v.title || `規範 ${v.regulation_id}`;

/** 提醒一份草稿的作者（會寫 last_reminded_at） */
async function remindOne(v, kind, c, { dry = false } = {}) {
  const app = await authorApp(v);
  const rel = releaseFor({ ...v, last_reminded_at: new Date().toISOString() }, c);   // 這次就是提醒
  const head = kind === 'blocked' ? `⚠️ 你的規範修改「${titleOf(v)}」送審沒有成功，還在草稿` : `⏰ 你的規範修改「${titleOf(v)}」還在草稿，還沒送審`;
  const why = v.blocked_reason?.message ? `\n原因：${String(v.blocked_reason.message).slice(0, 160)}` : (v.status === 'returned' && v.review_note ? `\n退回原因：${String(v.review_note).slice(0, 160)}` : '');
  const msg = `${head}${why}\n下一步：點連結打開草稿 → 依上方說明修改 → 按「送審」；不改了請按「放棄草稿」。\n草稿期間別人不能改這份規範；沒有繼續動作的話 ${fmt(rel)} 會自動清除。\n${linkFor(v, app || '')}`;
  if (dry) return { id: v.id, app, kind, would: true };
  const r = await push(app, msg, c);
  // 真的推出去（或根本找不到作者）才記「已提醒」；測試名單外／推播失敗不記 → 不會因此被清除
  if (r.sent || r.why === 'no_app') await supabase.from('regulation_versions').update({ last_reminded_at: new Date().toISOString(), remind_count: (v.remind_count || 0) + 1 }).eq('id', v.id);
  return { id: v.id, app, kind, ...r };
}

/** 送審被擋：記原因＋立刻提醒（白天才推） */
async function onBlocked(versionId, err) {
  const issues = Array.isArray(err.issues) ? err.issues.slice(0, 8) : [];
  const reason = { kind: err.code === 'AI_UNRESOLVED' ? 'ai' : 'check', message: String(err.message || '').slice(0, 600), issues };
  const now = new Date().toISOString();
  const v = must(await supabase.from('regulation_versions').update({ blocked_at: now, blocked_reason: reason, updated_at: now }).eq('id', versionId).select().single(), '記錄送審被擋失敗');
  const c = await cfg();
  if (!c.enabled) return;
  const h = tpeHour();
  if (h >= 9 && h < 21) await remindOne(v, 'blocked', c);
}

const OPEN = ['draft', 'returned'];
async function openDrafts(onlyIds) {
  let q = supabase.from('regulation_versions')
    .select('id, regulation_id, version, status, created_by_id, created_by_name, created_at, updated_at, last_reminded_at, remind_count, blocked_reason, review_note, title:doc->>title')
    .in('status', OPEN).order('updated_at').limit(500);
  if (onlyIds && onlyIds.length) q = q.in('id', onlyIds.map(Number));
  return must(await q, '讀取草稿失敗') || [];
}
const remindedSinceLast = (v) => v.last_reminded_at && new Date(v.last_reminded_at) >= new Date(v.updated_at || v.created_at);

/** mode=idle：最後動作 N 小時後提醒一次（白天）；mode=daily：每天 09:30 全部提醒 */
async function remindDrafts({ mode = 'idle', dry = false, onlyIds = null, now = new Date() } = {}) {
  const c = await cfg();
  if (!c.enabled && !onlyIds) return { skipped: 'disabled' };
  const h = tpeHour(now);
  if (mode === 'idle' && (h < 9 || h >= 21) && !onlyIds) return { skipped: 'night' };
  const rows = await openDrafts(onlyIds);
  const out = [];
  for (const v of rows) {
    const last = new Date(v.updated_at || v.created_at).getTime();
    if (mode === 'idle') {
      if (now.getTime() - last < c.remind_idle_hours * 3600e3) continue;
      if (remindedSinceLast(v)) continue;
    } else if (mode === 'daily') {
      if (v.last_reminded_at && now.getTime() - new Date(v.last_reminded_at).getTime() < 3600e3) continue;   // 1 小時內剛提醒過就不重複
    }
    out.push(await remindOne(v, mode, c, { dry }));
  }
  return { mode, dry, count: out.length, items: out };
}

/** 每天 03:00：最後動作超過 expire_hours、且之後已提醒過 → expired（軟刪除） */
async function cleanupDrafts({ dry = false, onlyIds = null, now = new Date() } = {}) {
  const c = await cfg();
  if (!c.enabled && !onlyIds) return { skipped: 'disabled' };
  const rows = await openDrafts(onlyIds);
  const out = { expired: [], waiting_remind: [], fresh: 0 };
  for (const v of rows) {
    const last = new Date(v.updated_at || v.created_at).getTime();
    if (now.getTime() - last < c.expire_hours * 3600e3) { out.fresh += 1; continue; }
    if (!remindedSinceLast(v)) { out.waiting_remind.push(v.id); continue; }   // 還沒提醒過 → 延到下一輪
    if (!dry) {
      const ts = new Date().toISOString();
      must(await supabase.from('regulation_versions').update({ status: 'expired', expired_from: v.status, expired_at: ts,
        expire_reason: `超過 ${c.expire_hours} 小時沒有動作，自動清除（最後動作 ${fmt(v.updated_at || v.created_at)}）` }).eq('id', v.id).in('status', OPEN), '清除草稿失敗');
      const { data: reg } = await supabase.from('regulations').select('current_version').eq('id', v.regulation_id).maybeSingle();
      if (reg && Number(reg.current_version) === 0) await supabase.from('regulations').update({ status: 'disabled' }).eq('id', v.regulation_id);
    }
    out.expired.push({ id: v.id, regulation_id: v.regulation_id, title: v.title, by: v.created_by_name });
  }
  return { dry, ...out };
}

/** 還原被清除的草稿（後台） */
async function restore(versionId) {
  const v = must(await supabase.from('regulation_versions').select('*').eq('id', versionId).single(), '讀取版本失敗');
  if (v.status !== 'expired') throw new Error('只有自動清除的草稿可以還原');
  const lock = await lockOf(v.regulation_id);
  if (lock) throw lockedError(lock);
  const back = OPEN.includes(v.expired_from) ? v.expired_from : 'draft';
  must(await supabase.from('regulation_versions').update({ status: back, expired_at: null, expire_reason: null, updated_at: new Date().toISOString(), last_reminded_at: null }).eq('id', versionId), '還原失敗');
  const { data: reg } = await supabase.from('regulations').select('current_version, status').eq('id', v.regulation_id).maybeSingle();
  if (reg && Number(reg.current_version) === 0 && reg.status === 'disabled') await supabase.from('regulations').update({ status: 'draft' }).eq('id', v.regulation_id);
  return { ok: true, status: back };
}

/** 有人也想改：推播給鎖住的人（同一人對同一份 1 小時內只推一次） */
const wantSeen = new Map();
async function wantEdit(regId, requester) {
  const lock = await lockOf(regId);
  if (!lock) return { ok: true, unlocked: true };
  const k = `${regId}|${requester.app_number}`;
  if (wantSeen.has(k) && Date.now() - wantSeen.get(k) < 3600e3) return { ok: true, already: true, lock };
  const v = must(await supabase.from('regulation_versions').select('id, regulation_id, created_by_id, created_by_name, doc').eq('id', lock.version_id).single(), '讀取版本失敗');
  const app = await authorApp(v);
  if (String(app || '') === String(requester.app_number)) return { ok: true, self: true, lock };
  const c = await cfg();
  const msg = lock.status === 'pending'
    ? `📋 ${requester.name} 也想修改「${titleOf(v)}」，這份目前在送審中，審核完成後他才能改。`
    : `✏️ ${requester.name} 也想修改「${titleOf(v)}」。你的草稿還沒送審，請盡快送審，或不改了按「放棄草稿」讓他改。\n${linkFor(v, app || '')}`;
  const r = await push(app, msg, c);
  wantSeen.set(k, Date.now());
  return { ok: true, notified: r.sent, lock };
}

/** 有寫入動作就更新「最後動作」時間（只限 draft／returned） */
async function touch(versionId) {
  await supabase.from('regulation_versions').update({ updated_at: new Date().toISOString() }).eq('id', Number(versionId)).in('status', OPEN);
}

module.exports = { cfg, releaseAt, releaseFor, lockOf, lockedError, onBlocked, remindDrafts, cleanupDrafts, restore, wantEdit, touch, fmt };
