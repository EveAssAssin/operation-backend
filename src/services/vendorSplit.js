// services/vendorSplit.js —— 寄銷對帳單拆分（2026-11-24 營運；第一家：晶碩）
// ============================================================
// 晶碩每月給「對帳單」：各門市（店號 PV67001…）各品項銷售額 → 依抽成％扣掉抽成，剩下「發票開立金額／匯款金額」匯給晶碩。
// 但 38% 抽成我們內部要再拆：門市只拿 35%，2% 給中間商，1% 是公司（總部）收入 →
//   廠商請款（出款給晶碩）＝匯款金額（X 欄）
//   中間商回饋（出款給中間商）＝ 38%抽成 × 2/38
//   總部收入（暫列，帳務系統完整後再入帳）＝ 38%抽成 × 1/38
//   門市開帳（進門市月報）＝ 廠商請款＋中間商回饋＋總部收入（＝門市實際負擔）
// 規則存在廠商（billing_sources.split_rules）：[{ match: '38%抽成', rate: 38, intermediary: 2, hq: 1 }]（門市＝rate − 中間商 − 總部）
// 晶碩偶爾加欄位 → 一律照表頭名稱找欄位，不照位置；匯款欄右邊的（我們自己加的）全部不看。
// 門市對照：店號 → 我們的門市（billing_sources.split_store_map），沒設過的照店名自動對（去掉「樂活」「門市」等字比對）。
// ============================================================
const XLSX = require('xlsx');
const r0 = (n) => Math.round(Number(n) || 0);
const clean = (v) => String(v == null ? '' : v).replace(/\s+/g, '').trim();
const num = (v) => { if (v == null || v === '') return 0; const n = Number(String(v).replace(/[,\s]/g, '')); return Number.isFinite(n) ? n : 0; };

const REMIT_RE = /匯款金額|發票開立金額|應付金額/;
const CODE_RE = /^店號$|門市代號|營運中心代號|客戶代號/;
const NAME_RE = /^店名$|門市名稱|營運中心$/;
const COMM_RE = /抽成|獎金/;

/** 讀對帳單 → { sheet, headers, rows:[{ code, name, total, remit, comm:{表頭:金額} }], warnings } */
function parseStatement(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: false });
  const names = [...wb.SheetNames].sort((a, b) => (/對帳單/.test(b) ? 1 : 0) - (/對帳單/.test(a) ? 1 : 0));
  for (const sn of names) {
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[sn], { header: 1, raw: true, defval: null });
    for (let i = 0; i < Math.min(rows.length, 20); i++) {
      const h = (rows[i] || []).map(clean);
      const remitIdx = h.findIndex((x) => REMIT_RE.test(x));
      const codeIdx = h.findIndex((x) => CODE_RE.test(x));
      if (remitIdx < 0 || codeIdx < 0) continue;
      const nameIdx = h.findIndex((x) => NAME_RE.test(x));
      const totalIdx = h.findIndex((x, j) => j < remitIdx && /^(總計|合計|銷售總計|銷售額)$/.test(x));
      const commIdx = h.map((x, j) => (j < remitIdx && j !== totalIdx && COMM_RE.test(x) ? j : -1)).filter((j) => j >= 0);
      const out = [];
      for (const r of rows.slice(i + 1)) {
        const code = clean(r[codeIdx]);
        if (!code || /合計|總計|備註/.test(code)) continue;
        const remit = r[remitIdx];
        if (remit == null || remit === '' || !Number.isFinite(num(remit))) continue;
        const comm = {};
        for (const j of commIdx) comm[h[j]] = num(r[j]);
        out.push({ code, name: String(r[nameIdx] == null ? '' : r[nameIdx]).trim(), total: totalIdx >= 0 ? num(r[totalIdx]) : null, remit: num(remit), comm });
      }
      if (!out.length) continue;
      return { sheet: sn, headers: { remit: h[remitIdx], total: totalIdx >= 0 ? h[totalIdx] : null, commissions: commIdx.map((j) => h[j]) }, rows: out, warnings: [] };
    }
  }
  throw new Error('看不懂這份對帳單：找不到「店號」和「匯款金額／發票開立金額」欄位');
}

// ── 門市自動對照 ──
const core = (s) => String(s || '').split(/\n/)[0].replace(/樂活|愛民眼鏡|愛民|眼鏡|門市|店|LOHAS|\s/gi, '');
function autoMatch(name, targets) {
  const c = core(name);
  if (!c) return null;
  const hits = targets.map((t) => ({ t, k: core(t.store_name) })).filter((x) => x.k && (c === x.k || c.includes(x.k)));
  if (!hits.length) return null;
  hits.sort((a, b) => b.k.length - a.k.length);
  if (hits.length > 1 && hits[0].k.length === hits[1].k.length) return null;   // 分不出來
  return hits[0].t;
}

function cleanRules(rules) {
  return (Array.isArray(rules) ? rules : []).map((x) => ({
    match: String(x.match || '').trim().slice(0, 30), rate: Number(x.rate) || 0, intermediary: Number(x.intermediary) || 0, hq: Number(x.hq) || 0,
  })).filter((x) => x.match && x.rate > 0 && x.intermediary + x.hq > 0 && x.intermediary + x.hq < x.rate);
}

/** 純函式：拆分。targets＝我們的門市清單；map＝{ 店號: store_erpid } */
function computeSplit(parsed, rules, map, targets) {
  const R = cleanRules(rules);
  const byId = new Map(targets.map((t) => [String(t.store_erpid), t]));
  const rows = parsed.rows.map((r) => {
    let inter = 0, hq = 0;
    const used = [];
    for (const [hdr, v] of Object.entries(r.comm)) {
      const rule = R.find((x) => clean(hdr).includes(clean(x.match)));
      if (!rule || !v) continue;
      inter += v * rule.intermediary / rule.rate; hq += v * rule.hq / rule.rate;
      used.push(hdr);
    }
    const mapped = map && map[r.code] ? byId.get(String(map[r.code])) : null;
    const auto = mapped ? null : autoMatch(r.name, targets);
    const t = mapped || auto;
    const payout = r0(r.remit); const ii = r0(inter); const hh = r0(hq);
    return { code: r.code, name: r.name, sales: r.total == null ? null : r0(r.total), payout, intermediary: ii, hq: hh, store_cost: payout + ii + hh,
      store_erpid: t ? String(t.store_erpid) : null, store_name: t ? t.store_name : null, matched_by: mapped ? 'map' : auto ? 'auto' : null, rules_used: used };
  });
  const sum = (k) => rows.reduce((s, x) => s + (Number(x[k]) || 0), 0);
  const dup = {};
  for (const x of rows) if (x.store_erpid) (dup[x.store_erpid] = dup[x.store_erpid] || []).push(x.code);
  const warnings = [];
  for (const [sid, codes] of Object.entries(dup)) if (codes.length > 1) warnings.push(`${byId.get(sid)?.store_name || sid} 對到兩個店號（${codes.join('、')}），請確認`);
  if (!R.length) warnings.push('這家廠商還沒設拆分規則：門市開帳＝廠商請款');
  return {
    sheet: parsed.sheet, headers: parsed.headers, rules: R, rows,
    totals: { sales: sum('sales'), payout: sum('payout'), intermediary: sum('intermediary'), hq: sum('hq'), store_cost: sum('store_cost') },
    unmapped: rows.filter((x) => !x.store_erpid).map((x) => ({ code: x.code, name: x.name })), warnings, at: new Date().toISOString(),
  };
}

module.exports = { parseStatement, computeSplit, autoMatch, cleanRules, core };
