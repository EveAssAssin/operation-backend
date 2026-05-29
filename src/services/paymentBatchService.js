// services/paymentBatchService.js
// 匯款批次模組
//   - 列出「可加入批次」的請款（status=approved + 還沒在批次裡）
//   - 建立批次（自動帶 snapshot：銀行 / 戶名 / 附言）
//   - 產生元大網銀 xlsx 格式（V20130123 版）
//   - 標記已撥款（同步 vendor_payment_requests 狀態為 paid）
//   - 取消批次（釋放 requests 回 approved）

const XLSX     = require('xlsx');
const supabase = require('../config/supabase');

// ════════════════════════════════════════════════════════════
//                  列表 / 查詢
// ════════════════════════════════════════════════════════════

/** 列出所有批次 */
async function list({ status, payment_date_from, payment_date_to, limit = 200 } = {}) {
  let q = supabase.from('payment_batches')
    .select('*, creator:created_by(name)')
    .order('created_at', { ascending: false })
    .limit(Math.min(500, Number(limit) || 200));
  if (status)            q = q.eq('status', status);
  if (payment_date_from) q = q.gte('payment_date', payment_date_from);
  if (payment_date_to)   q = q.lte('payment_date', payment_date_to);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return data || [];
}

/** 單一批次（含明細） */
async function get(id) {
  const { data: batch, error } = await supabase.from('payment_batches')
    .select('*').eq('id', id).maybeSingle();
  if (error) throw new Error(error.message);
  if (!batch) throw new Error('找不到批次');

  const { data: items } = await supabase.from('payment_batch_items')
    .select('*, request:vendor_payment_requests(request_no, title, period)')
    .eq('batch_id', id).order('created_at', { ascending: true });
  batch.items = items || [];
  return batch;
}

/** 列「可加入批次」的請款（已通過 + 未撥款 + 未在批次中） */
async function listEligibleRequests({ period } = {}) {
  // 1) 撈所有 approved 請款
  let q = supabase.from('vendor_payment_requests')
    .select('id, request_no, period, title, total_amount, source_id, bank_account_id, remit_memo, approved_at, source:billing_sources(name, short_name), bank_account:vendor_bank_accounts(*)')
    .eq('status', 'approved')
    .order('approved_at', { ascending: true });
  if (period) q = q.eq('period', period);
  const { data, error } = await q;
  if (error) throw new Error(error.message);

  // 2) 撈已經在批次中的 request_id（preparing / exported / paid 都算）
  const { data: usedItems } = await supabase
    .from('payment_batch_items').select('request_id, batch:payment_batches(status)');
  const usedIds = new Set();
  for (const it of (usedItems || [])) {
    // cancelled 批次的 request 可以被重新使用
    if (it.batch?.status && it.batch.status !== 'cancelled') {
      usedIds.add(it.request_id);
    }
  }

  return (data || []).filter(r => !usedIds.has(r.id));
}


// ════════════════════════════════════════════════════════════
//                  建立批次
// ════════════════════════════════════════════════════════════

/**
 * 建立批次：勾選 request_ids，自動帶銀行資料 snapshot
 */
async function createBatch({ payment_date, request_ids, note }, actorId) {
  if (!payment_date) throw new Error('payment_date 必填');
  if (!Array.isArray(request_ids) || request_ids.length === 0) {
    throw new Error('request_ids 必填且不能為空');
  }

  // 1) 撈公司付款方資料
  const { data: profile } = await supabase.from('company_profile').select('*').eq('id', 1).maybeSingle();

  // 2) 撈所有 requests + 銀行 + 廠商
  const { data: requests, error: rErr } = await supabase
    .from('vendor_payment_requests')
    .select('*, source:billing_sources(name, tax_id), bank_account:vendor_bank_accounts(*)')
    .in('id', request_ids);
  if (rErr) throw new Error(rErr.message);
  if (!requests || requests.length !== request_ids.length) {
    throw new Error(`找不到部分請款，預期 ${request_ids.length} 筆，實際 ${requests?.length || 0} 筆`);
  }

  // 確保都是 approved
  for (const r of requests) {
    if (r.status !== 'approved') {
      throw new Error(`請款 ${r.request_no} 不是「已通過」狀態（目前：${r.status}）`);
    }
    if (!r.bank_account) {
      throw new Error(`請款 ${r.request_no} 沒有指定收款銀行帳號，請先設定`);
    }
  }

  const totalAmount = requests.reduce((s, r) => s + Number(r.total_amount || 0), 0);

  // 3) 建批次主檔
  const { data: batch, error: bErr } = await supabase.from('payment_batches').insert([{
    payment_date,
    payer_account_name: profile?.payer_account_name || null,
    payer_account_no:   profile?.payer_account_no   || null,
    payer_bank_code:    profile?.payer_bank_code    || null,
    payer_branch_code:  profile?.payer_branch_code  || null,
    total_amount:       totalAmount,
    total_items:        requests.length,
    status:             'preparing',
    note:               note || null,
    created_by:         actorId || null,
  }]).select().single();
  if (bErr) throw new Error(bErr.message);

  // 4) 建明細
  const itemRows = requests.map(r => ({
    batch_id:        batch.id,
    request_id:      r.id,
    bank_account_id: r.bank_account_id,
    source_id:       r.source_id,
    source_name:     r.source?.name || null,
    bank_code:       r.bank_account.bank_code,
    branch_code:     r.bank_account.branch_code,
    account_no:      r.bank_account.account_no,
    account_name:    r.bank_account.account_name,
    amount:          r.total_amount,
    memo:            r.remit_memo || null,
    fee_burden_code: profile?.default_fee_burden    || '15',
    notify_method:   profile?.default_notify_method || '0',
    id_type_code:    null,
    id_no:           null,
  }));
  const { error: iErr } = await supabase.from('payment_batch_items').insert(itemRows);
  if (iErr) {
    // 回滾
    await supabase.from('payment_batches').delete().eq('id', batch.id);
    throw new Error(iErr.message);
  }

  return get(batch.id);
}


// ════════════════════════════════════════════════════════════
//          產生元大網銀 xlsx（V20130123 版）
// ════════════════════════════════════════════════════════════

/**
 * 元大格式（從使用者提供的範本反推）：
 *   工作表 1：
 *     R3: 付款資料 header   ['', '付款日期', '付款帳號', '付款戶名', '付款總行', '付款分行', '逾時處理指示']
 *     R4: 付款資料 values
 *     R6: 收款資料 header   ['', '收款金額', '收款帳號', '收款戶名', '收款總行', '收款分行', '識別碼類別', '識別碼', '手續費負擔別', '通知方式', 'FAX', 'E-mail', 'FXML URL', '銷帳參考', '附言']
 *     R8 起：明細列
 */
function buildYuantaXlsx(batch) {
  const wb = XLSX.utils.book_new();

  // ── 工作表 1：完整批次資料 ────────────────────────────────
  const ws_data = [];
  // R1, R2 空
  ws_data.push([], []);
  // R3：付款資料 header
  ws_data.push(['', '付款日期', '付款帳號', '付款戶名', '付款總行', '付款分行', '逾時處理指示', '', '', '', '', '', '', '', 'V20130123版']);
  // R4：付款資料 values
  const paymentDateYmd = batch.payment_date.replace(/-/g, '');
  ws_data.push([
    '',
    paymentDateYmd,
    batch.payer_account_no || '',
    batch.payer_account_name || '',
    batch.payer_bank_code || '',
    batch.payer_branch_code || '',
    '1',
  ]);
  // R5 空
  ws_data.push([]);
  // R6：收款資料 header
  ws_data.push([
    '', '收款金額', '收款帳號', '收款戶名', '收款總行', '收款分行',
    '識別碼類別', '識別碼', '手續費負擔別', '通知方式',
    'FAX傳真號碼', 'E-mail Address', 'FXML URL', '銷帳參考資料', '附言',
  ]);
  // R7：範本資料（勿刪除）— 元大要求保留
  ws_data.push([
    '', 38, '00000000000001', '王大明', '806', '0998', '53', 'A123456789', '15', '0', '', '', '', '', '範本資料，勿刪除！',
  ]);
  // R8 起：實際明細
  for (const it of (batch.items || [])) {
    ws_data.push([
      '',
      Number(it.amount),
      it.account_no || '',
      it.account_name || '',
      it.bank_code || '',
      it.branch_code || '',
      it.id_type_code || '',
      it.id_no || '',
      it.fee_burden_code || '15',
      it.notify_method || '0',
      '', '', '', '',
      it.memo || '',
    ]);
  }
  ws_data[7] = ws_data[7] || [];
  // 在 R8 第一欄加 "開始=＞" 標記（仿你範本）
  if (ws_data[7] && ws_data[7].length > 0) ws_data[7][0] = '開始=＞';

  const ws = XLSX.utils.aoa_to_sheet(ws_data);
  // 設定欄寬（讓欄位看起來像範本）
  ws['!cols'] = [
    { wch: 10 }, { wch: 15 }, { wch: 18 }, { wch: 22 }, { wch: 8 }, { wch: 8 },
    { wch: 10 }, { wch: 14 }, { wch: 12 }, { wch: 10 }, { wch: 14 }, { wch: 18 },
    { wch: 14 }, { wch: 16 }, { wch: 20 },
  ];

  XLSX.utils.book_append_sheet(wb, ws, '工作表1');

  // 產 buffer
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}


/** 匯出 xlsx → 標記 batch 為 exported */
async function exportBatch(id, actorId) {
  const batch = await get(id);
  if (batch.status === 'paid' || batch.status === 'cancelled') {
    throw new Error(`狀態為 ${batch.status}，不能再匯出`);
  }
  const buffer = buildYuantaXlsx(batch);

  // 更新 batch
  await supabase.from('payment_batches').update({
    status:      'exported',
    exported_at: new Date().toISOString(),
    exported_by: actorId || null,
  }).eq('id', id);

  return { buffer, filename: `${batch.batch_no}_元大匯款.xlsx`, batch };
}


// ════════════════════════════════════════════════════════════
//                  狀態變更
// ════════════════════════════════════════════════════════════

/** 標記批次「已撥款」→ 同步把所有 requests 設為 paid */
async function markBatchPaid(id, actorId) {
  const batch = await get(id);
  if (batch.status === 'paid')      throw new Error('已是已撥款狀態');
  if (batch.status === 'cancelled') throw new Error('已取消批次不能標記撥款');

  // 更新 batch
  const { error: bErr } = await supabase.from('payment_batches').update({
    status:  'paid',
    paid_at: new Date().toISOString(),
    paid_by: actorId || null,
  }).eq('id', id);
  if (bErr) throw new Error(bErr.message);

  // 同步所有 requests 設為 paid
  const requestIds = (batch.items || []).map(it => it.request_id);
  if (requestIds.length > 0) {
    await supabase.from('vendor_payment_requests').update({
      status:  'paid',
      paid_at: new Date().toISOString(),
      paid_by: actorId || null,
    }).in('id', requestIds).eq('status', 'approved');
  }

  return get(id);
}

/** 取消批次（preparing / exported 狀態可取消，已撥款不行）→ 釋放 requests */
async function cancelBatch(id, reason, actorId) {
  const batch = await get(id);
  if (batch.status === 'paid')      throw new Error('已撥款的批次不能取消');
  if (batch.status === 'cancelled') throw new Error('已是取消狀態');

  await supabase.from('payment_batches').update({
    status:           'cancelled',
    cancelled_at:     new Date().toISOString(),
    cancelled_by:     actorId || null,
    cancelled_reason: reason || null,
  }).eq('id', id);

  return get(id);
}


// ════════════════════════════════════════════════════════════
//                  進項發票匯出（CSV）
// ════════════════════════════════════════════════════════════

/** 取指定月份的進項發票（is_input_tax_eligible=true）*/
async function listInputInvoices(period) {
  if (!period || !/^\d{4}-\d{2}$/.test(period)) throw new Error('period 格式必須是 YYYY-MM');

  // 撈該月發票 join 請款 join 廠商
  const monthStart = `${period}-01`;
  const [year, mon] = period.split('-').map(Number);
  const nextMon = mon === 12 ? `${year + 1}-01` : `${year}-${String(mon + 1).padStart(2, '0')}`;
  const monthEnd   = `${nextMon}-01`;

  const { data, error } = await supabase.from('vendor_invoices')
    .select(`
      id, invoice_no, invoice_date, vendor_tax_id, buyer_tax_id,
      amount, pre_tax_amount, tax_amount, tax_type, is_input_tax_eligible,
      request:vendor_payment_requests(request_no, period, source_id, source:billing_sources(name, short_name))
    `)
    .gte('invoice_date', monthStart).lt('invoice_date', monthEnd)
    .eq('is_input_tax_eligible', true)
    .order('invoice_date', { ascending: true });
  if (error) throw new Error(error.message);
  return data || [];
}

/** 匯出進項發票為 CSV（給財務上傳） */
async function exportInputInvoicesCsv(period, actorId) {
  const rows = await listInputInvoices(period);

  // 紀錄
  const totalAmount = rows.reduce((s, r) => s + Number(r.amount || 0), 0);
  await supabase.from('input_invoice_export_log').insert([{
    period,
    invoice_count: rows.length,
    total_amount:  totalAmount,
    exported_by:   actorId || null,
  }]);

  // 組 CSV（加 BOM 讓 Excel 開啟不亂碼）
  const BOM = '﻿';
  const header = ['發票日期', '發票號碼', '廠商', '開立統編', '買方統編', '未稅', '稅額', '含稅', '稅別', '請款單號'];
  const lines = [header.join(',')];
  for (const r of rows) {
    lines.push([
      r.invoice_date || '',
      `"${r.invoice_no}"`,
      `"${r.request?.source?.name || ''}"`,
      r.vendor_tax_id || '',
      r.buyer_tax_id || '',
      r.pre_tax_amount != null ? Number(r.pre_tax_amount) : '',
      r.tax_amount     != null ? Number(r.tax_amount)     : '',
      Number(r.amount),
      r.tax_type || '',
      r.request?.request_no || '',
    ].join(','));
  }
  return {
    buffer:   Buffer.from(BOM + lines.join('\n'), 'utf8'),
    filename: `進項發票_${period}.csv`,
    count:    rows.length,
    total_amount: totalAmount,
  };
}


// ════════════════════════════════════════════════════════════
//                  匯出歷史
// ════════════════════════════════════════════════════════════
async function listExportLog({ limit = 100 } = {}) {
  const { data, error } = await supabase.from('input_invoice_export_log')
    .select('*, exporter:exported_by(name)')
    .order('exported_at', { ascending: false })
    .limit(Math.min(500, Number(limit) || 100));
  if (error) throw new Error(error.message);
  return data || [];
}


module.exports = {
  // 批次
  list, get, listEligibleRequests, createBatch,
  exportBatch, markBatchPaid, cancelBatch,
  // 進項發票
  listInputInvoices, exportInputInvoicesCsv, listExportLog,
};
