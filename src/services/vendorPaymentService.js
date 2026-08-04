// services/vendorPaymentService.js
// 廠商請款模組
//   - 廠商銀行帳號 CRUD
//   - 請款單 CRUD + 流程（draft → submitted → approved → paid / rejected）
//   - 請款附件 CRUD（儲存 metadata，實體檔案請呼叫端上傳到 Supabase Storage）
//   - 發票 CRUD
//   - 公司付款方資料（單例）

const supabase = require('../config/supabase');
const { notifyMarketStatus } = require('./marketWebhook');

// ════════════════════════════════════════════════════════════
//                  廠商銀行帳號
// ════════════════════════════════════════════════════════════

async function listBankAccounts(source_id) {
  const { data, error } = await supabase
    .from('vendor_bank_accounts').select('*')
    .eq('source_id', source_id)
    .order('is_default', { ascending: false })
    .order('created_at', { ascending: true });
  if (error) throw new Error(error.message);
  return data || [];
}

async function createBankAccount(source_id, payload) {
  if (!payload.bank_code || !payload.account_no || !payload.account_name) {
    throw new Error('bank_code / account_no / account_name 必填');
  }
  // 設成預設時，先把同 source 其他帳號的 is_default 取消
  if (payload.is_default) {
    await supabase.from('vendor_bank_accounts')
      .update({ is_default: false }).eq('source_id', source_id);
  }
  const { data, error } = await supabase.from('vendor_bank_accounts').insert([{
    source_id,
    bank_code:    payload.bank_code,
    branch_code:  payload.branch_code || null,
    account_no:   payload.account_no,
    account_name: payload.account_name,
    is_default:   !!payload.is_default,
    note:         payload.note || null,
  }]).select().single();
  if (error) throw new Error(error.message);
  return data;
}

async function updateBankAccount(id, patch) {
  // 設成預設時，同 source 其他帳號取消預設
  if (patch.is_default) {
    const { data: row } = await supabase
      .from('vendor_bank_accounts').select('source_id').eq('id', id).maybeSingle();
    if (row) {
      await supabase.from('vendor_bank_accounts')
        .update({ is_default: false }).eq('source_id', row.source_id);
    }
  }
  const allowed = {};
  ['bank_code','branch_code','account_no','account_name','is_default','note']
    .forEach(k => { if (patch[k] !== undefined) allowed[k] = patch[k]; });
  const { data, error } = await supabase.from('vendor_bank_accounts')
    .update(allowed).eq('id', id).select().single();
  if (error) throw new Error(error.message);
  return data;
}

async function deleteBankAccount(id) {
  const { error } = await supabase.from('vendor_bank_accounts').delete().eq('id', id);
  if (error) throw new Error(error.message);
  return { id };
}


// ════════════════════════════════════════════════════════════
//                    請款單 CRUD
// ════════════════════════════════════════════════════════════

const SELECT_REQUEST = `
  *,
  source:billing_sources(id, name, short_name, code, contact_name, contact_phone),
  bank_account:vendor_bank_accounts(*)
`;

async function listRequests({ source_id, period, status, keyword, limit = 200 } = {}) {
  let q = supabase.from('vendor_payment_requests')
    .select(SELECT_REQUEST)
    .order('created_at', { ascending: false })
    .limit(Math.min(500, Number(limit) || 200));
  if (source_id) q = q.eq('source_id', source_id);
  if (period)    q = q.eq('period', period);
  if (status)    q = q.eq('status', status);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  let rows = data || [];
  if (keyword) {
    const k = String(keyword).toLowerCase();
    rows = rows.filter(r =>
      (r.request_no || '').toLowerCase().includes(k) ||
      (r.title || '').toLowerCase().includes(k) ||
      (r.source?.name || '').toLowerCase().includes(k)
    );
  }
  return rows;
}

async function getRequest(id) {
  const { data, error } = await supabase
    .from('vendor_payment_requests').select(SELECT_REQUEST)
    .eq('id', id).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error('找不到請款單');

  // 附件
  const { data: files } = await supabase.from('vendor_payment_files')
    .select('*').eq('request_id', id).order('uploaded_at', { ascending: true });
  data.files = files || [];

  // 發票
  const { data: invoices } = await supabase.from('vendor_invoices')
    .select('*').eq('request_id', id).order('invoice_date', { ascending: false });
  data.invoices = invoices || [];

  return data;
}

/**
 * 預設附言模板：{period_mm}-{vendor_short}-貨款
 * 例：04-精華-貨款
 */
function buildDefaultMemo(period, vendor_short) {
  if (!period) return null;
  const mm = period.slice(5, 7);
  const sh = vendor_short || '';
  return `${mm}-${sh}-貨款`;
}

async function createRequest(payload, { actorType, actorId }) {
  if (!payload.source_id || !payload.period || !payload.title) {
    throw new Error('source_id / period / title 必填');
  }
  if (!/^\d{4}-\d{2}$/.test(payload.period)) {
    throw new Error('period 格式必須是 YYYY-MM');
  }

  // 取 vendor short_name + 預設銀行帳號
  const { data: src } = await supabase.from('billing_sources')
    .select('short_name, name').eq('id', payload.source_id).maybeSingle();
  if (!src) throw new Error('來源單位不存在');

  let bankAccountId = payload.bank_account_id || null;
  if (!bankAccountId) {
    const { data: defBank } = await supabase.from('vendor_bank_accounts')
      .select('id').eq('source_id', payload.source_id).eq('is_default', true).maybeSingle();
    if (defBank) bankAccountId = defBank.id;
  }

  const remitMemo = payload.remit_memo || buildDefaultMemo(payload.period, src.short_name);

  const insertData = {
    source_id:       payload.source_id,
    bank_account_id: bankAccountId,
    period:          payload.period,
    title:           payload.title,
    description:     payload.description || null,
    total_amount:    payload.total_amount || 0,
    invoice_amount:  payload.invoice_amount || null,
    tax_amount:      payload.tax_amount || null,
    pre_tax_amount:  payload.pre_tax_amount || null,
    remit_memo:      remitMemo,
    status:          'draft',
    created_by_type: actorType === 'vendor' ? 'vendor' : 'system',
  };
  if (actorType === 'vendor') insertData.created_by_vendor = actorId;
  if (actorType === 'system') insertData.created_by_system = actorId;

  const { data, error } = await supabase.from('vendor_payment_requests')
    .insert([insertData]).select().single();
  if (error) throw new Error(error.message);
  return data;
}

async function updateRequest(id, patch, { actorType, actorId }) {
  const { data: before } = await supabase.from('vendor_payment_requests')
    .select('*').eq('id', id).maybeSingle();
  if (!before) throw new Error('找不到請款單');

  // 廠商只能改自己的 draft
  if (actorType === 'vendor') {
    if (before.created_by_vendor !== actorId) throw new Error('無權編輯此請款單');
    if (before.status !== 'draft') throw new Error('已送出的請款單不能編輯');
  }
  // 系統人員：draft / submitted 可改；approved/paid/rejected 不能改基本欄位
  if (actorType === 'system' && !['draft','submitted'].includes(before.status)) {
    throw new Error(`狀態為 ${before.status}，不能編輯基本欄位`);
  }

  const allowed = {};
  ['title','description','period','total_amount','invoice_amount','tax_amount',
   'pre_tax_amount','bank_account_id','remit_memo']
    .forEach(k => { if (patch[k] !== undefined) allowed[k] = patch[k]; });

  const { data, error } = await supabase.from('vendor_payment_requests')
    .update(allowed).eq('id', id).select().single();
  if (error) throw new Error(error.message);
  return data;
}

async function deleteRequest(id, { actorType, actorId }) {
  const { data: before } = await supabase.from('vendor_payment_requests')
    .select('status, created_by_vendor').eq('id', id).maybeSingle();
  if (!before) throw new Error('找不到請款單');

  if (actorType === 'vendor') {
    if (before.created_by_vendor !== actorId) throw new Error('無權刪除');
    if (before.status !== 'draft') throw new Error('已送出不能刪除');
  } else {
    if (before.status === 'paid') throw new Error('已撥款不能刪除');
  }

  const { error } = await supabase.from('vendor_payment_requests').delete().eq('id', id);
  if (error) throw new Error(error.message);
  return { id };
}

// ── 狀態轉換 ────────────────────────────────────────────────

async function submitRequest(id, { actorType, actorId }) {
  const { data: req } = await supabase.from('vendor_payment_requests')
    .select('status, created_by_vendor').eq('id', id).maybeSingle();
  if (!req) throw new Error('找不到請款單');
  if (req.status !== 'draft') throw new Error('只有草稿可送審');
  if (actorType === 'vendor' && req.created_by_vendor !== actorId) {
    throw new Error('無權送審');
  }
  const { data, error } = await supabase.from('vendor_payment_requests')
    .update({ status: 'submitted', submitted_at: new Date().toISOString() })
    .eq('id', id).select().single();
  if (error) throw new Error(error.message);
  return data;
}

// ────────────────────────────────────────────────────────────
//   內部：若請款來自 market，非同步回推 status 給 market
// ────────────────────────────────────────────────────────────
function fireWebhookIfMarket(row, opStatus, note) {
  if (!row || row.source_system !== 'market' || !row.market_payment_request_id) return;
  // fire-and-forget（不 await；失敗只 log，不影響本地流程）
  notifyMarketStatus(row.market_payment_request_id, {
    status:         opStatus,
    operation_note: note || null,
    operation_ref:  row.request_no || null,
    updated_at:     new Date().toISOString(),
  }).catch(err => console.warn('[vendorPayment] webhook fire failed:', err?.message));
}

async function approveRequest(id, actorSystemId) {
  const { data, error } = await supabase.from('vendor_payment_requests')
    .update({
      status: 'approved',
      approved_at: new Date().toISOString(),
      approved_by: actorSystemId,
    }).eq('id', id).eq('status', 'submitted').select().single();
  if (error) throw new Error(error.message);
  if (!data) throw new Error('只有送審中的請款可通過');
    fireWebhookIfMarket(data, 'operation_approved');
  return data;
}

async function rejectRequest(id, reason, actorSystemId) {
  if (!reason || !reason.trim()) throw new Error('退回必須附原因');
  const { data, error } = await supabase.from('vendor_payment_requests')
    .update({
      status: 'rejected',
      rejected_at: new Date().toISOString(),
      rejected_by: actorSystemId,
      rejection_reason: reason.trim(),
    }).eq('id', id).in('status', ['submitted', 'approved']).select().single();
  if (error) throw new Error(error.message);
  if (!data) throw new Error('只有送審中/已通過的請款可退回');
    fireWebhookIfMarket(data, 'operation_rejected', reason);
  return data;
}

async function markPaid(id, actorSystemId) {
  const { data, error } = await supabase.from('vendor_payment_requests')
    .update({
      status: 'paid',
      paid_at: new Date().toISOString(),
      paid_by: actorSystemId,
    }).eq('id', id).eq('status', 'approved').select().single();
  if (error) throw new Error(error.message);
  if (!data) throw new Error('只有已通過的請款可標記撥款');
    fireWebhookIfMarket(data, 'operation_completed');
  return data;
}


// ════════════════════════════════════════════════════════════
//                  請款附件 metadata CRUD
// ════════════════════════════════════════════════════════════

async function addFile(request_id, payload, actorType) {
  if (!payload.file_url || !payload.file_name || !payload.file_type) {
    throw new Error('file_url / file_name / file_type 必填');
  }
  if (!['summary','detail','invoice','other'].includes(payload.file_type)) {
    throw new Error('file_type 必須是 summary / detail / invoice / other');
  }
  const { data, error } = await supabase.from('vendor_payment_files').insert([{
    request_id,
    file_type:        payload.file_type,
    file_name:        payload.file_name,
    file_url:         payload.file_url,
    file_size:        payload.file_size || null,
    mime_type:        payload.mime_type || null,
    uploaded_by_type: actorType || 'system',
  }]).select().single();
  if (error) throw new Error(error.message);
  return data;
}

async function deleteFile(id) {
  const { error } = await supabase.from('vendor_payment_files').delete().eq('id', id);
  if (error) throw new Error(error.message);
  return { id };
}


// ════════════════════════════════════════════════════════════
//                  發票 CRUD
// ════════════════════════════════════════════════════════════

async function addInvoice(request_id, payload) {
  if (!payload.invoice_no || payload.amount == null) {
    throw new Error('invoice_no / amount 必填');
  }
  // 自動算稅額（若有未稅 + 含稅）
  const amount   = Number(payload.amount);
  let preTax     = payload.pre_tax_amount != null ? Number(payload.pre_tax_amount) : null;
  let taxAmount  = payload.tax_amount     != null ? Number(payload.tax_amount)     : null;
  if (preTax != null && taxAmount == null) taxAmount = +(amount - preTax).toFixed(2);
  if (taxAmount != null && preTax == null) preTax    = +(amount - taxAmount).toFixed(2);

  const { data, error } = await supabase.from('vendor_invoices').insert([{
    request_id,
    file_id:               payload.file_id || null,
    invoice_no:            payload.invoice_no,
    invoice_date:          payload.invoice_date || null,
    vendor_tax_id:         payload.vendor_tax_id || null,
    buyer_tax_id:          payload.buyer_tax_id || null,
    amount,
    pre_tax_amount:        preTax,
    tax_amount:            taxAmount,
    tax_type:              payload.tax_type || 'taxable',
    is_input_tax_eligible: payload.is_input_tax_eligible !== false,
    ocr_data:              payload.ocr_data || null,
    note:                  payload.note || null,
  }]).select().single();
  if (error) throw new Error(error.message);
  return data;
}

async function updateInvoice(id, patch) {
  const allowed = {};
  ['invoice_no','invoice_date','vendor_tax_id','buyer_tax_id','amount',
   'pre_tax_amount','tax_amount','tax_type','is_input_tax_eligible','note']
    .forEach(k => { if (patch[k] !== undefined) allowed[k] = patch[k]; });
  const { data, error } = await supabase.from('vendor_invoices')
    .update(allowed).eq('id', id).select().single();
  if (error) throw new Error(error.message);
  return data;
}

async function deleteInvoice(id) {
  const { error } = await supabase.from('vendor_invoices').delete().eq('id', id);
  if (error) throw new Error(error.message);
  return { id };
}


// ════════════════════════════════════════════════════════════
//                  公司付款方資料（單例）
// ════════════════════════════════════════════════════════════

async function getCompanyProfile() {
  const { data, error } = await supabase
    .from('company_profile').select('*').eq('id', 1).maybeSingle();
  if (error) throw new Error(error.message);
  return data;   // 可能是 null（尚未設定）
}

async function upsertCompanyProfile(payload) {
  if (!payload.company_name) throw new Error('company_name 必填');
  const row = {
    id: 1,
    company_name:          payload.company_name,
    tax_id:                payload.tax_id || null,
    payer_account_name:    payload.payer_account_name || null,
    payer_account_no:      payload.payer_account_no || null,
    payer_bank_code:       payload.payer_bank_code || null,
    payer_branch_code:     payload.payer_branch_code || null,
    default_overdue_code:  payload.default_overdue_code  || '1',
    default_fee_burden:    payload.default_fee_burden    || '15',
    default_notify_method: payload.default_notify_method || '0',
    gemini_api_key:        payload.gemini_api_key        || null,
    binding_report_api_key: payload.binding_report_api_key || null,
  };
  const { data, error } = await supabase.from('company_profile')
    .upsert([row], { onConflict: 'id' }).select().single();
  if (error) throw new Error(error.message);
  return data;
}


module.exports = {
  // 銀行帳號
  listBankAccounts, createBankAccount, updateBankAccount, deleteBankAccount,
  // 請款單
  listRequests, getRequest, createRequest, updateRequest, deleteRequest,
  submitRequest, approveRequest, rejectRequest, markPaid,
  // 附件
  addFile, deleteFile,
  // 發票
  addInvoice, updateInvoice, deleteInvoice,
  // 公司資料
  getCompanyProfile, upsertCompanyProfile,
  // 工具
  buildDefaultMemo,
};
