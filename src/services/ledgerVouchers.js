// services/ledgerVouchers.js —— 開帳原始憑證（2026-10-21）
// 規則：只有營運部（role operation_*）與超級管理員看得到、傳得了；其他人（部門主管、店長、股東）一律看不到。
// 來源：
//   ledger_vouchers（本系統上傳，私有 bucket ledger-vouchers）：bill／manual／amort（分攤整組）／opex／recurring／billing_order／fixed／contract
//   vendor_payment_files（廠商請款附件，私有 bucket vendor-files）：帳單是從請款產生的（vendor_payment_requests.linked_bill_id）就一起列
//   attachments（合約管理上傳的合約檔，entity_type contract）
//   ERP 費用單：市場部結帳資料的支出憑證照片（line.receipt_photos，已是網址）
const supabase = require('../config/supabase');

const BUCKET = 'ledger-vouchers';
const REF_TYPES = ['bill', 'manual', 'amort', 'opex', 'recurring', 'billing_order', 'fixed', 'contract'];
const MAX_BYTES = 20 * 1024 * 1024;
const SIGN_SEC = 3600;

function canSee(user) {
  const r = String((user && user.role) || '');
  return r === 'super_admin' || r.startsWith('operation_');
}

// 月報一列 → 憑證掛在哪（null＝這種來源不能上傳）
function refOf(line, amortGroupOf) {
  const id = String(line.ref_id || '');
  switch (line.source) {
    case 'bill': return { type: 'bill', id };
    case 'billing_order': return { type: 'billing_order', id };
    case 'opex': return { type: 'opex', id };
    case 'recurring': return { type: 'recurring', id };
    case 'fixed': return { type: 'fixed', id };
    case 'manual_value': case 'manual_adjust': return { type: 'manual', id };
    case 'manual_amort': return amortGroupOf && amortGroupOf[id] ? { type: 'amort', id: amortGroupOf[id] } : null;
    case 'contract': return id.startsWith('ct-') ? { type: 'contract', id: id.slice(3) } : null;
    default: return null;
  }
}

async function signMany(bucket, paths) {
  const ps = [...new Set(paths.filter(Boolean))];
  if (!ps.length) return new Map();
  const { data } = await supabase.storage.from(bucket).createSignedUrls(ps, SIGN_SEC);
  return new Map((data || []).map((x) => [x.path, x.signedUrl]));
}

const kindOf = (mime, name) => (/^image\//.test(mime || '') || /\.(jpe?g|png|gif|webp|heic)$/i.test(name || '') ? 'image' : /pdf/.test(mime || '') || /\.pdf$/i.test(name || '') ? 'pdf' : 'file');

/** 一批 ref → { 'type:id': [ {id, name, url, kind, from, deletable, uploaded_by, created_at} ] } */
async function filesFor(refs) {
  const out = {};
  const push = (k, f) => { (out[k] = out[k] || []).push(f); };
  const byType = {};
  for (const r of refs) if (r && r.id) (byType[r.type] = byType[r.type] || new Set()).add(String(r.id));

  // 1. 本系統上傳
  const all = [];
  for (const [t, ids] of Object.entries(byType)) {
    const list = [...ids];
    for (let i = 0; i < list.length; i += 300) {
      const { data, error } = await supabase.from('ledger_vouchers').select('*').eq('ref_type', t).in('ref_id', list.slice(i, i + 300)).is('void_at', null);
      if (error) throw new Error(error.message);
      all.push(...(data || []));
    }
  }
  const signed = await signMany(BUCKET, all.map((v) => v.storage_path));
  for (const v of all.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))) {
    push(`${v.ref_type}:${v.ref_id}`, { id: v.id, name: v.file_name, url: signed.get(v.storage_path) || null, kind: kindOf(v.mime_type, v.file_name), from: '營運部上傳', deletable: true, uploaded_by: v.uploaded_by, created_at: v.created_at, note: v.note });
  }

  // 2. 帳單是廠商請款產生的 → 廠商附件
  const billIds = [...(byType.bill || [])];
  if (billIds.length) {
    const { data: reqs } = await supabase.from('vendor_payment_requests').select('id, linked_bill_id, request_no').in('linked_bill_id', billIds);
    const reqIds = (reqs || []).map((r) => r.id);
    if (reqIds.length) {
      const { data: vf } = await supabase.from('vendor_payment_files').select('id, request_id, file_name, file_url, storage_path, mime_type, uploaded_at').in('request_id', reqIds);
      const vs = await signMany('vendor-files', (vf || []).map((f) => f.storage_path));
      const billOf = new Map((reqs || []).map((r) => [r.id, r.linked_bill_id]));
      for (const f of vf || []) {
        push(`bill:${billOf.get(f.request_id)}`, { id: `vpf-${f.id}`, name: f.file_name, url: (f.storage_path && vs.get(f.storage_path)) || f.file_url || null, kind: kindOf(f.mime_type, f.file_name), from: '廠商上傳', deletable: false, created_at: f.uploaded_at });
      }
    }
  }

  // 3. 合約檔（合約管理上傳的）
  const ctIds = [...(byType.contract || [])];
  if (ctIds.length) {
    const { data: af } = await supabase.from('attachments').select('id, entity_id, original_name, storage_path, mime_type, uploaded_at').eq('entity_type', 'contract').in('entity_id', ctIds);
    const as = await signMany('attachments', (af || []).map((f) => f.storage_path));
    for (const f of af || []) push(`contract:${f.entity_id}`, { id: `att-${f.id}`, name: f.original_name, url: as.get(f.storage_path) || null, kind: kindOf(f.mime_type, f.original_name), from: '合約檔', deletable: false, created_at: f.uploaded_at });
  }
  return out;
}

/** 分攤：每一筆 manual_amort 的 entry id → amort_group */
async function amortGroups(ids) {
  if (!ids.length) return {};
  const { data } = await supabase.from('ledger_manual_entries').select('id, amort_group').in('id', ids);
  return Object.fromEntries((data || []).filter((r) => r.amort_group).map((r) => [r.id, r.amort_group]));
}

// 走過月報結構，找出每一列明細（有 source 的物件陣列 lines）
function eachLines(node, fn, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 8) return;
  if (Array.isArray(node)) { node.forEach((x) => eachLines(x, fn, depth + 1)); return; }
  if (Array.isArray(node.lines) && node.lines.some((l) => l && l.source)) fn(node);
  for (const [k, v] of Object.entries(node)) if (k !== 'lines' && v && typeof v === 'object') eachLines(v, fn, depth + 1);
}

/**
 * 月報（一家店）：看得到的人 → 每列明細補 voucher_ref、vouchers、缺憑證計數；看不到的人 → 拿掉所有憑證（含 ERP 費用單照片）
 */
async function decorateReport(rep, user) {
  if (!rep) return rep;
  const rows = [];
  eachLines(rep, (row) => rows.push(row));
  if (!canSee(user)) {
    for (const row of rows) for (const l of row.lines) { delete l.receipt_photos; delete l.vouchers; delete l.voucher_ref; }
    rep.vouchers_visible = false;
    return rep;
  }
  const lines = rows.flatMap((r) => r.lines);
  const ag = await amortGroups(lines.filter((l) => l.source === 'manual_amort').map((l) => String(l.ref_id)));
  const refs = lines.map((l) => refOf(l, ag));
  const files = await filesFor(refs);
  let missing = 0, total = 0;
  lines.forEach((l, i) => {
    const r = refs[i];
    l.voucher_ref = r;
    const list = r ? (files[`${r.type}:${r.id}`] || []).slice() : [];
    for (const u of l.receipt_photos || []) list.push({ id: `rc-${u}`, name: '結帳資料支出憑證', url: u, kind: 'image', from: '門市結帳資料', deletable: false });
    l.vouchers = list;
    const needs = r || l.source === 'erp_cost';
    if (needs && Number(l.amount)) { total++; if (!list.length) missing++; }
  });
  for (const row of rows) row.voucher_missing = row.lines.filter((l) => (l.voucher_ref || l.source === 'erp_cost') && Number(l.amount) && !(l.vouchers || []).length).length;
  rep.vouchers_visible = true;
  rep.voucher_stats = { total, missing };
  return rep;
}

async function list(type, id) {
  if (!REF_TYPES.includes(type) || !id) throw new Error('ref_type／ref_id 不對');
  return (await filesFor([{ type, id: String(id) }]))[`${type}:${id}`] || [];
}

async function upload(type, id, file, by, note) {
  if (!REF_TYPES.includes(type) || !id) throw new Error('ref_type／ref_id 不對');
  if (!file || !file.buffer || !file.buffer.length) throw new Error('空檔案');
  if (file.buffer.length > MAX_BYTES) throw new Error('檔案超過 20MB');
  const name = Buffer.from(file.originalname || 'file', 'latin1').toString('utf8');
  if (!/^(image\/|application\/pdf)/.test(file.mimetype || '') && !/\.(jpe?g|png|gif|webp|heic|pdf)$/i.test(name)) throw new Error('只收照片或 PDF');
  const ext = (name.match(/\.[A-Za-z0-9]{1,8}$/) || [''])[0].toLowerCase();
  const path = `${type}/${id}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`;
  const { error: upErr } = await supabase.storage.from(BUCKET).upload(path, file.buffer, { contentType: file.mimetype || 'application/octet-stream', upsert: false });
  if (upErr) throw new Error('上傳失敗：' + upErr.message);
  const { data, error } = await supabase.from('ledger_vouchers').insert({ ref_type: type, ref_id: String(id), storage_path: path, file_name: name, mime_type: file.mimetype || null, size_bytes: file.buffer.length, note: note || null, uploaded_by: by }).select().single();
  if (error) { await supabase.storage.from(BUCKET).remove([path]).catch(() => {}); throw new Error(error.message); }
  return data;
}

// 作廢（留紀錄、檔案不刪：會計憑證）
async function voidOne(id, by) {
  const { data, error } = await supabase.from('ledger_vouchers').update({ void_at: new Date().toISOString(), void_by: by }).eq('id', id).is('void_at', null).select('id').maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error('找不到這張憑證');
  return data;
}

module.exports = { canSee, refOf, filesFor, decorateReport, list, upload, voidOne, REF_TYPES };
