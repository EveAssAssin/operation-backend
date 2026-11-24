// services/vendorRebate.js —— 廠商回饋（2026-11-24 營運）
//   inclusive（帳單內含 10%）：廠商帳單 100 → 帳面 100、回饋 10、出款 90（門市照 100 分帳）
//   exclusive（帳單外加 10%）：廠商帳單 90 → 帳面 100（90 ÷ 0.9）、回饋 10、出款 90（門市照 100 分帳）
//   兩種都是：門市成本＝帳面（gross）、實際付給廠商＝出款（payout）、差額＝回饋
const r0 = (n) => Math.round(Number(n) || 0);
const MODES = { inclusive: '帳單內含', exclusive: '帳單外加' };

function compute(billed, pct, mode) {
  const b = Number(billed) || 0;
  const p = Number(pct) || 0;
  if (!p || !MODES[mode]) return { rebate_pct: null, rebate_mode: null, gross_amount: null, rebate_amount: null, payout_amount: null };
  if (p <= 0 || p >= 100) throw new Error('回饋 % 要在 0～100 之間');
  if (mode === 'inclusive') {
    const rebate = r0(b * p / 100);
    return { rebate_pct: p, rebate_mode: mode, gross_amount: r0(b), rebate_amount: rebate, payout_amount: r0(b) - rebate };
  }
  const gross = r0(b / (1 - p / 100));
  return { rebate_pct: p, rebate_mode: mode, gross_amount: gross, rebate_amount: gross - r0(b), payout_amount: r0(b) };
}

/** 外加：每列照比例放大到帳面金額（尾差給金額最大那列），讓門市分帳合計＝帳面 */
function scaleRows(rows, gross, key = 'amount') {
  const total = rows.reduce((s, x) => s + Number(x[key] || 0), 0);
  if (!total || gross == null || r0(total) === r0(gross)) return rows;
  const out = rows.map((x) => ({ ...x, [key]: r0(Number(x[key]) * gross / total) }));
  const diff = r0(gross) - out.reduce((s, x) => s + x[key], 0);
  if (diff) { let i = 0; out.forEach((x, j) => { if (Math.abs(x[key]) > Math.abs(out[i][key])) i = j; }); out[i][key] += diff; }
  return out;
}

const payAmt = (r) => (r && r.payout_amount != null ? Number(r.payout_amount) : Number((r && r.total_amount) || 0));

module.exports = { compute, scaleRows, payAmt, MODES };
