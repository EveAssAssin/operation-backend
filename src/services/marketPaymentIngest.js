// services/marketPaymentIngest.js
//
// 承接 market-backend 送過來的外部工務師請款事件，轉換成本地 vendor_payment_requests 的狀態變化。
// 對應規格：營運部_請款API規格.md §2.1
//
// 資料流：
//   POST /api/external/repair-payments/events (route)
//     → this.ingestEvent(body, idempotencyKey)
//         1. INSERT market_payment_events ON CONFLICT DO NOTHING（去重）
//            - 如果衝突（重複 idempotency_key）→ 回既有 operation_ref
//         2. 依 event 分派 handler:
//              requested → 建 vendor_payment_requests (status=submitted)
//              paid      → 更新 status=paid, paid_at
//              received  → 補一段 note，狀態不動
//              cancelled → status=rejected, rejection_reason
//         3. UPDATE market_payment_events.processed_at + operation_ref
//     → 回 { success, operation_ref }

const supabase = require('../config/supabase');
const { notifyOpsNewRequest } = require('./paymentNotifyOps');

// 全部外部工務師共用一筆 billing_sources；不為每個工務師建 source，避免污染
const EXTERNAL_ENGINEER_SOURCE_CODE = 'EXTERNAL_ENGINEER';
const EXTERNAL_ENGINEER_SOURCE_NAME = '外部工務師';

// ────────────────────────────────────────────────────────────
// 內部 helper
// ────────────────────────────────────────────────────────────

// 找或建那筆共用的「外部工務師」billing_source
async function ensureEngineerSource() {
  const { data: existing } = await supabase
    .from('billing_sources')
    .select('id')
    .eq('code', EXTERNAL_ENGINEER_SOURCE_CODE)
    .maybeSingle();
  if (existing) return existing.id;

  const { data: created, error } = await supabase
    .from('billing_sources')
    .insert({
      source_type: 'vendor',
      code:        EXTERNAL_ENGINEER_SOURCE_CODE,
      name:        EXTERNAL_ENGINEER_SOURCE_NAME,
      short_name:  '外部工務',
      notes:       '外部工務師個人請款共用單位（market 端事件轉換來）；請勿手動改動或刪除',
      is_active:   true,
    })
    .select('id')
    .single();
  if (error) throw new Error(`建立 EXTERNAL_ENGINEER billing_source 失敗：${error.message}`);
  return created.id;
}

// 從 ISO datetime 取 YYYY-MM
function periodFromIso(iso) {
  const d = iso ? new Date(iso) : new Date();
  if (isNaN(d.getTime())) return null;
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return `${d.getFullYear()}-${mm}`;
}

// 找已建立的 request（若有的話）
async function findRequestByMarketId(marketId) {
  const { data } = await supabase
    .from('vendor_payment_requests')
    .select('id, request_no, status, description')
    .eq('market_payment_request_id', marketId)
    .maybeSingle();
  return data || null;
}

// ────────────────────────────────────────────────────────────
// 4 個事件 handler：接完整 body，回傳 { operation_ref, note }
// ────────────────────────────────────────────────────────────

async function handleRequested(body) {
  if (!body.payment_request_id) throw new Error('缺少 payment_request_id');
  if (!body.engineer?.name)     throw new Error('缺少 engineer.name');

  // 已存在就回既有（idempotent，避免同 event 被人為手動重跑時建重複）
  const existing = await findRequestByMarketId(body.payment_request_id);
  if (existing) return { operation_ref: existing.request_no, reused: true };

  const source_id = await ensureEngineerSource();
  const period    = periodFromIso(body.requested_at) || periodFromIso(new Date().toISOString());
  const engineer  = body.engineer.name;

  // 兩相容 tickets shape：
  //   舊：body.tickets = { count, ids, numbers }              → 只有單號，無門市/金額
  //   新：body.tickets = [{ number, store_erpid, store_name, amount, ... }, ...]
  //       → approve 時會自動建 bills + bill_allocations
  let tickets = [];            // string 陣列（單號），存進 vendor_payment_requests.ticket_numbers
  let ticketDetails = null;    // 新 shape 才會有；存進 vendor_payment_requests.ticket_details
  if (Array.isArray(body.tickets)) {
    // 新 shape
    ticketDetails = body.tickets.map(t => ({
      number:      t.number || t.doc_number || null,
      store_erpid: t.store_erpid || null,
      store_name:  t.store_name  || null,
      amount:      Number(t.amount || 0),
      // 保留其他欄位供日後對照
      raw: t,
    }));
    tickets = ticketDetails.map(t => t.number).filter(Boolean);
  } else if (body.tickets && Array.isArray(body.tickets.numbers)) {
    // 舊 shape
    tickets = body.tickets.numbers;
  }
  const ticketStr = tickets.length ? tickets.join('、') : '(無)';

  const insertData = {
    source_id,
    period,
    title:         `${engineer} — 修繕請款（${tickets.length} 單）`,
    description:   [
      `外部工務師：${engineer}`,
      `修繕單號：${ticketStr}`,
      body.note ? `工務師備註：${body.note}` : null,
    ].filter(Boolean).join('\n'),
    total_amount:  Number(body.total_amount) || 0,
    status:        'submitted',                              // 從 market 進來的請款直接進入送審狀態
    submitted_at:  body.requested_at || new Date().toISOString(),
    remit_memo:    `${period.slice(-2)}-${engineer.slice(0, 4)}-修繕`,
    created_by_type: 'system',                               // 系統轉換來的
    // market 專屬欄位（036 migration 加的）
    source_system:             'market',
    market_payment_request_id: body.payment_request_id,
    engineer_name:             engineer,
    ticket_numbers:            tickets,
    ticket_details:            ticketDetails,   // 若新 shape 才有值
    bank_snapshot:             body.bank_info || null,
  };

  const { data, error } = await supabase
    .from('vendor_payment_requests')
    .insert(insertData)
    .select('id, request_no')
    .single();
  if (error) throw new Error(`vendor_payment_requests 建立失敗：${error.message}`);

  // 通知營運部主管 + 會計（fire-and-forget）
  notifyOpsNewRequest({
    source_system: 'market',
    external_id:   body.payment_request_id,
    request_no:    data.request_no,
    subject_label: '外部工務師',
    subject_name:  engineer,
    total_amount:  Number(body.total_amount) || 0,
    item_count:    tickets.length,
    period,
  }).catch(err => console.warn('[market ingest] notify failed:', err?.message));

  return { operation_ref: data.request_no };
}

async function handlePaid(body) {
  const req = await findRequestByMarketId(body.payment_request_id);
  if (!req) throw new Error(`找不到對應請款單（market_payment_request_id=${body.payment_request_id}）；可能 requested 事件未先進來`);

  const paidBy = body.paid_by_name ? `market 出款人：${body.paid_by_name}` : null;
  const newDescription = paidBy
    ? [req.description, paidBy].filter(Boolean).join('\n')
    : req.description;

  const { error } = await supabase
    .from('vendor_payment_requests')
    .update({
      status:      'paid',
      paid_at:     body.paid_at || new Date().toISOString(),
      description: newDescription,
    })
    .eq('id', req.id);
  if (error) throw new Error(`更新 paid 狀態失敗：${error.message}`);
  return { operation_ref: req.request_no };
}

async function handleReceived(body) {
  const req = await findRequestByMarketId(body.payment_request_id);
  if (!req) throw new Error(`找不到對應請款單（market_payment_request_id=${body.payment_request_id}）`);
  // received 不改狀態（狀態應已是 paid），只加一段 note
  const receivedAt = body.received_at || new Date().toISOString();
  const line = `工務師已於 ${receivedAt} 確認收款`;
  const newDescription = [req.description, line].filter(Boolean).join('\n');
  const { error } = await supabase
    .from('vendor_payment_requests')
    .update({ description: newDescription })
    .eq('id', req.id);
  if (error) throw new Error(`更新 received 註記失敗：${error.message}`);
  return { operation_ref: req.request_no };
}

async function handleCancelled(body) {
  const req = await findRequestByMarketId(body.payment_request_id);
  if (!req) throw new Error(`找不到對應請款單（market_payment_request_id=${body.payment_request_id}）`);
  if (req.status === 'paid') {
    throw new Error('此請款已標記為已撥款，無法自動取消，請人工處理');
  }
  const reason = body.cancel_reason || '工務師撤回請款';
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

// ────────────────────────────────────────────────────────────
// 主要入口 — 由 route 呼叫
// ────────────────────────────────────────────────────────────

/**
 * @param {object} body            request body（已 parse JSON）
 * @param {string} idempotencyKey  header "Idempotency-Key" 的值
 * @returns {Promise<{success:true, operation_ref?:string, reused?:boolean}>}
 */
async function ingestEvent(body, idempotencyKey) {
  if (!body || typeof body !== 'object')  throw new Error('body 必須是 JSON 物件');
  if (!body.event)                        throw new Error('缺少 event 欄位');
  if (!body.payment_request_id)           throw new Error('缺少 payment_request_id');
  if (!HANDLERS[body.event])              throw new Error(`未知的 event：${body.event}`);

  // 產生 idempotency_key（優先用 header，否則自組）
  const key = idempotencyKey || `${body.payment_request_id}:${body.event}`;

  // 1. 先寫 event log（用 ON CONFLICT DO NOTHING 擋重複）
  const { data: inserted, error: insertErr } = await supabase
    .from('market_payment_events')
    .insert({
      payment_request_id: body.payment_request_id,
      event:              body.event,
      idempotency_key:    key,
      raw_body:           body,
    })
    .select('id')
    .maybeSingle();

  if (insertErr) {
    // 唯一鍵衝突 → 這是重複投遞，回既有結果
    if (insertErr.code === '23505' || /duplicate key/i.test(insertErr.message)) {
      const { data: existing } = await supabase
        .from('market_payment_events')
        .select('operation_ref, processed_at, error_message')
        .eq('idempotency_key', key)
        .single();
      if (existing?.error_message) {
        throw new Error(`此事件先前處理失敗（idempotency retry）：${existing.error_message}`);
      }
      return { success: true, operation_ref: existing?.operation_ref || null, reused: true };
    }
    throw new Error(`寫入 market_payment_events 失敗：${insertErr.message}`);
  }
  const eventRowId = inserted.id;

  // 2. 執行對應 handler
  try {
    const result = await HANDLERS[body.event](body);

    // 3. 標記已處理 + 存 operation_ref
    await supabase
      .from('market_payment_events')
      .update({
        processed_at:  new Date().toISOString(),
        operation_ref: result.operation_ref || null,
      })
      .eq('id', eventRowId);

    return { success: true, operation_ref: result.operation_ref || null };
  } catch (err) {
    // handler 失敗 → 把 error 寫回 event log，讓 market 端下次重投可以重試
    await supabase
      .from('market_payment_events')
      .update({ error_message: String(err.message || err).slice(0, 500) })
      .eq('id', eventRowId);
    throw err;
  }
}

module.exports = {
  ingestEvent,
  // 對外 export 方便測試
  ensureEngineerSource,
  handleRequested,
  handlePaid,
  handleReceived,
  handleCancelled,
  EXTERNAL_ENGINEER_SOURCE_CODE,
};
