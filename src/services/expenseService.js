// services/expenseService.js —— 門市費用申請（2026-11-15 Louis：第一個＝差旅費 交通費／油資）
// 申請、審核在市場部諮詢頻道；這裡負責：
//   post()    審核通過 → 寫月報（ledger_manual_entries entry_type='expense'，科目「差旅費」，已關帳月份自動順延）
//             ＋ 人資系統（lohas-payroll）申請人「列帳月份二次薪」加項（同一張申請再送＝改金額，不重複）
//   unpost()  撤回（作廢月報列＋刪薪資加項；已關帳／薪資已鎖定就不行）
//   voucher() 報帳憑證：有發票／收據→黏存單（paste）；沒有→支出證明單（proof）；單據照片複製一份到 ledger-vouchers bucket
// 人資系統：PAYROLL_API_URL（預設 https://lohas-payroll.onrender.com/api）＋ PAYROLL_SYNC_KEY（header x-payroll-key）
const supabase = require('../config/supabase');
const LP = require('./ledgerPost');
const LS = require('./ledgerSubjects');

const YM = /^\d{4}-(0[1-9]|1[0-2])$/;
const BUCKET = 'ledger-vouchers';
const SUBJECT = '差旅費';
const PAYROLL = () => (process.env.PAYROLL_API_URL || 'https://lohas-payroll.onrender.com/api').replace(/\/+$/, '');

async function payroll(method, path, body) {
  const key = process.env.PAYROLL_SYNC_KEY || '';
  if (!key) throw new Error('營運系統沒設 PAYROLL_SYNC_KEY');
  const r = await fetch(`${PAYROLL()}/op-feed${path}`, { method, headers: { 'Content-Type': 'application/json', 'x-payroll-key': key }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.success === false) throw new Error(j.message || `人資系統 ${r.status}`);
  return j.data;
}

async function subject() {
  const s = (await LS.all(true)).find((x) => x.name === SUBJECT && x.is_active);
  if (!s) throw new Error('找不到會計科目「差旅費」（會計科目管理要有一個啟用中的「差旅費」）');
  return s;
}

async function stores() {
  const { data } = await supabase.from('departments').select('store_erpid, store_name, report_kind').eq('is_active', true).order('store_name');
  return (data || []).map((d) => ({ erpid: String(d.store_erpid), name: d.store_name, kind: d.report_kind || null }));
}

async function meta() {
  const [st, s] = await Promise.all([stores(), subject().catch(() => null)]);
  let units = [];
  try { units = await payroll('GET', '/insure-units'); } catch (e) { console.warn('[expense] insure-units', e.message); }
  return { stores: st, subject: s ? { id: s.id, name: s.name, ledger_code: s.ledger_code } : null, insure_units: units };
}

async function employee(q) {
  const qs = new URLSearchParams();
  if (q.erpid) qs.set('erpid', String(q.erpid));
  else if (q.app_number) qs.set('app_number', String(q.app_number));
  else return null;
  try { return await payroll('GET', `/employee?${qs}`); } catch (e) { return { error: e.message }; }
}

/** 審核通過入帳。b：{ ref, store_erpid, ym, amount, applicant:{erpid,app_number,name}, label, purpose, by, pay:true } */
async function post(b) {
  const ref = String(b.ref || '').slice(0, 120);
  if (!/^market-expense:\d+$/.test(ref)) throw new Error('ref 不對');
  if (!YM.test(String(b.ym || ''))) throw new Error('請選列帳月份');
  const amount = Math.round(Number(b.amount));
  if (!(amount > 0)) throw new Error('金額要大於 0');
  const st = (await stores()).find((s) => s.erpid === String(b.store_erpid || ''));
  if (!st) throw new Error('開帳單位不對');
  const s = await subject();
  const a = b.applicant || {};
  const label = String(b.label || '差旅費').slice(0, 20);
  const reason = `${SUBJECT}｜${label}｜${a.name || ''}｜${String(b.purpose || '').replace(/\s+/g, ' ')}`.slice(0, 300);

  // 同一張申請：作廢舊的再寫新的（金額／門市／月份都可能改）；舊的在已關帳月份 → 不能動
  const { data: old } = await supabase.from('ledger_manual_entries').select('id, store_erpid, report_ym').eq('expense_ref', ref).is('void_at', null);
  for (const o of old || []) if (await LP.isClosed(o.store_erpid, o.report_ym)) throw new Error(`這張已經列在 ${o.report_ym} 月報且已關帳，不能再改；請用月報調帳`);
  const ym = await LP.openYm(st.erpid, b.ym);
  const shifted = ym !== b.ym ? `${st.name} ${b.ym} 已關帳 → 改列 ${ym}` : null;
  const now = new Date().toISOString();
  if (old && old.length) await supabase.from('ledger_manual_entries').update({ void_at: now, void_by: b.by || 'market' }).in('id', old.map((o) => o.id));
  const { data: e, error } = await supabase.from('ledger_manual_entries').insert({
    entry_type: 'expense', store_erpid: st.erpid, report_ym: ym, fee_ym: b.fee_ym && YM.test(b.fee_ym) ? b.fee_ym : ym,
    ledger_code: s.ledger_code, subject_id: s.id, amount, vendor: a.name || null, reason,
    files: [], created_by: String(b.by || 'market').slice(0, 60), expense_ref: ref,
  }).select('id, report_ym').single();
  if (error) throw new Error('列入月報失敗：' + error.message);
  try { require('./monthlyReport').clearBookCache && require('./monthlyReport').clearBookCache(); } catch { /* ignore */ }

  let pay = null;
  if (b.pay !== false) {
    try {
      const r = await payroll('POST', '/pay-adjustments', { ym: b.ym, erpid: a.erpid || undefined, app_number: a.erpid ? undefined : a.app_number, run_kind: 'second', code: 'travel', name: `${SUBJECT}（${label}）`, amount, note: String(b.purpose || '').slice(0, 200), source: ref, by: b.by || 'market' });
      pay = { ok: true, id: r.id, ym: r.ym, updated: !!r.updated };
    } catch (err) { pay = { ok: false, error: err.message }; }
  }
  return { entry_id: e.id, report_ym: e.report_ym, store_name: st.name, subject: s.name, ledger_code: s.ledger_code, shifted, payroll: pay };
}

async function unpost(ref, by) {
  const { data: old } = await supabase.from('ledger_manual_entries').select('id, store_erpid, report_ym').eq('expense_ref', ref).is('void_at', null);
  for (const o of old || []) if (await LP.isClosed(o.store_erpid, o.report_ym)) throw new Error(`已列入 ${o.report_ym} 月報且已關帳，不能撤回`);
  let pay = null;
  try { pay = await payroll('DELETE', `/pay-adjustments?source=${encodeURIComponent(ref)}`); } catch (e) { throw new Error('薪資加項撤不掉：' + e.message); }
  if (old && old.length) await supabase.from('ledger_manual_entries').update({ void_at: new Date().toISOString(), void_by: by || 'market' }).in('id', old.map((o) => o.id));
  try { require('./monthlyReport').clearBookCache && require('./monthlyReport').clearBookCache(); } catch { /* ignore */ }
  return { voided: (old || []).length, payroll: pay };
}

// ── 金額大寫（國字）──
const D = '零壹貳參肆伍陸柒捌玖';
function words(n) {
  n = Math.round(Number(n) || 0);
  if (n <= 0) return '零元整';
  const unit = ['', '拾', '佰', '仟'];
  const big = ['', '萬', '億'];
  let out = '', g = 0, zero = false;
  while (n > 0) {
    const part = n % 10000; n = Math.floor(n / 10000);
    let s = '', z = false;
    for (let i = 0, p = part; i < 4; i++, p = Math.floor(p / 10)) {
      const d = p % 10;
      if (d === 0) { if (s) z = true; continue; }
      s = D[d] + unit[i] + (z ? '零' : '') + s; z = false;
    }
    if (s) { out = s + big[g] + (zero ? '零' : '') + out; zero = part < 1000 && n > 0; }
    else if (out) zero = true;
    g++;
  }
  return '新臺幣' + out + '元整';
}

async function nextNo(ym) {
  const prefix = `EV${String(ym || new Date().toISOString().slice(0, 7)).replace('-', '')}-`;
  const { data } = await supabase.from('expense_vouchers').select('voucher_no').like('voucher_no', `${prefix}%`).order('voucher_no', { ascending: false }).limit(1);
  const n = data && data[0] ? Number(String(data[0].voucher_no).slice(prefix.length)) + 1 : 1;
  return prefix + String(n).padStart(4, '0');
}

const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf' };
async function copyFile(url, dir, i) {
  if (!/^https:\/\//.test(String(url || ''))) return null;
  const r = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(`下載單據失敗 ${r.status}`);
  const type = (r.headers.get('content-type') || 'image/jpeg').split(';')[0];
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > 20 * 1024 * 1024) throw new Error('單據檔案太大');
  const path = `expense/${dir}/${i + 1}.${EXT[type] || 'jpg'}`;
  const { error } = await supabase.storage.from(BUCKET).upload(path, buf, { contentType: type, upsert: true });
  if (error) throw new Error('單據存檔失敗：' + error.message);
  return path;
}

/** 開報帳憑證。b：{ ref, kind?, company, applicant, store_erpid, report_ym, voucher_date, purpose, amount, items, files:[{url,amount,name}], no_receipt_reason, note, by } */
async function voucher(b) {
  const amount = Math.round(Number(b.amount));
  if (!(amount > 0)) throw new Error('金額要大於 0');
  const purpose = String(b.purpose || '').trim();
  if (!purpose) throw new Error('請填事由');
  const files = (Array.isArray(b.files) ? b.files : []).slice(0, 20);
  const kind = b.kind === 'paste' || b.kind === 'proof' ? b.kind : files.length ? 'paste' : 'proof';
  if (kind === 'proof' && !String(b.no_receipt_reason || '').trim()) throw new Error('支出證明單要寫「不能取得單據的原因」');
  const st = b.store_erpid ? (await stores()).find((s) => s.erpid === String(b.store_erpid)) : null;
  const s = await subject().catch(() => null);
  let entry = null;
  if (b.ref) { const { data } = await supabase.from('ledger_manual_entries').select('id, report_ym').eq('expense_ref', String(b.ref)).is('void_at', null).limit(1); entry = data && data[0]; }
  const reportYm = (entry && entry.report_ym) || (YM.test(String(b.report_ym || '')) ? b.report_ym : null);
  const a = b.applicant || {};
  const dir = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const kept = [];
  for (let i = 0; i < files.length; i++) {
    const f = files[i] || {};
    const path = await copyFile(f.url, dir, i);
    if (path) kept.push({ path, name: String(f.name || `單據 ${i + 1}`).slice(0, 60), amount: f.amount != null ? Math.round(Number(f.amount)) || 0 : null });
  }
  let no = await nextNo(reportYm);
  const row = {
    kind, source_ref: b.ref ? String(b.ref).slice(0, 120) : null, ledger_entry_id: entry ? entry.id : null,
    company: String(b.company || '').trim().slice(0, 80) || null,
    applicant_name: a.name || null, applicant_erpid: a.erpid || null, applicant_app: a.app_number || null,
    store_erpid: st ? st.erpid : null, store_name: st ? st.name : (b.store_name || null), report_ym: reportYm,
    voucher_date: /^\d{4}-\d{2}-\d{2}$/.test(String(b.voucher_date || '')) ? b.voucher_date : undefined,
    subject_name: (s && s.name) || SUBJECT, ledger_code: s ? s.ledger_code : null,
    purpose: purpose.slice(0, 500), amount, amount_words: words(amount),
    items: Array.isArray(b.items) ? b.items.slice(0, 40) : [], files: kept, attach_count: kept.length,
    no_receipt_reason: kind === 'proof' ? String(b.no_receipt_reason).trim().slice(0, 200) : null,
    note: b.note ? String(b.note).slice(0, 300) : null, created_by: String(b.by || 'market').slice(0, 60),
  };
  for (let k = 0; k < 3; k++) {
    const { data, error } = await supabase.from('expense_vouchers').insert({ ...row, voucher_no: no }).select('*').single();
    if (!error) return data;
    if (!/duplicate|unique/i.test(error.message)) throw new Error(error.message);
    no = await nextNo(reportYm);
  }
  throw new Error('憑證編號衝突，請再試一次');
}

async function signFiles(v) {
  const ps = (v.files || []).map((f) => f.path).filter(Boolean);
  if (!ps.length) return v;
  const { data } = await supabase.storage.from(BUCKET).createSignedUrls(ps, 3600);
  const m = new Map((data || []).map((x) => [x.path, x.signedUrl]));
  return { ...v, files: v.files.map((f) => ({ ...f, url: m.get(f.path) || null })) };
}
async function getVoucher(id) {
  const { data } = await supabase.from('expense_vouchers').select('*').eq('id', id).maybeSingle();
  return data ? signFiles(data) : null;
}
async function listVouchers(q = {}) {
  let s = supabase.from('expense_vouchers').select('id, voucher_no, kind, company, applicant_name, store_name, report_ym, voucher_date, subject_name, purpose, amount, attach_count, status, created_at, source_ref').order('created_at', { ascending: false }).limit(500);
  if (q.ym && YM.test(q.ym)) s = s.eq('report_ym', q.ym);
  if (q.kind === 'paste' || q.kind === 'proof') s = s.eq('kind', q.kind);
  if (q.status === 'issued' || q.status === 'void') s = s.eq('status', q.status);
  if (q.q) { const kw = String(q.q).replace(/[,%()]/g, '').slice(0, 30); if (kw) s = s.or(`voucher_no.ilike.%${kw}%,applicant_name.ilike.%${kw}%,purpose.ilike.%${kw}%,store_name.ilike.%${kw}%,company.ilike.%${kw}%`); }
  const { data, error } = await s;
  if (error) throw new Error(error.message);
  return data || [];
}
async function voidVoucher(id, by) {
  const { data, error } = await supabase.from('expense_vouchers').update({ status: 'void', void_at: new Date().toISOString(), void_by: by || null }).eq('id', id).eq('status', 'issued').select('id').maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error('找不到或已作廢');
  return true;
}

module.exports = { meta, employee, post, unpost, voucher, getVoucher, listVouchers, voidVoucher, words };
