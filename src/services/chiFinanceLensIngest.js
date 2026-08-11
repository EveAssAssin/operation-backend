// services/chiFinanceLensIngest.js
//
// 承接 chi-finance-lens（路奇天格鏡片）送過來的請款事件，
// 轉換成本地 vendor_payment_requests 的狀態變化。
// 架構完全 mirror marketPaymentIngest.js，只是：
//   - 事件 log 表：chi_lens_payment_events
//   - source_system = 'chi_lens'
//   - 按 vendor_code 對應到 billing_sources（每個 chi vendor 一筆 source）
//   - subject_label = '路奇天格'
//
// 對應規格：outputs/operation_chi_lens_請款整合文件.md（給 chi-lens 團隊）

const supabase = require('../config/supabase');
const { notifyOpsNewRequest } = require('./paymentNotifyOps');

// ─────────────────────────────────────────────────
//  chi_vendors code → billing_source（每個廠商一筆）
// ─────────────────────────────────────────────────
async function ensureChiLensVendorSource(vendorCode, vendorNameHint = null) {
  const code = String(vendorCode || '').trim();
  if (!code) throw new Error('缺少 vendor_code');

  // 先看 billing_sources 是否已存在
  const sourceCode = `CHI_LENS_${code}`;
  const { data: existing } = await supabase
    .from('billing_sources')
    .select('id, name')
    .eq('code', sourceCode)
    .maybeSingle();
  if (existing) return { source_id: existing.id, name: existing.name };

  // 不存在 → 從 chi_vendors 撈中文名，沒有就用 hint 或 code
  let name = vendorNameHint;
  if (!name) {
    const { data: cv } = await supabase
      .from('chi_vendors')
      .select('name').eq('code', code).maybeSingle();
    name = cv?.name || code;
  }

  const { data: created, error } = await supabase
    .from('billing_sources')
    .insert({
      source_type: 'vendor',
      code:        sourceCode,
      name:        `${name}（路奇天格）`,
      short_name:  name.slice(0, 6),
      notes:       `路奇天格鏡片廠商 code=${code}，由 chi-lens 事件自動建立`,
      is_active:   true,
    })
    .select('id, name')
    .single();
  if (error) throw new Error(`建立 CHI_LENS billing_source 失敗：${error.message}`);
  return { source_id: created.id, name: created.name };
}

// ─────────────────────────────────────────────────
//  helper
// ─────────────────────────────────────────────────
async function lookupStoreErpidByName(branchName) {
  if (!branchName) return null;
  const { data } = await supabase
    .from('departments')
    .select('store_erpid')
    .eq('store_name', branchName)
    .maybeSingle();
  return data?.store_erpid || null;
}

function periodFromIso(iso) {
  const d = iso ? new Date(iso) : new Date();
  if (isNaN(d.getTime())) return null;
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return `${d.getFullYear()}-${mm}`;
}

async function findRequestByChiId(chiId) {
  const { data } = await supabase
    .from('vendor_payment_requests')
    .select('id, request_no, status, description, source_system, vendor_code')
    .eq('source_system', 'chi_lens')
    // 路奇的 pr id 存在 market_payment_request_id 欄位（複用 UUID 欄位）
    // 若 chi-lens 帶的 id 不是 UUID 型，會失敗；因此我們同時支援 description 內內嵌 id
    // 這裡以 market_payment_request_id 為主鍵；chi-lens 端請也回傳 UUID
    .eq('market_payment_request_id', chiId)
    .maybeSingle();
  return data || null;
}

// ─────────────────────────────────────────────────
//  4 個事件 handler
// ─────────────────────────────────────────────────
async function handleRequested(body) {
  if (!body.payment_request_id) throw new Error('缺少 payment_request_id');

  const existing = await findRequestByChiId(body.payment_request_id);
  if (existing) return { operation_ref: existing.request_no, reused: true };

  // ── 兩相容 shape ─────────────────────────────────────────
  //   新（推薦）：body.details = { completions:[...], returns:[...] }
  //     每筆有 seq_no, item_date, customer_order, branch_name, lohas_erp_id,
  //     doc_number, product_spec, quantity, client_unit_price, client_total, vendor
  //   舊：body.items.descriptions = ["...", "..."]
  let ticketDetails = [];   // 統一 shape 存 vendor_payment_requests.ticket_details
  let totalFromDetails = 0;
  const vendorsSeen = new Set();
  let hasNewShape = false;

  const details = body.details;
  if (details && (Array.isArray(details.completions) || Array.isArray(details.returns))) {
    hasNewShape = true;
    const completions = details.completions || [];
    const returnRows  = details.returns     || [];

    for (const row of completions) {
      const amt = Number(row.client_total || 0);
      totalFromDetails += amt;
      if (row.vendor) vendorsSeen.add(row.vendor);
      ticketDetails.push({
        type:        'completion',
        number:      row.doc_number || null,
        store_erpid: row.lohas_erp_id || null,     // 稍後補 branch_name lookup
        store_name:  row.branch_name  || null,
        amount:      amt,
        item_date:   row.item_date || null,
        description: row.product_spec || null,     // maybeCreateLinkedBill 會轉成 product_spec 或 fallback description
        raw:         row,                          // 原始 chi-lens 完整欄位保留給 bills.items 用
      });
    }
    for (const row of returnRows) {
      const amt = Number(row.client_total || 0);
      totalFromDetails -= amt;
      if (row.vendor) vendorsSeen.add(row.vendor);
      ticketDetails.push({
        type:        'return',
        number:      row.doc_number || null,
        store_erpid: row.lohas_erp_id || null,
        store_name:  row.branch_name  || null,
        amount:      -amt,                         // 負值：讓後續 aggregate by store 直接扣掉
        item_date:   row.item_date || null,
        description: row.product_spec || null,
        raw:         row,
      });
    }
    // 若某些 row 沒 lohas_erp_id → 用 branch_name 查 departments 補上
    for (const t2 of ticketDetails) {
      if (!t2.store_erpid && t2.store_name) {
        t2.store_erpid = await lookupStoreErpidByName(t2.store_name);
      }
    }
  }

  // ── vendor_code 決定 billing_source ───────────────────
  //   1. 優先 body.vendor_code（top-level）
  //   2. 沒有時從 details 內 vendor 推斷；多 vendor → 用 'MIXED'
  let vendorCode = body.vendor_code;
  if (!vendorCode) {
    if      (vendorsSeen.size === 1) vendorCode = Array.from(vendorsSeen)[0];
    else if (vendorsSeen.size > 1)   vendorCode = 'MIXED';
    else throw new Error('缺少 vendor_code 且 details 內沒有 vendor');
  }

  const { source_id, name: sourceName } =
    await ensureChiLensVendorSource(vendorCode, body.vendor_name);

  const period = body.period || periodFromIso(body.requested_at) || periodFromIso(new Date().toISOString());
  const totalAmount = Number(body.total_amount) || totalFromDetails || 0;

  // 舊 shape 的 description fallback
  let oldItemsStr = '';
  if (!hasNewShape) {
    const items = body.items?.descriptions || [];
    oldItemsStr = items.length ? items.slice(0, 5).join('、') + (items.length > 5 ? '…' : '') : '(無明細)';
  }
  const detailCount = hasNewShape
    ? { completion: (details.completions || []).length, return: (details.returns || []).length }
    : null;

  const insertData = {
    source_id,
    period,
    title: hasNewShape
      ? `${sourceName} — 鏡片款（完成 ${detailCount.completion}／退回 ${detailCount.return}）`
      : `${sourceName} — 鏡片款`,
    description: [
      `路奇天格廠商：${sourceName}（code=${vendorCode}${vendorsSeen.size > 1 ? '，含多 vendor：' + Array.from(vendorsSeen).join(',') : ''}）`,
      hasNewShape
        ? `明細：完成 ${detailCount.completion} 筆／退回 ${detailCount.return} 筆（合計 NT$${totalFromDetails.toLocaleString()}）`
        : `明細：${oldItemsStr}`,
      body.note ? `備註：${body.note}` : null,
    ].filter(Boolean).join('\n'),
    total_amount:  totalAmount,
    status:        'submitted',
    submitted_at:  body.requested_at || new Date().toISOString(),
    remit_memo:    `${period.slice(-2)}-${sourceName.slice(0, 4)}-鏡片`,
    created_by_type: 'system',
    source_system:             'chi_lens',
    market_payment_request_id: body.payment_request_id,   // 複用此欄位存 chi-lens 端 UUID
    vendor_code:               vendorCode,
    bank_snapshot:             body.bank_info || null,
    ticket_details:            hasNewShape ? ticketDetails : null,
  };

  const { data, error } = await supabase
    .from('vendor_payment_requests')
    .insert(insertData)
    .select('id, request_no')
    .single();
  if (error) throw new Error(`vendor_payment_requests 建立失敗：${error.message}`);

  // 通知
  notifyOpsNewRequest({
    source_system: 'chi_lens',
    external_id:   body.payment_request_id,
    request_no:    data.request_no,
    subject_label: '路奇天格',
    subject_name:  sourceName,
    total_amount:  totalAmount,
    item_count:    hasNewShape ? ticketDetails.length : (body.items?.descriptions?.length || 0),
    period,
  }).catch(err => console.warn('[chi-lens ingest] notify failed:', err?.message));

  return { operation_ref: data.request_no };
}

async function handlePaid(body) {
  const req = await findRequestByChiId(body.payment_request_id);
  if (!req) throw new Error(`找不到對應請款單（chi_lens payment_request_id=${body.payment_request_id}）`);
  const paidBy = body.paid_by_name ? `chi-lens 出款人：${body.paid_by_name}` : null;
  const newDescription = paidBy ? [req.description, paidBy].filter(Boolean).join('\n') : req.description;
  const { error } = await supabase
    .from('vendor_payment_requests')
    .update({ status: 'paid', paid_at: body.paid_at || new Date().toISOString(), description: newDescription })
    .eq('id', req.id);
  if (error) throw new Error(`更新 paid 狀態失敗：${error.message}`);
  return { operation_ref: req.request_no };
}

async function handleReceived(body) {
  const req = await findRequestByChiId(body.payment_request_id);
  if (!req) throw new Error(`找不到對應請款單（chi_lens payment_request_id=${body.payment_request_id}）`);
  const receivedAt = body.received_at || new Date().toISOString();
  const line = `路奇端已於 ${receivedAt} 確認收款`;
  const newDescription = [req.description, line].filter(Boolean).join('\n');
  const { error } = await supabase
    .from('vendor_payment_requests').update({ description: newDescription }).eq('id', req.id);
  if (error) throw new Error(`更新 received 註記失敗：${error.message}`);
  return { operation_ref: req.request_no };
}

async function handleCancelled(body) {
  const req = await findRequestByChiId(body.payment_request_id);
  if (!req) throw new Error(`找不到對應請款單（chi_lens payment_request_id=${body.payment_request_id}）`);
  if (req.status === 'paid') throw new Error('此請款已標記為已撥款，無法自動取消，請人工處理');
  const reason = body.cancel_reason || '路奇端撤回請款';
  const { error } = await supabase
    .from('vendor_payment_requests')
    .update({
      status:           'rejected',
      rejected_at:      body.cancelled_at || new Date().toISOString(),
      rejection_reason: reason,
    })
    .eq('id', req.id);
  if (error) throw new Error(`更新 cancelled 狀態失敗：${error.message}`);
  return { operation_ref: req.request_no };
}

const HANDLERS = {
  requested: handleRequested,
  paid:      handlePaid,
  received:  handleReceived,
  cancelled: handleCancelled,
};

// ─────────────────────────────────────────────────
//  主入口
// ─────────────────────────────────────────────────
async function ingestEvent(body, idempotencyKey) {
  if (!body || typeof body !== 'object')  throw new Error('body 必須是 JSON 物件');
  if (!body.event)                        throw new Error('缺少 event 欄位');
  if (!body.payment_request_id)           throw new Error('缺少 payment_request_id');
  if (!HANDLERS[body.event])              throw new Error(`未知的 event：${body.event}`);

  const key = idempotencyKey || `${body.payment_request_id}:${body.event}`;

  const { data: inserted, error: insertErr } = await supabase
    .from('chi_lens_payment_events')
    .insert({
      payment_request_id: body.payment_request_id,
      event:              body.event,
      idempotency_key:    key,
      raw_body:           body,
    })
    .select('id')
    .maybeSingle();

  if (insertErr) {
    if (insertErr.code === '23505' || /duplicate key/i.test(insertErr.message)) {
      const { data: existing } = await supabase
        .from('chi_lens_payment_events')
        .select('operation_ref, processed_at, error_message')
        .eq('idempotency_key', key)
        .single();
      if (existing?.error_message) {
        throw new Error(`此事件先前處理失敗（idempotency retry）：${existing.error_message}`);
      }
      return { success: true, operation_ref: existing?.operation_ref || null, reused: true };
    }
    throw new Error(`寫入 chi_lens_payment_events 失敗：${insertErr.message}`);
  }
  const eventRowId = inserted.id;

  try {
    const result = await HANDLERS[body.event](body);
    await supabase
      .from('chi_lens_payment_events')
      .update({ processed_at: new Date().toISOString(), operation_ref: result.operation_ref || null })
      .eq('id', eventRowId);
    return { success: true, operation_ref: result.operation_ref || null };
  } catch (err) {
    await supabase
      .from('chi_lens_payment_events')
      .update({ error_message: String(err.message || err).slice(0, 500) })
      .eq('id', eventRowId);
    throw err;
  }
}

module.exports = {
  ingestEvent,
  ensureChiLensVendorSource,
  handleRequested,
  handlePaid,
  handleReceived,
  handleCancelled,
};
