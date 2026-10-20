// services/shareholderRoster.js —— 股東名單＝左手「股東」部門的人（2026-10-20 營運定案）
// 左手會新增一個「股東」部門，把股東放進去；門市基礎設定選股東只能從這份名單挑（姓名／客編由左手決定，不由請求帶進來）。
// 行政部門不在 getstoredatas 裡 → 部門編號存 report_settings.shareholder_group_erpid（門市基礎設定頁可設）；
// 沒設時：①營運部 departments 名稱含「股東」②到左手試行政部門常見編號（1～40、120～140，2026-10-20 實查現有：
// 1 工程部、2 企劃部、3 暗部、4 營運部、5 商城倉管部、123 市場部），groupname 含「股東」就記下來（部門裡要至少有一個人才看得到名稱）。
const supabase = require('../config/supabase');
const LH = require('./leftHandApi');

let cache = { at: 0, data: null };
async function groupErpid() {
  const { data } = await supabase.from('report_settings').select('value').eq('key', 'shareholder_group_erpid').maybeSingle();
  if (data && data.value) return String(data.value);
  const { data: d } = await supabase.from('departments').select('store_erpid, store_name').ilike('store_name', '%股東%').limit(1);
  if (d && d[0]) return String(d[0].store_erpid);
  return probe();
}
let lastProbe = 0;
async function probe() {
  if (Date.now() - lastProbe < 30 * 60e3) return null;
  lastProbe = Date.now();
  const ids = [...Array(40).keys()].map((i) => String(i + 1)).concat([...Array(21).keys()].map((i) => String(120 + i)));
  for (let i = 0; i < ids.length; i += 8) {
    const part = ids.slice(i, i + 8);
    const rs = await Promise.all(part.map((id) => LH.getEmployeesByGroup(id).catch(() => [])));
    const k = rs.findIndex((l) => Array.isArray(l) && l.some((x) => String(x.groupname || '').includes('股東')));
    if (k >= 0) { await setGroup(part[k]); console.log('[shareholderRoster] 找到左手股東部門', part[k]); return part[k]; }
  }
  return null;
}

/** { group, list:[{erpid,name,app_number}], error? }；10 分鐘快取，force＝重抓 */
async function roster(force) {
  if (!force && cache.data && Date.now() - cache.at < 10 * 60e3) return cache.data;
  const group = await groupErpid();
  if (!group) return { group: null, list: [], error: '左手還找不到「股東」部門（部門建好、放進至少一位股東後會自動找到；也可以直接填部門編號）' };
  try {
    const [emps, all] = await Promise.all([LH.getEmployeesByGroup(group), LH.getAllEmployees()]);
    const apps = new Map((all || []).map((x) => [String(x.employeeerpid), x.employeeappnumber ? String(x.employeeappnumber) : null]));
    const list = (emps || []).filter(LH.isValidEmployee).map((e) => ({ erpid: String(e.erpid), name: e.name, app_number: apps.get(String(e.erpid)) || null }));
    cache = { at: Date.now(), data: { group, list } };
    syncPortal(list).catch((e) => console.warn('[shareholderRoster] portal 同步失敗', e.message));
    return cache.data;
  } catch (e) {
    return { group, list: [], error: `左手查詢失敗：${e.message}` };
  }
}
async function setGroup(erpid) {
  const { error } = await supabase.from('report_settings').upsert({ key: 'shareholder_group_erpid', value: String(erpid) }, { onConflict: 'key' });
  if (error) throw error;
  cache = { at: 0, data: null };
  lastProbe = 0;
}
// ── App「樂活人員」的「投資管理」按鈕：portal 角色「投資管理」＝這份名單（有客編的人）──
// portal（Supabase dsvmwkbdjeabiizxusrn）rpc investment_sync_members；金鑰明碼 report_settings.portal_invest_key，
// portal 只存 sha256（private.sync_keys name=investment）。名單沒變就不重送；部門找不到時不送（不要把人清光）。
const PORTAL_RPC = 'https://dsvmwkbdjeabiizxusrn.supabase.co/rest/v1/rpc/investment_sync_members';
const PORTAL_PUB = 'sb_publishable_kFqPpN0CTCcanGUQL1HNkQ_XubQw_6d';   // portal 的公開金鑰（publishable，本來就給前端用）
let lastSent = '';
async function syncPortal(list) {
  const apps = [...new Set(list.map((x) => x.app_number).filter(Boolean))].sort();
  const sig = apps.join(',');
  if (sig === lastSent) return null;
  const { data } = await supabase.from('report_settings').select('value').eq('key', 'portal_invest_key').maybeSingle();
  if (!data || !data.value) return null;
  const r = await fetch(PORTAL_RPC, { method: 'POST', headers: { apikey: PORTAL_PUB, 'Content-Type': 'application/json' }, body: JSON.stringify({ p_key: data.value, p_apps: apps }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.message || `HTTP ${r.status}`);
  lastSent = sig;
  console.log('[shareholderRoster] portal 投資管理', JSON.stringify(j));
  return j;
}
/** 開機後 1 分鐘、之後每 6 小時：重抓名單（順便同步 portal） */
function startInvestSync() {
  const run = () => roster(true).catch((e) => console.warn('[shareholderRoster]', e.message));
  setTimeout(run, 60e3);
  setInterval(run, 6 * 3600e3);
}
module.exports = { roster, setGroup, startInvestSync };
