// routes/storeReportExternal.js —— 門市月報給「店長」看（2026-10-20）
// 營運定案：店長關帳後才看得到月報、寫心得；店長只看金額（不給廠商／帳單明細、不給股東分紅）。
// 呼叫端：市場部店長評核 /sm（market-backend services/smEval/monthReport.js），店長身分由市場部驗過後帶 store。
// 認證：header x-report-key；金鑰 sha256 存在 report_settings.ext_report_keys（[{hash,label}]），明碼只放在呼叫端。
//   GET  /api/external/store-report/months?store=120085     這家店已關帳的月份
//   GET  /api/external/store-report?store=120085&ym=2026-09 一個月（沒關帳＝只回狀態）
//   POST /api/external/store-report/note {store, ym, note, by}  店長心得（只有已關帳才能寫）
const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const supabase = require('../config/supabase');

const YM = /^\d{4}-(0[1-9]|1[0-2])$/;
const bad = (res, msg, code = 400) => res.status(code).json({ success: false, message: msg });
let keyCache = { at: 0, hashes: [] };
async function keyOk(req) {
  const k = String(req.headers['x-report-key'] || '');
  if (!k) return false;
  if (Date.now() - keyCache.at > 5 * 60e3) {
    const { data } = await supabase.from('report_settings').select('value').eq('key', 'ext_report_keys').maybeSingle();
    keyCache = { at: Date.now(), hashes: ((data && data.value) || []).map((x) => x.hash) };
  }
  const h = crypto.createHash('sha256').update(k).digest('hex');
  return keyCache.hashes.includes(h);
}
router.use(async (req, res, next) => { try { if (await keyOk(req)) return next(); } catch (e) { /* 落到 403 */ } bad(res, 'forbidden', 403); });

const r0 = (n) => Math.round(Number(n) || 0);
/** 店長版：只留金額，拿掉每列的帳單明細、廠商、股東 */
function managerView(snap, rep) {
  const rows = (groups) => (groups || []).map((g) => ({ name: g.name, total: r0(g.total), rows: (g.rows || []).filter((r) => r.amount).map((r) => ({ name: r.name, amount: r0(r.amount) })) }));
  const rv = snap.revenue || {};
  const pick = (k) => (rv[k] ? { name: rv[k].name, amount: rv[k].amount == null ? null : r0(rv[k].amount) } : null);
  const t = snap.totals || {};
  return {
    store: snap.store, store_name: snap.store_name, ym: snap.ym, closed_at: rep.closed_at,
    revenue: ['glasses_sales', 'contact_sales', 'glasses_receipt', 'contact_receipt', 'api_pay'].map(pick).filter(Boolean),
    totals: {
      sales_total: t.sales_total, receipt_total: t.receipt_total, total_in: t.total_in, total_out: t.total_out,
      glasses_out: t.glasses_out, contact_out: t.contact_out, glasses_profit: t.glasses_profit, contact_profit: t.contact_profit, profit: t.profit,
      ratio: t.ratio, ratio_target: snap.ratio_target,
    },
    gap: snap.gap || null,
    left: rows(snap.left), right: rows(snap.right),
    dividend: snap.dividend ? { marketing_fund: r0(snap.dividend.marketing_fund), depreciation: r0(snap.dividend.depreciation), retained: r0(snap.dividend.retained), distributable: r0(snap.dividend.distributable) } : null,
    manager_note: rep.manager_note || null, manager_note_at: rep.manager_note_at || null,
    reviewer_note: rep.reviewer_note || null,
  };
}

router.get('/months', async (req, res) => {
  const store = String(req.query.store || '');
  if (!store) return bad(res, '缺門市');
  const { data, error } = await supabase.from('store_month_reports').select('ym, closed_at, manager_note_at').eq('store_erpid', store).eq('status', 'closed').order('ym', { ascending: false }).limit(24);
  if (error) return bad(res, error.message, 500);
  res.json({ success: true, data: data || [] });
});

router.get('/', async (req, res) => {
  const store = String(req.query.store || ''), ym = String(req.query.ym || '');
  if (!store || !YM.test(ym)) return bad(res, '缺門市／月份');
  const { data: rep, error } = await supabase.from('store_month_reports').select('*').eq('store_erpid', store).eq('ym', ym).maybeSingle();
  if (error) return bad(res, error.message, 500);
  if (!rep || rep.status !== 'closed' || !rep.snapshot) return res.json({ success: true, data: { closed: false, status: rep ? rep.status : 'draft' } });
  res.json({ success: true, data: { closed: true, ...managerView(rep.snapshot, rep) } });
});

router.post('/note', async (req, res) => {
  const b = req.body || {};
  const store = String(b.store || ''), ym = String(b.ym || '');
  if (!store || !YM.test(ym)) return bad(res, '缺門市／月份');
  const note = String(b.note || '').trim();
  if (note.length > 3000) return bad(res, '心得最多 3000 字');
  const { data: rep } = await supabase.from('store_month_reports').select('status').eq('store_erpid', store).eq('ym', ym).maybeSingle();
  if (!rep || rep.status !== 'closed') return bad(res, '這個月還沒關帳，關帳後才能寫心得', 409);
  const { error } = await supabase.from('store_month_reports').update({ manager_note: note || null, manager_note_at: new Date().toISOString(), manager_note_by: b.by ? String(b.by).slice(0, 60) : null })
    .eq('store_erpid', store).eq('ym', ym);
  if (error) return bad(res, error.message, 500);
  res.json({ success: true });
});

module.exports = router;
