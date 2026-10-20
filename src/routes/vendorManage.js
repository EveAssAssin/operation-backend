// routes/vendorManage.js —— 營運管理 → 廠商管理（2026-10-20）掛 /api/vendor-manage
// 一個畫面做完：新建廠商（billing_sources vendor）＋廠商入口帳號密碼（vendor_accounts）＋出款資訊（vendor_bank_accounts 預設）。
// 出款資訊設好後，廠商出款匯出元大檔會自動用這個帳號（vendorPayoutService.payeeMap：請款指定 → 外部快照 → 廠商預設）。
const express = require('express');
const bcrypt = require('bcryptjs');
const router = express.Router();
const supabase = require('../config/supabase');
const { authorize } = require('../middleware/auth');

const ok = (res, data) => res.json({ success: true, data });
const bad = (res, e) => res.status(400).json({ success: false, message: e.message || String(e) });
const now = () => new Date().toISOString();
const digits = (s) => String(s == null ? '' : s).replace(/\D/g, '');

function checkBank(b) {
  const bank = { bank_code: digits(b.bank_code), branch_code: digits(b.branch_code), account_no: digits(b.account_no), account_name: String(b.account_name || '').trim(), note: String(b.note || '').trim() || null };
  if (!/^\d{3}$/.test(bank.bank_code)) throw new Error('銀行代碼要 3 碼（例：元大 806、台新 812）');
  if (bank.branch_code && !/^\d{4}$/.test(bank.branch_code)) throw new Error('分行代碼要 4 碼');
  if (bank.account_no.length < 8) throw new Error('帳號至少 8 碼數字');
  if (!bank.account_name) throw new Error('請填戶名（要跟存摺一樣）');
  return bank;
}
async function checkAccount(username, password, exceptId) {
  const u = String(username || '').trim();
  if (!/^[A-Za-z0-9_.@-]{4,40}$/.test(u)) throw new Error('帳號 4～40 碼英數字（可用 _ . @ -）');
  if (password !== undefined && String(password).length < 6) throw new Error('密碼至少 6 個字元');
  let q = supabase.from('vendor_accounts').select('id').eq('username', u);
  const { data } = await q.maybeSingle();
  if (data && data.id !== exceptId) throw new Error('這個帳號已經有人用了');
  return u;
}

router.use(authorize('operation_accounting', 'operation_lead', 'super_admin', 'dept_head', 'operation_staff'));

// ── 清單：每家廠商＋登入帳號＋預設出款帳號 ──
router.get('/', async (req, res) => {
  try {
    const [{ data: src, error }, { data: acc }, { data: banks }] = await Promise.all([
      supabase.from('billing_sources').select('id, name, code, tax_id, contact_name, contact_phone, contact_email, notes, is_active, created_at').eq('source_type', 'vendor').order('is_active', { ascending: false }).order('name'),
      supabase.from('vendor_accounts').select('id, source_id, username, is_active, last_login_at'),
      supabase.from('vendor_bank_accounts').select('*').order('is_default', { ascending: false }).order('created_at'),
    ]);
    if (error) throw error;
    ok(res, (src || []).map((s) => ({
      ...s,
      accounts: (acc || []).filter((a) => a.source_id === s.id),
      banks: (banks || []).filter((b) => b.source_id === s.id),
    })));
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ── 新建（一次建好：廠商＋帳號＋出款資訊）──
router.post('/', authorize('operation_accounting', 'operation_lead', 'super_admin', 'dept_head'), async (req, res) => {
  const b = req.body || {};
  let sourceId = null;
  try {
    const name = String(b.name || '').trim();
    if (!name) throw new Error('請填廠商名稱');
    const tax = digits(b.tax_id);
    if (tax && tax.length !== 8) throw new Error('統一編號要 8 碼');
    const wantAccount = !!(b.username || b.password);
    const username = wantAccount ? await checkAccount(b.username, b.password || '') : null;
    const bank = b.bank && (b.bank.account_no || b.bank.bank_code) ? checkBank(b.bank) : null;
    const { data: dup } = await supabase.from('billing_sources').select('id').eq('source_type', 'vendor').eq('name', name).maybeSingle();
    if (dup) throw new Error('已經有同名的廠商');
    const { data: s, error } = await supabase.from('billing_sources').insert({
      source_type: 'vendor', name, tax_id: tax || null, code: String(b.code || '').trim() || null,
      contact_name: String(b.contact_name || '').trim() || null, contact_phone: String(b.contact_phone || '').trim() || null, contact_email: String(b.contact_email || '').trim() || null,
      notes: String(b.notes || '').trim() || null, is_active: true, created_at: now(), updated_at: now(),
    }).select('*').single();
    if (error) throw new Error(/code_key/.test(error.message) ? '識別碼已被使用' : error.message);
    sourceId = s.id;
    if (username) {
      const { error: e2 } = await supabase.from('vendor_accounts').insert({ source_id: s.id, username, password_hash: await bcrypt.hash(String(b.password), 10), is_active: true, created_at: now(), updated_at: now() });
      if (e2) throw new Error('建立帳號失敗：' + e2.message);
    }
    if (bank) {
      const { error: e3 } = await supabase.from('vendor_bank_accounts').insert({ source_id: s.id, ...bank, is_default: true });
      if (e3) throw new Error('建立出款資訊失敗：' + e3.message);
    }
    ok(res, s);
  } catch (e) {
    if (sourceId) {   // 後面失敗：把剛建的廠商收掉，避免留半套
      await supabase.from('vendor_accounts').delete().eq('source_id', sourceId);
      await supabase.from('vendor_bank_accounts').delete().eq('source_id', sourceId);
      await supabase.from('billing_sources').delete().eq('id', sourceId);
    }
    bad(res, e);
  }
});

// ── 修改基本資料 ──
router.patch('/:id', authorize('operation_accounting', 'operation_lead', 'super_admin', 'dept_head'), async (req, res) => {
  try {
    const b = req.body || {};
    const patch = { updated_at: now() };
    for (const k of ['name', 'code', 'contact_name', 'contact_phone', 'contact_email', 'notes']) if (b[k] !== undefined) patch[k] = String(b[k] || '').trim() || null;
    if (b.tax_id !== undefined) { const t = digits(b.tax_id); if (t && t.length !== 8) throw new Error('統一編號要 8 碼'); patch.tax_id = t || null; }
    if (b.is_active !== undefined) patch.is_active = !!b.is_active;
    if (patch.name === null) throw new Error('廠商名稱不能空白');
    const { data, error } = await supabase.from('billing_sources').update(patch).eq('id', req.params.id).eq('source_type', 'vendor').select('*').single();
    if (error) throw error;
    ok(res, data);
  } catch (e) { bad(res, e); }
});

// ── 登入帳號：新增／改密碼／停用 ──
router.put('/:id/account', authorize('operation_accounting', 'operation_lead', 'super_admin', 'dept_head'), async (req, res) => {
  try {
    const b = req.body || {};
    const { data: cur } = await supabase.from('vendor_accounts').select('*').eq('source_id', req.params.id).order('created_at').limit(1).maybeSingle();
    if (!cur) {
      const username = await checkAccount(b.username, b.password || '');
      const { error } = await supabase.from('vendor_accounts').insert({ source_id: req.params.id, username, password_hash: await bcrypt.hash(String(b.password), 10), is_active: true, created_at: now(), updated_at: now() });
      if (error) throw error;
    } else {
      const patch = { updated_at: now() };
      if (b.username && b.username !== cur.username) patch.username = await checkAccount(b.username, undefined, cur.id);
      if (b.password) { if (String(b.password).length < 6) throw new Error('密碼至少 6 個字元'); patch.password_hash = await bcrypt.hash(String(b.password), 10); }
      if (b.is_active !== undefined) patch.is_active = !!b.is_active;
      const { error } = await supabase.from('vendor_accounts').update(patch).eq('id', cur.id);
      if (error) throw error;
    }
    ok(res, { ok: true });
  } catch (e) { bad(res, e); }
});

// ── 出款資訊（收款銀行帳號）──
router.post('/:id/banks', authorize('operation_accounting', 'operation_lead', 'super_admin', 'dept_head'), async (req, res) => {
  try {
    const bank = checkBank(req.body || {});
    const { count } = await supabase.from('vendor_bank_accounts').select('id', { count: 'exact', head: true }).eq('source_id', req.params.id);
    const isDefault = !!(req.body || {}).is_default || !count;
    if (isDefault) await supabase.from('vendor_bank_accounts').update({ is_default: false }).eq('source_id', req.params.id);
    const { data, error } = await supabase.from('vendor_bank_accounts').insert({ source_id: req.params.id, ...bank, is_default: isDefault }).select('*').single();
    if (error) throw error;
    ok(res, data);
  } catch (e) { bad(res, e); }
});
router.patch('/:id/banks/:bankId', authorize('operation_accounting', 'operation_lead', 'super_admin', 'dept_head'), async (req, res) => {
  try {
    const b = req.body || {};
    const patch = {};
    if (b.account_no !== undefined || b.bank_code !== undefined) Object.assign(patch, checkBank(b));
    if (b.is_default) { await supabase.from('vendor_bank_accounts').update({ is_default: false }).eq('source_id', req.params.id); patch.is_default = true; }
    const { data, error } = await supabase.from('vendor_bank_accounts').update(patch).eq('id', req.params.bankId).eq('source_id', req.params.id).select('*').single();
    if (error) throw error;
    ok(res, data);
  } catch (e) { bad(res, e); }
});
router.delete('/:id/banks/:bankId', authorize('operation_accounting', 'operation_lead', 'super_admin', 'dept_head'), async (req, res) => {
  try {
    const { error } = await supabase.from('vendor_bank_accounts').delete().eq('id', req.params.bankId).eq('source_id', req.params.id);
    if (error) throw error;
    ok(res, { ok: true });
  } catch (e) { bad(res, e); }
});

module.exports = router;
