// services/bankCredService.js —— 網銀帳密（2026-11 銀存彙整）
//   帳密用 AES-256-GCM 加密存在 bank_accounts.cred_enc；金鑰 BANK_CRED_KEY（Render 環境變數，64 碼 hex）
//   清單只回欄位名稱（cred_labels），看值要輸入「查看密碼」（全系統一組，bcrypt 存在 report_settings.bank_cred_pin）
//   連錯 5 次鎖 10 分鐘；每次查看／修改都記在 bank_cred_logs
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const supabase = require('../config/supabase');

function key() {
  const k = process.env.BANK_CRED_KEY;
  if (k && /^[0-9a-f]{64}$/i.test(k)) return Buffer.from(k, 'hex');
  // 沒設環境變數時的備援（請盡快在 Render 設 BANK_CRED_KEY；設了之後舊資料要重存）
  return crypto.createHash('sha256').update(String(process.env.SUPABASE_SERVICE_ROLE_KEY || '') + '|bank-cred').digest();
}
function encrypt(obj) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), enc.toString('base64')].join('.');
}
function decrypt(s) {
  if (!s) return [];
  const [v, iv, tag, data] = String(s).split('.');
  if (v !== 'v1') throw new Error('帳密格式不對');
  const d = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return JSON.parse(Buffer.concat([d.update(Buffer.from(data, 'base64')), d.final()]).toString('utf8'));
}

// ── 查看密碼 ──
const fails = new Map();   // user → { n, until }
async function pinRow() {
  const { data } = await supabase.from('report_settings').select('value').eq('key', 'bank_cred_pin').maybeSingle();
  return data && data.value && data.value.hash ? data.value : null;
}
async function status() { const p = await pinRow(); return { pin_set: !!p, updated_at: p ? p.updated_at : null, updated_by: p ? p.updated_by : null }; }
async function log(account_id, action, ok, by) {
  await supabase.from('bank_cred_logs').insert({ account_id: account_id || null, action, ok, by_user: by || null });
}
async function checkPin(pin, by) {
  const f = fails.get(by) || { n: 0, until: 0 };
  if (f.until > Date.now()) throw new Error(`查看密碼錯太多次，請 ${Math.ceil((f.until - Date.now()) / 60000)} 分鐘後再試`);
  const p = await pinRow();
  if (!p) throw new Error('還沒設定查看密碼，請先設定');
  if (!pin || !(await bcrypt.compare(String(pin), p.hash))) {
    f.n += 1; if (f.n >= 5) { f.until = Date.now() + 10 * 60e3; f.n = 0; }
    fails.set(by, f);
    await log(null, 'pin_fail', false, by);
    throw new Error('查看密碼不對');
  }
  fails.delete(by);
}
async function setPin({ old_pin, new_pin }, by, isBoss) {
  if (!new_pin || String(new_pin).length < 4) throw new Error('查看密碼至少 4 碼');
  const p = await pinRow();
  if (p && !isBoss) await checkPin(old_pin, by);   // 改密碼要先輸入舊的；最高管理者可直接重設
  const value = { hash: await bcrypt.hash(String(new_pin), 10), updated_at: new Date().toISOString(), updated_by: by };
  const { error } = await supabase.from('report_settings').upsert({ key: 'bank_cred_pin', value }, { onConflict: 'key' });
  if (error) throw new Error(error.message);
  await log(null, 'pin_set', true, by);
  return { ok: true };
}

// ── 帳密 ──
function cleanFields(fields) {
  if (!Array.isArray(fields)) throw new Error('欄位格式不對');
  return fields.slice(0, 12).map((f) => ({
    label: String(f.label || '').trim().slice(0, 30), value: String(f.value == null ? '' : f.value).slice(0, 200), secret: f.secret !== false,
  })).filter((f) => f.label);
}
async function reveal(accountId, pin, by) {
  await checkPin(pin, by);
  const { data: a } = await supabase.from('bank_accounts').select('id, cred_enc').eq('id', accountId).maybeSingle();
  if (!a) throw new Error('找不到帳戶');
  const fields = decrypt(a.cred_enc);
  await log(accountId, 'reveal', true, by);
  return fields;
}
async function save(accountId, pin, fields, by) {
  await checkPin(pin, by);
  const fs = cleanFields(fields);
  const { error } = await supabase.from('bank_accounts').update({
    cred_enc: fs.length ? encrypt(fs) : null,
    cred_labels: fs.map((f) => ({ label: f.label, secret: f.secret, has: !!f.value, value: f.secret ? null : f.value })),
    cred_updated_at: new Date().toISOString(), cred_updated_by: by,
  }).eq('id', accountId);
  if (error) throw new Error(error.message);
  await log(accountId, 'update', true, by);
  return { saved: fs.length };
}
async function logs(accountId) {
  let q = supabase.from('bank_cred_logs').select('*').order('created_at', { ascending: false }).limit(100);
  if (accountId) q = q.eq('account_id', accountId);
  const { data } = await q;
  return data || [];
}

module.exports = { encrypt, decrypt, status, setPin, reveal, save, logs, checkPin };
