// routes/processing.js — 加工中心開帳（2026-10-20）
// 入口：/processing/login（獨立帳密 proc_accounts，例：加工中心黃博新）；營運部 super_admin／operation_* 帳號也能進
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const supabase = require('../config/supabase');
const PC = require('../services/processingCenter');

const router = express.Router();
const SECRET = process.env.PROC_JWT_SECRET || process.env.VENDOR_JWT_SECRET || process.env.JWT_SECRET || 'proc-secret-change-me';
const fail = (res, e) => { console.error('[processing]', e.message); res.status(e.status || 500).json({ success: false, message: e.message }); };
const bad = (res, msg, code = 400) => res.status(code).json({ success: false, message: msg });
const YM = PC.YM;
const curYm = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 7);

// 帳號：加工中心獨立帳號（JWT type proc）或營運部系統帳號（super_admin／operation_*）
async function auth(req, res, next) {
  try {
    const h = req.headers.authorization || '';
    if (!h.startsWith('Bearer ')) return bad(res, '請先登入', 401);
    const tok = h.slice(7);
    if (tok.split('.').length === 3) {
      let p; try { p = jwt.verify(tok, SECRET); } catch { return bad(res, '登入已過期，請重新登入', 401); }
      if (p.type !== 'proc') return bad(res, '不是加工中心帳號', 403);
      const { data: a } = await supabase.from('proc_accounts').select('id, username, display_name, is_active').eq('id', p.accountId).maybeSingle();
      if (!a || !a.is_active) return bad(res, '帳號不存在或已停用', 403);
      req.actor = { kind: 'proc', name: a.display_name || a.username, id: a.id };
      return next();
    }
    const { data: u } = await supabase.from('system_users').select('id, member_id, name, role, is_active').eq('member_id', tok).eq('is_active', true).maybeSingle();
    if (!u) return bad(res, '無此系統帳號', 403);
    if (!(u.role === 'super_admin' || String(u.role || '').startsWith('operation'))) return bad(res, '沒有加工中心開帳權限', 403);
    if (require('../services/resignClient').isBlocked(u.member_id)) return bad(res, '帳號已辦理離職', 403);
    req.actor = { kind: 'system', name: u.name || u.member_id, id: u.id, role: u.role };
    next();
  } catch (e) { fail(res, e); }
}
const boss = (req, res, next) => (req.actor && req.actor.kind === 'system' && req.actor.role === 'super_admin' ? next() : bad(res, '只有營運部 super_admin 可以管理帳號', 403));

router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) return bad(res, '請輸入帳號與密碼');
    const { data: a } = await supabase.from('proc_accounts').select('*').eq('username', String(username).trim()).maybeSingle();
    if (!a || !a.is_active || !(await bcrypt.compare(String(password), a.password_hash))) return bad(res, '帳號或密碼錯誤', 401);
    await supabase.from('proc_accounts').update({ last_login_at: new Date().toISOString() }).eq('id', a.id);
    const token = jwt.sign({ type: 'proc', accountId: a.id }, SECRET, { expiresIn: '12h' });
    res.json({ success: true, token, account: { username: a.username, display_name: a.display_name } });
  } catch (e) { fail(res, e); }
});

router.use(auth);
router.get('/me', (req, res) => res.json({ success: true, data: req.actor }));

// 帳號管理（營運部 super_admin）
router.get('/accounts', boss, async (req, res) => {
  const { data, error } = await supabase.from('proc_accounts').select('id, username, display_name, is_active, last_login_at, created_at').order('created_at');
  if (error) return fail(res, error);
  res.json({ success: true, data });
});
router.post('/accounts', boss, async (req, res) => {
  try {
    const { username, password, display_name } = req.body || {};
    if (!username || !password || String(password).length < 8) return bad(res, '帳號必填、密碼至少 8 碼');
    const hash = await bcrypt.hash(String(password), 10);
    const { data: ex } = await supabase.from('proc_accounts').select('id').eq('username', String(username).trim()).maybeSingle();
    const row = { username: String(username).trim(), password_hash: hash, display_name: display_name || null, is_active: true };
    const q = ex ? supabase.from('proc_accounts').update(row).eq('id', ex.id) : supabase.from('proc_accounts').insert({ ...row, created_by: req.actor.name });
    const { error } = await q;
    if (error) throw error;
    res.json({ success: true, data: { username: row.username, reset: !!ex } });
  } catch (e) { fail(res, e); }
});
router.patch('/accounts/:id', boss, async (req, res) => {
  const { error } = await supabase.from('proc_accounts').update({ is_active: !!req.body.is_active }).eq('id', req.params.id);
  if (error) return fail(res, error);
  res.json({ success: true });
});

// ── 主檔金額 ──
router.get('/products', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    if (!q) return res.json({ success: true, data: [] });
    const [f, pt] = await Promise.all([PC.feedGet('billingFeed/products', { q, limit: 60 }), PC.priceTable()]);
    const ym = curYm();
    res.json({ success: true, data: (f.items || []).filter((p) => !PC.isFrame(p)).map((p) => ({ ...p, price: pt.of(p.bind_id, ym) })) });
  } catch (e) { fail(res, e); }
});
router.get('/prices', async (req, res) => {
  const { data, error } = await supabase.from('proc_price_items').select('*').eq('is_active', true).order('name').order('effective_from', { ascending: false });
  if (error) return fail(res, error);
  res.json({ success: true, data });
});
// 存一筆主檔金額（同商品同生效月份＝更新）
async function savePrice(b, actor) {
  const bind = String(b.bind_id || '').trim();
  const amount = Number(b.amount);
  const eff = String(b.effective_from || curYm());
  if (!/^\d+$/.test(bind)) { const e = new Error('要選商品（bind_id）'); e.status = 400; throw e; }
  if (b.amount === '' || b.amount == null || !Number.isFinite(amount)) { const e = new Error(`金額不對（${b.name || bind}）`); e.status = 400; throw e; }
  if (!YM.test(eff)) { const e = new Error('生效月份要 YYYY-MM'); e.status = 400; throw e; }
  const row = { bind_id: Number(bind), name: b.name || null, brand: b.brand || null, catena: b.catena || null, model: b.model || null, amount, effective_from: eff, note: b.note || null };
  const { data: ex } = await supabase.from('proc_price_items').select('*').eq('bind_id', Number(bind)).eq('effective_from', eff).eq('is_active', true).maybeSingle();
  let saved;
  if (ex) {
    const { data, error } = await supabase.from('proc_price_items').update({ ...row, updated_by: actor.name, updated_at: new Date().toISOString() }).eq('id', ex.id).select('*').single();
    if (error) throw error; saved = data;
  } else {
    const { data, error } = await supabase.from('proc_price_items').insert({ ...row, created_by: actor.name }).select('*').single();
    if (error) throw error; saved = data;
  }
  await supabase.from('proc_price_log').insert({ price_id: saved.id, bind_id: saved.bind_id, action: ex ? 'update' : 'create', before: ex || null, after: saved, by_name: actor.name });
  return saved;
}
router.post('/prices', async (req, res) => {
  try { res.json({ success: true, data: await savePrice(req.body || {}, req.actor) }); } catch (e) { fail(res, e); }
});
// 一次存多筆：開帳畫面「這個月收到、還沒設金額的品項」填完一起送（生效月份＝那個月）
router.post('/prices/batch', async (req, res) => {
  try {
    const list = Array.isArray(req.body && req.body.items) ? req.body.items : [];
    if (!list.length) return bad(res, '沒有要存的品項');
    if (list.length > 500) return bad(res, '一次最多 500 筆');
    for (const b of list) {   // 先全部檢查，避免存一半
      const a = Number(b.amount);
      if (!/^\d+$/.test(String(b.bind_id || '')) || b.amount === '' || b.amount == null || !Number.isFinite(a)) return bad(res, `金額不對（${b.name || b.bind_id}）`);
    }
    const saved = [];
    for (const b of list) saved.push(await savePrice(b, req.actor));
    res.json({ success: true, data: { saved: saved.length } });
  } catch (e) { fail(res, e); }
});
router.delete('/prices/:id', async (req, res) => {
  try {
    const { data: ex } = await supabase.from('proc_price_items').select('*').eq('id', req.params.id).maybeSingle();
    if (!ex) return bad(res, '找不到', 404);
    await supabase.from('proc_price_items').update({ is_active: false, updated_by: req.actor.name, updated_at: new Date().toISOString() }).eq('id', ex.id);
    await supabase.from('proc_price_log').insert({ price_id: ex.id, bind_id: ex.bind_id, action: 'delete', before: ex, by_name: req.actor.name });
    res.json({ success: true });
  } catch (e) { fail(res, e); }
});

// ── 月份開帳 ──
router.get('/months/:ym', async (req, res) => {
  try { if (!YM.test(req.params.ym)) return bad(res, '月份要 YYYY-MM'); res.json({ success: true, data: await PC.summary(req.params.ym, { fresh: req.query.fresh === '1' }) }); }
  catch (e) { fail(res, e); }
});
router.get('/months/:ym/stores/:store', async (req, res) => {
  try { if (!YM.test(req.params.ym)) return bad(res, '月份要 YYYY-MM'); res.json({ success: true, data: await PC.storeDetail(req.params.ym, req.params.store, { fresh: req.query.fresh === '1' }) }); }
  catch (e) { fail(res, e); }
});
router.post('/months/:ym/stores/:store/open', async (req, res) => {
  try { res.json({ success: true, data: await PC.open(req.params.ym, req.params.store, req.actor.name) }); }
  catch (e) { fail(res, e); }
});
router.post('/months/:ym/stores/:store/reopen', async (req, res) => {
  try { res.json({ success: true, data: await PC.reopen(req.params.ym, req.params.store, req.actor.name, (req.body || {}).reason) }); }
  catch (e) { fail(res, e); }
});

// ── 追加金額（開帳前才能改；開帳後要先重新開帳，或記在下個月）──
async function openedRow(ym, store) {
  const { data } = await supabase.from('proc_month_store').select('id').eq('ym', ym).eq('store_erpid', String(store)).is('voided_at', null).maybeSingle();
  return data;
}
router.post('/extra', async (req, res) => {
  try {
    const b = req.body || {};
    const amount = Number(b.amount);
    if (!YM.test(String(b.ym || '')) || !b.store_erpid) return bad(res, '缺月份或門市');
    if (!Number.isFinite(amount) || amount === 0) return bad(res, '金額不能是 0（減少請填負數）');
    if (!String(b.reason || '').trim()) return bad(res, '追加金額一定要寫原因');
    if (await openedRow(b.ym, b.store_erpid)) return bad(res, '這家店這個月已開帳；要改請先重新開帳，或記在下個月', 409);
    const { data, error } = await supabase.from('proc_order_extra').insert({ ym: b.ym, store_erpid: String(b.store_erpid), order_number: b.order_number ? String(b.order_number) : null,
      amount, reason: String(b.reason).trim(), created_by: req.actor.name }).select('*').single();
    if (error) throw error;
    res.json({ success: true, data });
  } catch (e) { fail(res, e); }
});
router.delete('/extra/:id', async (req, res) => {
  try {
    const { data: ex } = await supabase.from('proc_order_extra').select('*').eq('id', req.params.id).is('voided_at', null).maybeSingle();
    if (!ex) return bad(res, '找不到', 404);
    if (await openedRow(ex.ym, ex.store_erpid)) return bad(res, '這家店這個月已開帳；要改請先重新開帳', 409);
    await supabase.from('proc_order_extra').update({ voided_at: new Date().toISOString(), voided_by: req.actor.name }).eq('id', ex.id);
    res.json({ success: true });
  } catch (e) { fail(res, e); }
});

module.exports = router;
