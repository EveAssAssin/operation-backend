// services/vendorPaymentService.js
// 廠商請款模組
//   - 廠商銀行帳號 CRUD
//   - 請款單 CRUD + 流程（draft → submitted → approved → paid / rejected）
//   - 請款附件 CRUD（儲存 metadata，實體檔案請呼叫端上傳到 Supabase Storage）
//   - 發票 CRUD
//   - 公司付款方資料（單例）

const supabase = require('../config/supabase');
const LP = require('./ledgerPost');
const { notifyMarketStatus } = require('./marketWebhook');
const { notifyChiLensStatus } = require('./chiLensWebhook');

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
  data.files = await signFiles(files || []);

  // 分配門市（廠商入口 V1，2026-10-20）
  const { data: allocs } = await supabase.from('vendor_payment_allocations')
    .select('*').eq('request_id', id).order('seq', { ascending: true });
  data.allocations = allocs || [];
  data.alloc_total = Math.round((allocs || []).reduce((a, x) => a + Number(x.amount || 0), 0) * 100) / 100;

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
    if (!['draft', 'rejected'].includes(before.status)) throw new Error('已送出的請款單不能編輯');
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
  if (!['draft', 'rejected'].includes(req.status)) throw new Error('只有草稿或被退回的請款可送審');
  if (actorType === 'vendor' && req.created_by_vendor !== actorId) {
    throw new Error('無權送審');
  }
  if (actorType === 'vendor') {
    const [{ data: al }, { data: fl }] = await Promise.all([
      supabase.from('vendor_payment_allocations').select('amount').eq('request_id', id),
      supabase.from('vendor_payment_files').select('id').eq('request_id', id),
    ]);
    if (!(al || []).length) throw new Error('請先填「項目名稱／金額／門市」至少一列');
    if (!(fl || []).length) throw new Error('請先上傳帳單照片或 Excel');
  }
  const { data, error } = await supabase.from('vendor_payment_requests')
    .update({ status: 'submitted', submitted_at: new Date().toISOString(), rejection_reason: null })
    .eq('id', id).select().single();
  if (error) throw new Error(error.message);
  return data;
}

// ────────────────────────────────────────────────────────────
//   內部：若請款來自 market，非同步回推 status 給 market
// ────────────────────────────────────────────────────────────
// ────────────────────────────────────────────────────────────
//   自動建 bill：source_system=market/chi_lens 且有 ticket_details 時，
//   通過時把明細按門市 aggregate 建成 bills + bill_allocations，
//   讓外部請款能認列進門市月報。
// ────────────────────────────────────────────────────────────
async function maybeCreateLinkedBill(row) {
  if (!row) return null;
  if (row.source_system === 'internal') return null;
  if (row.linked_bill_id) return row.linked_bill_id;   // 已建過
  const details = Array.isArray(row.ticket_details) ? row.ticket_details : null;
  if (!details || details.length === 0) return null;   // 沒明細就不能建

  // 依 store_erpid 加總金額（多張同一門市的單合併為一筆 allocation），
  // 同時收集哪些單號屬於該門市，供 allocation_note 用
  const byStore = new Map();
  for (const d of details) {
    const erpid = String(d.store_erpid || '').trim();
    if (!erpid) continue;
    const amt = Number(d.amount || 0);
    if (!amt) continue;
    const cur = byStore.get(erpid) || {
      store_erpid: erpid,
      store_name:  d.store_name || null,
      amount:      0,
      numbers:     [],
    };
    cur.amount += amt;
    if (d.number) cur.numbers.push(d.number);
    if (!cur.store_name && d.store_name) cur.store_name = d.store_name;
    byStore.set(erpid, cur);
  }
  const allocations = Array.from(byStore.values());
  if (allocations.length === 0) {
    console.warn('[vendorPayment] maybeCreateLinkedBill: 無有效 store_erpid，跳過');
    return null;
  }
  const totalFromAllocs = allocations.reduce((s, a) => s + a.amount, 0);

  // 把 ticket_details 轉成 bills.items 格式（配合前端 BillItemsTable 期望的欄位）
  //   多來源相容：market 每張 ticket = 一列；chi-lens 完成/退回逐筆 = 一列
  const items = details.map((d, i) => {
    const raw = d.raw || {};
    const type = d.type || raw.type || 'completion';
    const amt  = Number(d.amount || 0);           // return 時已為負
    const quantity   = Number(d.quantity ?? raw.quantity ?? 1);
    const unitPrice  = Number(
      d.unit_price ?? raw.unit_price ?? raw.client_unit_price ??
      (quantity && quantity !== 0 ? Math.abs(amt) / Math.abs(quantity) : Math.abs(amt))
    );
    return {
      type,
      seq_no:          d.seq_no ?? raw.seq_no ?? (i + 1),
      item_date:       d.item_date || raw.item_date || null,
      customer_order:  d.customer_order || raw.customer_order || null,
      doc_number:      d.number || raw.doc_number || null,
      product_spec:    d.product_spec || raw.product_spec || d.description || raw.description || d.note || raw.note || null,
      quantity,
      markup:          Number(d.markup ?? raw.markup ?? 0),
      unit_price:      unitPrice,
      total:           amt,   // return 為負值，前端會以紅字 + 「退回」badge 顯示
      // 額外欄位保留（BillItemsTable 已支援顯示）
      vendor:          d.vendor || raw.vendor || null,
      vendor_name:     d.vendor_name || raw.vendor_name || null,
      store_erpid:     d.store_erpid || raw.lohas_erp_id || null,
      store_name:      d.store_name  || raw.branch_name || null,
      detail_url:      d.detail_url || raw.detail_url || null,
      engineer:        row.engineer_name || null,
    };
  });

  // notes：把工務師 + 銀行資訊摘要塞進來，讓 bill 詳情頁一眼看到
  const bank = row.bank_snapshot || {};
  const bankLine = bank.account_number
    ? `匯款帳號：${bank.account_holder_name || '?'}｜${bank.bank_name || ''}${bank.bank_code ? '（' + bank.bank_code + (bank.branch_code ? '-' + bank.branch_code : '') + '）' : ''}｜${bank.account_number}`
    : null;
  const engineerLine = row.engineer_name
    ? `外部工務師：${row.engineer_name}`
    : (row.vendor_code ? `路奇 vendor：${row.vendor_code}` : null);
  const notes = [engineerLine, bankLine].filter(Boolean).join('\n') || null;

  const nowIso = new Date().toISOString();

  // 1. 建 bill（bill_no 由 trigger 自動產）
  const { data: bill, error: billErr } = await supabase
    .from('bills')
    .insert({
      source_id:       row.source_id,
      period:          row.period,
      title:           row.title || `${row.engineer_name || row.vendor_code || '外部'} 請款`,
      description:     `由請款單 ${row.request_no || row.id} 自動建立（source_system=${row.source_system}）`,
      total_amount:    totalFromAllocs,
      status:          'confirmed',       // 通過即代表已確認
      items,                              // 明細列表（前端會用 BillItemsTable 顯示）
      source_ref:      row.request_no,    // 外部參考單號 = 請款單號（雙向可追）
      submitted_at:    nowIso,
      confirmed_at:    nowIso,
      created_by_type: 'system',
      notes,
    })
    .select('id, bill_no')
    .single();
  if (billErr) {
    console.error('[vendorPayment] 自動建 bill 失敗：', billErr.message);
    return null;
  }

  // 2. 建 bill_allocations（allocation_note 帶上該門市對應的單號）
  const rows = allocations.map(a => ({
    bill_id:          bill.id,
    store_erpid:      a.store_erpid,
    store_name:       a.store_name,
    allocated_amount: a.amount,
    allocation_note:  a.numbers.length
      ? `來自請款 ${row.request_no}；含 ${a.numbers.length} 張單：${a.numbers.join('、')}`
      : `來自請款 ${row.request_no}`,
  }));
  const { error: allocErr } = await supabase.from('bill_allocations').insert(rows);
  if (allocErr) {
    console.error('[vendorPayment] 建 bill_allocations 失敗：', allocErr.message);
    // 不 rollback bill，讓人工修正；紀錄警告
  }

  // 3. 回填 linked_bill_id 到 request
  await supabase
    .from('vendor_payment_requests')
    .update({ linked_bill_id: bill.id })
    .eq('id', row.id);

  console.log(`[vendorPayment] ✅ 通過 ${row.request_no} 自動建 bill ${bill.bill_no}，分配到 ${allocations.length} 個門市，${items.length} 筆明細`);
  return bill.id;
}


function fireWebhookIfMarket(row, opStatus, note) {
  // 相容舊呼叫；實際 dispatch 由 source_system 決定
  return fireWebhookIfExternal(row, opStatus, note);
}

function fireWebhookIfExternal(row, opStatus, note) {
  if (!row || !row.source_system || row.source_system === 'internal') return;
  if (!row.market_payment_request_id) return;   // 兩種來源都存在 market_payment_request_id 欄位
  const externalId = row.market_payment_request_id;
  const bodyBase = {
    status:         opStatus,
    operation_note: note || null,
    operation_ref:  row.request_no || null,
    updated_at:     new Date().toISOString(),
  };
  if (row.source_system === 'market') {
    notifyMarketStatus(externalId, bodyBase)
      .catch(err => console.warn('[vendorPayment] market webhook failed:', err?.message));
  } else if (row.source_system === 'chi_lens') {
    notifyChiLensStatus(externalId, bodyBase)
      .catch(err => console.warn('[vendorPayment] chi-lens webhook failed:', err?.message));
  }
}

// 入帳設定（2026-10-20 營運：會計按「通過」時就能改入帳月份）：report_ym 入帳月份、ledger_code 月報格子、amort_months 分攤月數
// 沒填＝照預設（費用月＋收到日，過了截止日列下個月）；寫進帳單時遇到已關帳的月份自動順延
async function cleanAcct(acct) {
  if (!acct || typeof acct !== 'object') return null;
  const out = {};
  if (acct.report_ym !== undefined) {
    if (acct.report_ym && !LP.YM.test(String(acct.report_ym))) throw new Error('入帳月份要是 YYYY-MM');
    out.report_ym = acct.report_ym || null;
  }
  if (acct.ledger_code !== undefined) {
    if (acct.ledger_code) {
      const { data } = await supabase.from('ledger_accounts').select('code').eq('code', acct.ledger_code).eq('kind', 'expense').maybeSingle();
      if (!data) throw new Error('沒有這個月報科目');
    }
    out.ledger_code = acct.ledger_code || null;
  }
  if (acct.amort_months !== undefined) {
    const n = acct.amort_months ? Math.floor(Number(acct.amort_months)) : null;
    if (n !== null && !(n >= 1 && n <= 60)) throw new Error('分攤月數要 1～60');
    out.amort_months = n && n > 1 ? n : null;
  }
  // 會計科目（2026-10-21）：選了科目＝月報格子跟著科目
  if (acct.subject_id !== undefined) {
    if (acct.subject_id) {
      const sj = await require('./ledgerSubjects').mustGet(acct.subject_id);
      out.subject_id = sj.id; out.ledger_code = sj.ledger_code;
    } else out.subject_id = null;
  }
  return Object.keys(out).length ? out : null;
}
async function setAccounting(id, acct, actor) {
  const c = await cleanAcct(acct);
  if (!c) throw new Error('沒有要改的入帳設定');
  const { data: row } = await supabase.from('vendor_payment_requests').select('status, linked_bill_id').eq('id', id).maybeSingle();
  if (!row) throw new Error('找不到請款單');
  if (row.linked_bill_id) throw new Error('這筆已經產生帳單進月報了，請到帳單管理改這張帳單的入帳月份／分攤');
  const { data, error } = await supabase.from('vendor_payment_requests').update({ ...c, acct_set_by: actor || null, acct_set_at: new Date().toISOString() }).eq('id', id).select().single();
  if (error) throw new Error(error.message);
  return data;
}
async function postBill(billId, row, receivedAt) {
  try {
    return await LP.applyToBill(billId, { report_ym: row.report_ym, ledger_code: row.ledger_code, subject_id: row.subject_id || null, amort_months: row.amort_months, fee_ym: row.period, received_at: receivedAt, by: row.acct_set_by || null });
  } catch (e) { console.error('[vendorPayment] 套用入帳設定失敗', billId, e && e.message); return null; }
}

async function approveRequest(id, actorSystemId, acct, actorName) {
  const c = await cleanAcct(acct);
  // 會計科目一定要選（這次帶的或之前存過的）
  if (!(c && c.subject_id)) {
    const { data: cur } = await supabase.from('vendor_payment_requests').select('subject_id').eq('id', id).maybeSingle();
    if (!cur || !cur.subject_id) throw new Error('請先選會計科目再通過（之後才能歸類分析）');
  }
  const { data, error } = await supabase.from('vendor_payment_requests')
    .update({
      status: 'approved',
      approved_at: new Date().toISOString(),
      approved_by: actorSystemId,
      ...(c ? { ...c, acct_set_by: actorName || null, acct_set_at: new Date().toISOString() } : {}),
    }).eq('id', id).eq('status', 'submitted').select().single();
  if (error) throw new Error(error.message);
  if (!data) throw new Error('只有送審中的請款可通過');

  // 若外部來源 + 有 ticket_details：自動建 bill + allocations（進門市月報）
  try {
    const billId = await maybeCreateLinkedBill(data);
    if (billId) { data.linked_bill_id = billId; data.posting = await postBill(billId, data, new Date().toISOString()); }
  } catch (e) { console.warn("[vendorPayment] maybeCreateLinkedBill:", e?.message); }

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
  // 廠商入口的請款：付款完成才進門市月報（營運 2026-10-20）→ 照分配門市產生帳單＋分攤
  try {
    const billId = await billFromAllocations(data);
    if (billId) { data.linked_bill_id = billId; data.posting = await postBill(billId, data, data.paid_at); }
  } catch (e) { console.warn('[vendorPayment] billFromAllocations:', e && e.message); }
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



// ════════════════════════════════════════════════════════════
//   廠商入口 V1（2026-10-20）：分配門市、附件私有存放、付款後產生帳單
// ════════════════════════════════════════════════════════════
const FILE_BUCKET = 'vendor-files';
const r2 = (n) => Math.round(Number(n) * 100) / 100;

/** 可選的門市／部門（門市在前；部門名稱是純數字的不列） */
async function listTargets() {
  const { data } = await supabase.from('departments').select('store_erpid, store_name, report_kind, is_active').eq('is_active', true);
  return (data || []).filter((d) => d.report_kind === 'store' || !/^\d+$/.test(String(d.store_name || '')))
    .map((d) => ({ store_erpid: d.store_erpid, store_name: d.store_name, kind: d.report_kind === 'store' ? 'store' : 'dept' }))
    .sort((a, b) => (a.kind === b.kind ? String(a.store_name).localeCompare(String(b.store_name), 'zh-Hant') : a.kind === 'store' ? -1 : 1));
}

/**
 * 存整份分配（覆蓋）。rows: [{item_name, store_erpid, amount, note}]
 * 廠商：只能改自己的草稿／被退回的；會計：送審中／已通過都能改（付款後不能改），改過的列記 adjusted_by，保留廠商原本填的。
 * 請款總額＝分配合計。
 */
async function saveAllocations(request_id, rows, { actorType, actorId, actorName }) {
  const { data: req } = await supabase.from('vendor_payment_requests').select('id, status, created_by_vendor, source_id').eq('id', request_id).maybeSingle();
  if (!req) throw new Error('找不到請款單');
  if (actorType === 'vendor') {
    if (req.created_by_vendor !== actorId) throw new Error('無權編輯此請款單');
    if (!['draft', 'rejected'].includes(req.status)) throw new Error('已送出的請款單不能改分配，要改請聯絡樂活會計');
  } else if (['paid'].includes(req.status)) {
    throw new Error('已付款的請款不能改分配（已進門市月報，要改請用月報調帳）');
  }
  if (!Array.isArray(rows) || !rows.length) throw new Error('至少要一列');
  if (rows.length > 300) throw new Error('一張請款最多 300 列');
  const targets = new Map((await listTargets()).map((t) => [String(t.store_erpid), t]));
  const clean = rows.map((x, i) => {
    const name = String(x.item_name || '').trim().slice(0, 100);
    const store = String(x.store_erpid || '');
    const amt = Number(x.amount);
    if (!name) throw new Error(`第 ${i + 1} 列沒有項目名稱`);
    if (!targets.has(store)) throw new Error(`第 ${i + 1} 列門市不對`);
    if (!Number.isFinite(amt) || amt === 0) throw new Error(`第 ${i + 1} 列金額不對`);
    return { id: x.id || null, item_name: name, store_erpid: store, store_name: targets.get(store).store_name, amount: r2(amt), note: x.note ? String(x.note).slice(0, 200) : null };
  });
  const { data: before } = await supabase.from('vendor_payment_allocations').select('*').eq('request_id', request_id);
  const old = new Map((before || []).map((b) => [b.id, b]));
  const now = new Date().toISOString();
  const ins = clean.map((c, i) => {
    const o = c.id ? old.get(c.id) : null;
    const row = { request_id, seq: i + 1, item_name: c.item_name, store_erpid: c.store_erpid, store_name: c.store_name, amount: c.amount, note: c.note };
    if (actorType === 'vendor') { row.vendor_amount = c.amount; row.vendor_store = c.store_erpid; }
    else {
      row.vendor_amount = o ? o.vendor_amount : null; row.vendor_store = o ? o.vendor_store : null;
      const changed = !o || Number(o.amount) !== c.amount || o.store_erpid !== c.store_erpid || o.item_name !== c.item_name;
      row.adjusted_by = changed ? (actorName || actorId || '會計') : (o.adjusted_by || null);
      row.adjusted_at = changed ? now : (o.adjusted_at || null);
    }
    return row;
  });
  // 會計刪掉的廠商列也要留痕：記在請款單 description 不合適 → 記 log
  if (actorType !== 'vendor') {
    const keep = new Set(clean.filter((c) => c.id).map((c) => c.id));
    const gone = (before || []).filter((b) => !keep.has(b.id) && b.vendor_amount != null);
    if (gone.length) console.log('[vendorPayment] 會計刪除廠商分配列', request_id, JSON.stringify(gone.map((g) => [g.item_name, g.store_erpid, g.vendor_amount])));
  }
  const { error: dErr } = await supabase.from('vendor_payment_allocations').delete().eq('request_id', request_id);
  if (dErr) throw new Error(dErr.message);
  const { error: iErr } = await supabase.from('vendor_payment_allocations').insert(ins);
  if (iErr) throw new Error(iErr.message);
  const total = r2(clean.reduce((a, c) => a + c.amount, 0));
  await supabase.from('vendor_payment_requests').update({ total_amount: total }).eq('id', request_id);
  return { total, rows: ins.length };
}

/** 上傳附件到私有 bucket（廠商／會計共用） */
async function uploadRequestFile(request_id, { buffer, mimeType, originalName, file_type }, actorType) {
  if (!['summary', 'detail', 'invoice', 'other'].includes(file_type)) file_type = 'summary';
  const okType = /^(image\/|application\/pdf|application\/vnd\.(ms-excel|openxmlformats-officedocument\.spreadsheetml)|text\/csv)/.test(mimeType || '');
  if (!okType) throw new Error('只收照片、PDF、Excel、CSV');
  const { data: req } = await supabase.from('vendor_payment_requests').select('source_id').eq('id', request_id).maybeSingle();
  if (!req) throw new Error('找不到請款單');
  const ext = (String(originalName || '').match(/\.[A-Za-z0-9]{1,6}$/) || [''])[0];
  const path = `${req.source_id}/${request_id}/${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`;
  const { error } = await supabase.storage.from(FILE_BUCKET).upload(path, buffer, { contentType: mimeType, upsert: false });
  if (error) throw new Error(`上傳失敗：${error.message}`);
  const { data, error: e2 } = await supabase.from('vendor_payment_files').insert([{
    request_id, file_type, file_name: String(originalName || '附件').slice(0, 200), file_url: `storage:${FILE_BUCKET}`,
    storage_path: path, file_size: buffer.length, mime_type: mimeType, uploaded_by_type: actorType || 'system',
  }]).select().single();
  if (e2) { await supabase.storage.from(FILE_BUCKET).remove([path]).catch(() => {}); throw new Error(e2.message); }
  return data;
}

/** 附件發 1 小時簽名網址（舊資料沒有 storage_path 的照原本 file_url） */
async function signFiles(files) {
  const withPath = files.filter((f) => f.storage_path);
  if (!withPath.length) return files;
  const { data } = await supabase.storage.from(FILE_BUCKET).createSignedUrls(withPath.map((f) => f.storage_path), 3600);
  const m = new Map((data || []).map((x) => [x.path, x.signedUrl]));
  return files.map((f) => (f.storage_path ? { ...f, url: m.get(f.storage_path) || null } : { ...f, url: /^https?:/.test(f.file_url || '') ? f.file_url : null }));
}

async function removeStoredFile(id) {
  const { data: f } = await supabase.from('vendor_payment_files').select('storage_path').eq('id', id).maybeSingle();
  if (f && f.storage_path) await supabase.storage.from(FILE_BUCKET).remove([f.storage_path]).catch(() => {});
}

/** 付款完成 → 照分配門市產生帳單（confirmed）＋分攤；列入月報月份＝請款月份＋付款日依截止日決定（bills.received_at＝付款時間） */
async function billFromAllocations(row) {
  if (!row || row.linked_bill_id) return row && row.linked_bill_id;
  const { data: al } = await supabase.from('vendor_payment_allocations').select('*').eq('request_id', row.id).order('seq');
  if (!al || !al.length) return null;
  const byStore = new Map();
  for (const a of al) {
    const cur = byStore.get(a.store_erpid) || { store_erpid: a.store_erpid, store_name: a.store_name, amount: 0, names: [] };
    cur.amount = r2(cur.amount + Number(a.amount));
    cur.names.push(`${a.item_name} ${Number(a.amount).toLocaleString()}`);
    byStore.set(a.store_erpid, cur);
  }
  const total = r2(al.reduce((s, a) => s + Number(a.amount), 0));
  const items = al.map((a, i) => ({ seq_no: i + 1, product_spec: a.item_name, quantity: 1, unit_price: Number(a.amount), total: Number(a.amount), store_erpid: a.store_erpid, store_name: a.store_name }));
  const paidAt = row.paid_at || new Date().toISOString();
  const { data: bill, error } = await supabase.from('bills').insert({
    source_id: row.source_id, period: row.period, title: row.title, total_amount: total, status: 'confirmed', items,
    description: `由廠商請款 ${row.request_no || row.id} 付款後自動建立`, source_ref: row.request_no,
    submitted_at: row.submitted_at || paidAt, confirmed_at: paidAt, received_at: paidAt, created_by_type: 'system', source_system: 'vendor_portal',
  }).select('id, bill_no').single();
  if (error) { console.error('[vendorPayment] 付款後建帳單失敗：', error.message); return null; }
  const { error: aErr } = await supabase.from('bill_allocations').insert([...byStore.values()].map((x) => ({
    bill_id: bill.id, store_erpid: x.store_erpid, store_name: x.store_name, allocated_amount: x.amount,
    allocation_note: `請款 ${row.request_no}：${x.names.join('、')}`.slice(0, 500),
  })));
  if (aErr) console.error('[vendorPayment] 付款後建分攤失敗：', aErr.message);
  await supabase.from('vendor_payment_requests').update({ linked_bill_id: bill.id }).eq('id', row.id);
  console.log(`[vendorPayment] ✅ ${row.request_no} 付款 → 帳單 ${bill.bill_no}，${byStore.size} 個門市`);
  return bill.id;
}

module.exports = {
  listTargets, saveAllocations, uploadRequestFile, signFiles, removeStoredFile, billFromAllocations,
  // 銀行帳號
  listBankAccounts, createBankAccount, updateBankAccount, deleteBankAccount,
  // 請款單
  listRequests, getRequest, createRequest, updateRequest, deleteRequest,
  submitRequest, approveRequest, rejectRequest, markPaid, setAccounting,
  // 附件
  addFile, deleteFile,
  // 發票
  addInvoice, updateInvoice, deleteInvoice,
  // 公司資料
  getCompanyProfile, upsertCompanyProfile,
  // 工具
  buildDefaultMemo,
};
