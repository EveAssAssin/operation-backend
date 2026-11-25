// services/regulationContext.js —— 規範編輯助理的「查各系統現況」（唯讀，2026-11-25 Louis）
//   起因：改「店長加給」時編輯助理只看得到規範文字，看不到市場部店長評核實際有哪五項、哪些指標、月報盈餘多少，
//         只能反問使用者或憑空寫。現在先讓 AI 挑要查哪些主題，再把查到的摘要放進提示，條文就能跟系統對齊。
//   主題來源：
//     ① 市場部 GET /api/internal/reg-context（store_eval 店長評核、store_goal 門市任務、store_staff 門市人員、
//        education 教育訓練 LMS、planning_calendar 企劃部活動月曆）；認證 x-internal-key＝MARKET_INTERNAL_KEY（同門市月報）
//     ② 營運部自己：store_profit 門市月報（已關帳）盈餘
//   全部只讀；查不到就略過，不擋編輯助理。新增主題：市場部那邊加 TOPICS，或這裡加 LOCAL。
const axios = require('axios');
const supabase = require('../config/supabase');

const MARKET_BASE = () => (process.env.MARKET_BACKEND_URL || 'https://market-backend-0544.onrender.com').replace(/\/+$/, '');
const twYm = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 7);
const money = (n) => (n == null || isNaN(n) ? '—' : Math.round(Number(n)).toLocaleString());

const LOCAL = {
  store_profit: {
    title: '門市月報（已關帳）每月盈餘', source: '營運部系統 store_month_reports',
    desc: '各門市近幾個已關帳月份的營收、支出、門市盈餘（分紅、獎金、加給要算盈餘比例時用）',
    async run() {
      const { data, error } = await supabase.from('store_month_reports').select('store_erpid, ym, snapshot->store_name, snapshot->totals')
        .eq('status', 'closed').order('ym', { ascending: false }).limit(400);
      if (error) throw new Error(error.message);
      const yms = [...new Set((data || []).map((r) => r.ym))].sort().reverse().slice(0, 3);
      if (!yms.length) return '還沒有已關帳的門市月報';
      const by = {};
      (data || []).filter((r) => yms.includes(r.ym)).forEach((r) => {
        const n = r.store_name || r.store_erpid; const t = r.totals || {};
        (by[n] = by[n] || {})[r.ym] = { profit: t.profit, inn: t.total_in };
      });
      const L = [`最近已關帳月份：${yms.join('、')}（盈餘＝月報「淨利」，單位元；括號＝當月總收入）`];
      Object.entries(by).forEach(([n, m]) => L.push(`${n}：` + yms.map((y) => (m[y] ? `${y} ${money(m[y].profit)}（${money(m[y].inn)}）` : `${y} 未關帳`)).join('；')));
      return L.join('\n');
    },
  },
};

let catCache = { at: 0, list: [] };
async function catalog() {
  const local = Object.entries(LOCAL).map(([key, t]) => ({ key, title: t.title, source: t.source, desc: t.desc }));
  const key = process.env.MARKET_INTERNAL_KEY;
  if (!key) return local;
  if (Date.now() - catCache.at < 10 * 60e3 && catCache.list.length) return [...catCache.list, ...local];
  try {
    const { data } = await axios.get(`${MARKET_BASE()}/api/internal/reg-context/catalog`, { headers: { 'x-internal-key': key }, timeout: 15000 });
    catCache = { at: Date.now(), list: (data && data.data) || [] };
  } catch (e) { console.warn('[RegCtx] 讀市場部主題清單失敗：', e.response?.status || e.message); }
  return [...catCache.list, ...local];
}

/** 依 keys 查；回 { used:[{key,title,source}], text, errors:{} } */
async function gather(keys, { ym } = {}) {
  const want = [...new Set((keys || []).map(String))].slice(0, 5);
  const used = []; const parts = []; const errors = {};
  const localKeys = want.filter((k) => LOCAL[k]);
  const remoteKeys = want.filter((k) => !LOCAL[k]);
  const jobs = localKeys.map(async (k) => {
    try { const text = await LOCAL[k].run({ ym }); used.push({ key: k, title: LOCAL[k].title, source: LOCAL[k].source }); parts.push({ k, title: LOCAL[k].title, source: LOCAL[k].source, text }); }
    catch (e) { errors[k] = e.message; }
  });
  if (remoteKeys.length && process.env.MARKET_INTERNAL_KEY) {
    jobs.push((async () => {
      try {
        const { data } = await axios.get(`${MARKET_BASE()}/api/internal/reg-context`, {
          params: { topics: remoteKeys.join(','), ym: ym || twYm() }, headers: { 'x-internal-key': process.env.MARKET_INTERNAL_KEY }, timeout: 45000 });
        const d = (data && data.data) || {};
        Object.entries(d.topics || {}).forEach(([k, t]) => { used.push({ key: k, title: t.title, source: t.source }); parts.push({ k, ...t }); });
        Object.assign(errors, d.errors || {});
      } catch (e) { remoteKeys.forEach((k) => { errors[k] = `市場部查詢失敗：${e.response?.status || e.message}`; }); }
    })());
  } else if (remoteKeys.length) remoteKeys.forEach((k) => { errors[k] = '營運部沒設 MARKET_INTERNAL_KEY'; });
  await Promise.all(jobs);
  const order = new Map(want.map((k, i) => [k, i]));
  parts.sort((a, b) => order.get(a.k) - order.get(b.k));
  used.sort((a, b) => order.get(a.key) - order.get(b.key));
  const text = parts.map((p) => `## ${p.title}（來源：${p.source}）\n${p.text}`).join('\n\n');
  if (Object.keys(errors).length) console.warn('[RegCtx] 部分主題查不到', errors);
  return { used, text, errors };
}

/** 讓 AI 從主題清單挑要查的（最多 4 個）。claudeFn＝regulationAi 的 claude（避免循環引用） */
async function pick(claudeFn, { message, title }) {
  const list = await catalog();
  if (!list.length) return [];
  const sys = `你是規範編輯助理的查資料小幫手。使用者要修改公司規範，下面是可以查的各系統資料主題。
只挑「寫這次條文真的需要對照系統實際設定或數字」的主題，最多 4 個；純改字、改格式、跟這些主題無關的就給空陣列。
只輸出 JSON：{"topics":["key", …]}`;
  const content = [{ type: 'text', text: [`# 正在修改的規範：${title || ''}`, `# 使用者的需求\n${String(message || '').slice(0, 3000)}`,
    '# 可以查的主題', list.map((t) => `- ${t.key}：${t.title}——${t.desc}`).join('\n')].join('\n\n') }];
  try {
    const out = await claudeFn({ fast: true, system: sys, content, maxTokens: 200, timeout: 30000 });
    const ok = new Set(list.map((t) => t.key));
    return [...new Set((out.topics || []).map(String).filter((k) => ok.has(k)))].slice(0, 4);
  } catch (e) { console.warn('[RegCtx] 挑主題失敗：', e.message); return []; }
}

/** 一次做完：挑主題 → 查 → 回 { used, text } */
async function forRequest(claudeFn, { message, title, topics }) {
  const keys = Array.isArray(topics) && topics.length ? topics : await pick(claudeFn, { message, title });
  if (!keys.length) return { used: [], text: '', errors: {} };
  return gather(keys);
}

const PROMPT_NOTE = '以下是各系統目前的實際設定與數據（唯讀查詢結果，只能引用、不能改；條文要跟這些設定一致。系統資料跟使用者需求不一致時，在 understanding 點出來，不要自己決定以哪個為準）';

module.exports = { catalog, gather, pick, forRequest, PROMPT_NOTE, _LOCAL: LOCAL };
