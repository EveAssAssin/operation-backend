// services/salaryMonth.js —— 月報「薪資」抓左手（2026-10-20 營運：人員費用抓左手）
// 左手 hrm getemployeesalarydetails（employeeErpids 每次 ≤50、startdate／enddate 同一個月）：
//   每人每月一筆，groupName＝那個月算薪的門市；total＝實發（已扣員工自付健保 feeHealth／眷屬 feeDependents，兩者是負數）
//   月報「薪資」＝公司付出的薪資＝total − feeHealth − feeDependents（員工自付健保是從薪資扣的，薪資成本要加回來）
//   勞健保（公司負擔）、二代健保左手沒有 → 照舊手填
// 人員名單＝每家門市 getemployeebygroup（含離職標記的人，離職當月也要算薪）
const LH = require('./leftHandApi');
const supabase = require('../config/supabase');

const HRM = process.env.LEFTHAND_HRM_URL || 'https://hrm.lohaseyewear.tw/_api/v1.ashx';
const cache = new Map();
const norm = (s) => String(s || '').replace(/^愛民眼鏡/, '').replace(/\s+/g, '').replace(/店$/, '');

async function hrmPost(body) {
  const r = await fetch(HRM, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json();
  if (typeof j.data === 'string') { try { j.data = JSON.parse(j.data); } catch (e) { /* */ } }
  return j;
}

/** { byStore: { erpid: { gross, net, emp_health, people, from_groups } }, unmatched:[groupName], error? }；1 小時快取 */
function salaryMonth(ym) {
  const hit = cache.get(ym);
  if (hit && Date.now() - hit.at < 60 * 60e3) return hit.p;   // 同時多家店一起算月報：共用同一個查詢
  const p = load(ym);
  cache.set(ym, { at: Date.now(), p });
  p.then((v) => { if (v.error) cache.delete(ym); });
  return p;
}
async function load(ym) {
  const [y, m] = ym.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  let v;
  try {
    const { data: deps } = await supabase.from('departments').select('store_erpid, store_name, report_kind').eq('report_kind', 'store');
    const byName = new Map((deps || []).map((d) => [norm(d.store_name), d.store_erpid]));
    const home = new Map();   // erpid → 名單上的門市
    let i = 0;
    const worker = async () => {
      while (i < (deps || []).length) {
        const d = deps[i++];
        try { (await LH.getEmployeesByGroup(d.store_erpid) || []).forEach((e) => { if (e.erpid && !String(e.erpid).startsWith('9999')) home.set(String(e.erpid), d.store_erpid); }); } catch (e) { /* 單店失敗不擋 */ }
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    const ids = [...home.keys()];
    const byStore = {}, unmatched = new Set();
    for (let k = 0; k < ids.length; k += 50) {
      const part = ids.slice(k, k + 50);
      const r = await hrmPost({ method: 'getemployeesalarydetails', employeeErpids: LH.aesEncrypt(part.join(',')), startdate: `${ym}-01`, enddate: `${ym}-${last}` });
      if (String(r.statecode) !== '0') throw new Error(r.message || '左手薪資查詢失敗');
      for (const p of r.data || []) {
        for (const s of p.salaryDetails || []) {
          if (Number(s.year) !== y || Number(s.month) !== m) continue;
          const total = Number(s.total) || 0;
          if (!total) continue;
          let store = byName.get(norm(s.groupName));
          if (!store) { unmatched.add(s.groupName || '（沒寫門市）'); store = home.get(String(p.employeeId)) || null; }
          if (!store) continue;
          const eh = -(Number(s.feeHealth) || 0) - (Number(s.feeDependents) || 0);   // 員工自付（原本是負數）
          const t = (byStore[store] = byStore[store] || { gross: 0, net: 0, emp_health: 0, people: 0, from_groups: [] });
          t.gross += total + eh; t.net += total; t.emp_health += eh; t.people += 1;
          if (s.groupName && !t.from_groups.includes(s.groupName)) t.from_groups.push(s.groupName);
        }
      }
    }
    for (const t of Object.values(byStore)) { t.gross = Math.round(t.gross); t.net = Math.round(t.net); t.emp_health = Math.round(t.emp_health); }
    v = { byStore, unmatched: [...unmatched], people_total: ids.length };
  } catch (e) {
    v = { byStore: {}, error: `左手薪資拿不到：${e.message}` };
  }
  return v;
}
module.exports = { salaryMonth };
