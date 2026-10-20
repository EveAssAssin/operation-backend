// services/shareholderRoster.js —— 股東名單（2026-10-20 營運定案）
// 左手會新增一個「股東」部門放外部股東；但一般在職人員也可能是股東 → 門市基礎設定可挑的人＝
// 左手全部在職人員（getallemployees）＋股東部門的人（排在前面）。姓名／客編由左手決定，不由請求帶進來。
// App「樂活人員 → 投資管理」按鈕＝股東部門的人 ∪ 門市基礎設定裡現在或之後有持股的人。
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

/** { group, list:[{erpid,name,app_number,in_dept}], dept_count, error? }；10 分鐘快取，force＝重抓 */
async function roster(force) {
  if (!force && cache.data && Date.now() - cache.at < 10 * 60e3) return cache.data;
  const group = await groupErpid();
  try {
    const [emps, all] = await Promise.all([group ? LH.getEmployeesByGroup(group) : Promise.resolve([]), LH.getAllEmployees()]);
    const apps = new Map((all || []).map((x) => [String(x.employeeerpid), x.employeeappnumber ? String(x.employeeappnumber) : null]));
    const dept = (emps || []).filter(LH.isValidEmployee).map((e) => ({ erpid: String(e.erpid), name: e.name, app_number: apps.get(String(e.erpid)) || null, in_dept: true }));
    const seen = new Set(dept.map((x) => x.erpid));
    const rest = (all || []).filter((x) => x.employeeerpid && !seen.has(String(x.employeeerpid)) && !String(x.employeeerpid).startsWith('9999'))
      .map((x) => ({ erpid: String(x.employeeerpid), name: x.employeename, app_number: x.employeeappnumber ? String(x.employeeappnumber) : null, in_dept: false }))
      .sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh-Hant'));
    const data = { group, dept_count: dept.length, list: dept.concat(rest), error: group ? null : '左手還找不到「股東」部門（建好、放進至少一位股東後會自動找到；也可以直接填部門編號）；在職人員照樣可以選' };
    cache = { at: Date.now(), data };
    syncPortal(dept).catch((e) => console.warn('[shareholderRoster] portal 同步失敗', e.message));
    return data;
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
/** dept＝股東部門的人；再加上門市基礎設定裡現在或之後有持股的人（一般在職人員也可能是股東） */
async function syncPortal(dept) {
  const ym = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 7);
  const { data: hs } = await supabase.from('store_shareholders').select('app_number, to_ym');
  const holders = (hs || []).filter((h) => h.app_number && (!h.to_ym || h.to_ym >= ym)).map((h) => String(h.app_number));
  const apps = [...new Set((dept || []).map((x) => x.app_number).filter(Boolean).concat(holders))].sort();
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
/** 股東有新增／結束／刪除時呼叫（不等左手：用快取的股東部門名單） */
async function resync() {
  const ro = cache.data || await roster(false);
  if (!ro.list || !ro.list.length) return null;   // 左手查不到時不送（不要把股東部門的人清掉）
  const dept = ro.list.filter((x) => x.in_dept);
  lastSent = '';
  return syncPortal(dept);
}
/** 開機後 1 分鐘、之後每 6 小時：重抓名單（順便同步 portal） */
function startInvestSync() {
  const run = () => roster(true).catch((e) => console.warn('[shareholderRoster]', e.message));
  setTimeout(run, 60e3);
  setInterval(run, 6 * 3600e3);
}
module.exports = { roster, setGroup, startInvestSync, resync };
