// services/regulationPropose.js — 人員從 App「查規範」提出新增／修改規範（2026-10-28）
//
// 誰可以提：左手稱號／權限符合 report_settings.regulation_propose 的設定
//   { permissions: ['規範修改'], titles: [] }
//   permissions＝左手「權限稱號」底下的權限名稱（例：規範修改、規範審核）
//   titles     ＝任何左手稱號名稱（權限稱號／獎金稱號／兌換稱號都比，例：樂活MAP文案編輯認證）
//   兩者任一符合就可以提；沒設定＝預設 permissions ['規範修改']
// 怎麼上線：沿用營運部規範系統的草稿 → 送審 → 指定審核人通過才上線（regulationService），
//   App 端提出的版本 created_by_id 記 'app:<APP 編號>'，只能看／改自己提的。
const axios = require('axios');
const supabase = require('../config/supabase');
const LH = require('./leftHandApi');
const svc = require('./regulationService');

const MAP_URL = process.env.LEFTHAND_API_URL || 'https://map.lohasglasses.com/_api/v1.ashx';
const DEF_RULE = { permissions: ['規範修改'], titles: [] };
const cache = new Map();          // erpid → { at, titles }
const TTL = 10 * 60 * 1000;

const asArr = (d) => { if (typeof d === 'string') { try { d = JSON.parse(d); } catch { return []; } } return Array.isArray(d) ? d : []; };
async function lhPost(method, erpid) {
  const r = await axios.post(MAP_URL, { method, employeeerpids: LH.aesEncrypt(String(erpid)) }, { timeout: 12000 });
  if (String(r.data?.statecode) !== '0') throw new Error(`左手 ${method} 回 ${r.data?.statecode}：${r.data?.message || ''}`);
  return asArr(r.data?.data)[0] || {};
}

/** 讀這個人在左手的全部稱號＋權限（10 分鐘快取） */
async function lefthandTitles(erpid) {
  const k = String(erpid || '');
  if (!k) return { titles: [], permissions: [] };
  const c = cache.get(k);
  if (c && Date.now() - c.at < TTL) return c.v;
  const [p, a, x] = await Promise.all([
    lhPost('getemployeepermissiontitle', k),
    lhPost('getemployeeawardtitle', k).catch(() => ({})),
    lhPost('getemployeeexchangetitle', k).catch(() => ({})),
  ]);
  const titles = new Set(), permissions = new Set();
  for (const t of p.permissionTitles || []) { if (t.permissionTitle) titles.add(t.permissionTitle); for (const q of t.permissions || []) if (q.permission) permissions.add(q.permission); }
  for (const t of a.awardTitles || []) if (t.title && t.isStart !== false) titles.add(t.title);
  for (const t of x.exchangeTitles || []) if (t.title) titles.add(t.title);
  const v = { titles: [...titles], permissions: [...permissions] };
  cache.set(k, { at: Date.now(), v });
  return v;
}

async function getRule() {
  const { data } = await supabase.from('report_settings').select('value').eq('key', 'regulation_propose').maybeSingle();
  const v = data?.value || {};
  return {
    permissions: Array.isArray(v.permissions) ? v.permissions : DEF_RULE.permissions,
    titles: Array.isArray(v.titles) ? v.titles : DEF_RULE.titles,
  };
}
async function setRule({ permissions, titles }, by) {
  const clean = (a) => [...new Set((Array.isArray(a) ? a : String(a || '').split(/[,，\n]/)).map(s => String(s).trim()).filter(Boolean))].slice(0, 50);
  const value = { permissions: clean(permissions), titles: clean(titles) };
  const { error } = await supabase.from('report_settings').upsert({ key: 'regulation_propose', value, updated_by: by || null, updated_at: new Date().toISOString() });
  if (error) throw new Error('儲存失敗：' + error.message);
  return value;
}

/** 這個人能不能提出新增／修改；左手問不到＝不能（嚴格那邊） */
async function check(emp) {
  const rule = await getRule();
  let lh;
  try { lh = await lefthandTitles(emp.erpid); }
  catch (e) { console.warn('[RegPropose] 讀左手稱號失敗', emp.erpid, e.message); return { can: false, reason: '暫時讀不到你的左手稱號，請稍後再試', rule }; }
  const hitP = rule.permissions.filter(p => lh.permissions.includes(p));
  const hitT = rule.titles.filter(t => lh.titles.includes(t));
  const can = hitP.length + hitT.length > 0;
  return { can, matched: [...hitP.map(p => `權限：${p}`), ...hitT.map(t => `稱號：${t}`)], rule,
    reason: can ? '' : `要有左手${rule.permissions.length ? `權限「${rule.permissions.join('／')}」` : ''}${rule.permissions.length && rule.titles.length ? '或' : ''}${rule.titles.length ? `稱號「${rule.titles.join('／')}」` : ''}才能提出新增或修改` };
}
async function mustCan(emp) { const c = await check(emp); if (!c.can) { const e = new Error(c.reason); e.status = 403; throw e; } return c; }

const userOf = (emp) => ({ id: `app:${emp.app_number}`, name: `${emp.name}（App）`, erpid: emp.erpid, role: 'app_staff' });
async function ownVersion(emp, vid) {
  const v = await svc.getVersion(vid);
  if (String(v.created_by_id || '') !== `app:${emp.app_number}`) { const e = new Error('只能看自己提出的規範修改'); e.status = 403; throw e; }
  return v;
}

async function startEdit(emp, regId) {
  await mustCan(emp);
  const { open_draft } = await svc.getRegulation(regId);
  if (open_draft && String(open_draft.created_by_id || '') !== `app:${emp.app_number}`) {
    throw new Error(open_draft.status === 'pending' ? '這份規範已有修改在送審中，審核完成前不能再提' : `這份規範 ${open_draft.created_by_name || '其他人'} 正在修改中，請等他送審完成`);
  }
  return svc.createDraft(regId, userOf(emp));
}
async function createNew(emp, body) { await mustCan(emp); return svc.createNewRegulation(body || {}, userOf(emp)); }

async function mine(emp) {
  const { data, error } = await supabase.from('regulation_versions')
    .select('id, regulation_id, version, status, change_note, review_note, reviewed_by_name, reviewed_at, submitted_at, updated_at, created_at, title:doc->>title')
    .eq('created_by_id', `app:${emp.app_number}`).order('updated_at', { ascending: false, nullsFirst: false }).limit(50);
  if (error) throw new Error('讀取失敗：' + error.message);
  return data;
}

module.exports = { lefthandTitles, getRule, setRule, check, mustCan, userOf, ownVersion, startEdit, createNew, mine };
