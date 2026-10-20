// services/vendorPayoutService.js —— 廠商請款排出款（2026-10-20，migration 028）
// 會計分配好、通過的請款 → 設出款日期＋出款銀行（公司哪個帳戶付）
// → 當天（含之前沒出的）列在「今日出款」、LINE 提醒（jobs/vendorPayoutNotify）
// → 依出款銀行匯出元大網銀 Excel（buildYuantaXlsx，跟原本批次同一格式）→ 銀行付完按「已出款」＝markPaid（自動進門市月報）。
const supabase = require('../config/supabase');
const { buildYuantaXlsx } = require('./paymentBatchService');
const vp = require('./vendorPaymentService');

const twToday = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' });
const isYmd = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s));
const digits = (s) => String(s == null ? '' : s).replace(/\D/g, '');

// ── 公司出款帳戶 ─────────────────────────────────────────
async function listBanks({ all = false } = {}) {
  let q = supabase.from('company_bank_accounts').select('*').order('sort').order('created_at');
  if (!all) q = q.eq('is_active', true);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return data || [];
}

async function saveBank(payload = {}, id = null) {
  const row = {};
  for (const k of ['label', 'bank_name', 'bank_code', 'branch_code', 'account_no', 'account_name', 'export_format', 'is_default', 'is_active', 'sort']) {
    if (payload[k] !== undefined) row[k] = typeof payload[k] === 'string' ? payload[k].trim() : payload[k];
  }
  if (row.bank_code !== undefined && !/^\d{3}$/.test(row.bank_code)) throw new Error('總行代碼要 3 碼數字（元大 806）');
  if (row.branch_code !== undefined && row.branch_code !== '' && row.branch_code !== null && !/^\d{4}$/.test(row.branch_code)) throw new Error('分行代碼要 4 碼數字');
  if (row.account_no !== undefined) { row.account_no = digits(row.account_no); if (row.account_no.length < 8) throw new Error('帳號至少 8 碼數字'); }
  if (!id) for (const k of ['label', 'bank_code', 'account_no', 'account_name']) if (!row[k]) throw new Error(`${k} 必填`);
  row.updated_at = new Date().toISOString();
  if (row.is_default) await supabase.from('company_bank_accounts').update({ is_default: false }).neq('id', id || '00000000-0000-0000-0000-000000000000');
  const q = id ? supabase.from('company_bank_accounts').update(row).eq('id', id) : supabase.from('company_bank_accounts').insert([row]);
  const { data, error } = await q.select().single();
  if (error) throw new Error(error.message);
  return data;
}

// ── 廠商收款帳戶：請款指定的 → 外部系統帶來的快照 → 廠商預設帳戶 ──
async function payeeMap(reqs) {
  const srcIds = [...new Set(reqs.filter(r => !r.bank_account).map(r => r.source_id).filter(Boolean))];
  const bySrc = {};
  if (srcIds.length) {
    const { data } = await supabase.from('vendor_bank_accounts').select('*').in('source_id', srcIds)
      .order('is_default', { ascending: false }).order('created_at');
    for (const b of data || []) if (!bySrc[b.source_id]) bySrc[b.source_id] = b;
  }
  const out = {};
  for (const r of reqs) {
    let p = null;
    if (r.bank_account) p = { ...r.bank_account, from: 'request' };
    else if (r.bank_snapshot && r.bank_snapshot.account_number) {
      const b = r.bank_snapshot;
      p = { bank_code: b.bank_code, branch_code: b.branch_code, account_no: b.account_number, account_name: b.account_holder_name, bank_name: b.bank_name, from: 'snapshot' };
    } else if (bySrc[r.source_id]) p = { ...bySrc[r.source_id], from: 'vendor_default' };
    if (p) {
      p.account_no = digits(p.account_no);
      p.problem = !p.account_no ? '沒有帳號' : !/^\d{3}$/.test(String(p.bank_code || '')) ? '總行代碼不是 3 碼' : !p.account_name ? '沒有戶名' : null;
    }
    out[r.id] = p;
  }
  return out;
}

async function allocSums(ids) {
  if (!ids.length) return {};
  const { data } = await supabase.from('vendor_payment_allocations').select('request_id, amount').in('request_id', ids);
  const m = {};
  for (const a of data || []) m[a.request_id] = (m[a.request_id] || 0) + Number(a.amount || 0);
  return m;
}

// ── 設定／取消出款日 ─────────────────────────────────────
async function setPayout(id, { payout_date, payout_bank_id } = {}, actor) {
  const { data: r, error } = await supabase.from('vendor_payment_requests').select('id, status, total_amount, request_no').eq('id', id).maybeSingle();
  if (error) throw new Error(error.message);
  if (!r) throw new Error('找不到請款');
  if (r.status !== 'approved') throw new Error('先按「通過」才能排出款日（目前：' + r.status + '）');
  if (!payout_date) {   // 取消排程
    const { data } = await supabase.from('vendor_payment_requests').update({ payout_date: null, payout_bank_id: null, payout_set_by: actor || null, payout_set_at: new Date().toISOString() }).eq('id', id).select().single();
    return data;
  }
  if (!isYmd(payout_date)) throw new Error('出款日期格式不對');
  if (payout_date < twToday()) throw new Error('出款日期不能早於今天');
  if (!payout_bank_id) throw new Error('請選出款銀行');
  const { data: bank } = await supabase.from('company_bank_accounts').select('id, is_active').eq('id', payout_bank_id).maybeSingle();
  if (!bank || !bank.is_active) throw new Error('出款銀行不存在或已停用');
  const sums = await allocSums([id]);
  if (sums[id] != null && Math.round(sums[id]) !== Math.round(Number(r.total_amount || 0))) {
    throw new Error(`分配合計 ${sums[id]} 跟請款金額 ${r.total_amount} 不一樣，先把分配調好`);
  }
  const { data, error: uErr } = await supabase.from('vendor_payment_requests').update({
    payout_date, payout_bank_id, payout_set_by: actor || null, payout_set_at: new Date().toISOString(),
  }).eq('id', id).eq('status', 'approved').select().single();
  if (uErr) throw new Error(uErr.message);
  return data;
}

const SEL = 'id, request_no, title, period, total_amount, status, source_id, payout_date, payout_bank_id, payout_exported_at, bank_snapshot, remit_memo, source:billing_sources(name, tax_id), bank_account:vendor_bank_accounts(*)';

// ── 某天要出的款（含之前排了還沒出的＝逾期）──────────────
async function day(date) {
  const d = isYmd(date) ? date : twToday();
  const { data, error } = await supabase.from('vendor_payment_requests').select(SEL)
    .eq('status', 'approved').not('payout_date', 'is', null).lte('payout_date', d).order('payout_date');
  if (error) throw new Error(error.message);
  const reqs = data || [];
  const payees = await payeeMap(reqs);
  const banks = await listBanks({ all: true });
  const bankById = Object.fromEntries(banks.map(b => [b.id, b]));
  const items = reqs.map(r => ({
    id: r.id, request_no: r.request_no, title: r.title, period: r.period,
    vendor: r.source?.name || null, amount: Number(r.total_amount || 0),
    payout_date: r.payout_date, overdue: r.payout_date < d, exported_at: r.payout_exported_at,
    bank_id: r.payout_bank_id, bank_label: bankById[r.payout_bank_id]?.label || '（沒選出款銀行）',
    payee: payees[r.id] ? { bank_code: payees[r.id].bank_code, branch_code: payees[r.id].branch_code, account_no_tail: String(payees[r.id].account_no || '').slice(-5), account_name: payees[r.id].account_name, from: payees[r.id].from, problem: payees[r.id].problem } : null,
  }));
  const groups = {};
  for (const it of items) {
    const g = groups[it.bank_id || 'none'] = groups[it.bank_id || 'none'] || { bank_id: it.bank_id, bank_label: it.bank_label, count: 0, amount: 0, overdue: 0, missing_payee: 0, exported: 0 };
    g.count++; g.amount += it.amount; if (it.overdue) g.overdue++;
    if (!it.payee || it.payee.problem) g.missing_payee++;
    if (it.exported_at) g.exported++;
  }
  return {
    date: d, total: items.length, amount: items.reduce((s, x) => s + x.amount, 0),
    today_count: items.filter(x => !x.overdue).length, overdue_count: items.filter(x => x.overdue).length,
    groups: Object.values(groups), items,
  };
}

// 之後幾天排了哪些（給行事曆／清單）
async function upcoming(days = 14) {
  const from = twToday();
  const to = new Date(Date.now() + days * 86400000).toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' });
  const { data, error } = await supabase.from('vendor_payment_requests').select('id, request_no, title, total_amount, payout_date, payout_bank_id, source:billing_sources(name)')
    .eq('status', 'approved').gt('payout_date', from).lte('payout_date', to).order('payout_date');
  if (error) throw new Error(error.message);
  return (data || []).map(r => ({ id: r.id, request_no: r.request_no, title: r.title, vendor: r.source?.name || null, amount: Number(r.total_amount || 0), payout_date: r.payout_date, bank_id: r.payout_bank_id }));
}

// 通過了但還沒排出款日
async function unscheduled() {
  const { data, error } = await supabase.from('vendor_payment_requests').select('id, request_no, title, total_amount, approved_at, source:billing_sources(name)')
    .eq('status', 'approved').is('payout_date', null).order('approved_at');
  if (error) throw new Error(error.message);
  return (data || []).map(r => ({ id: r.id, request_no: r.request_no, title: r.title, vendor: r.source?.name || null, amount: Number(r.total_amount || 0), approved_at: r.approved_at }));
}

// ── 匯出元大網銀 Excel ───────────────────────────────────
// 一個出款帳戶一個檔；付款日期＝這天（逾期的也用這天出）。廠商帳號有問題的不放進檔案、回 skipped。
async function exportYuanta({ date, bank_id, request_ids } = {}, actor) {
  const d = isYmd(date) ? date : twToday();
  if (!bank_id) throw new Error('請選出款銀行');
  const { data: bank } = await supabase.from('company_bank_accounts').select('*').eq('id', bank_id).maybeSingle();
  if (!bank) throw new Error('出款銀行不存在');
  if (bank.export_format !== 'yuanta') throw new Error('這個帳戶的匯出格式還沒做：' + bank.export_format);
  let q = supabase.from('vendor_payment_requests').select(SEL).eq('status', 'approved').eq('payout_bank_id', bank_id).lte('payout_date', d);
  if (Array.isArray(request_ids) && request_ids.length) q = q.in('id', request_ids);
  const { data, error } = await q.order('payout_date');
  if (error) throw new Error(error.message);
  const reqs = data || [];
  if (!reqs.length) throw new Error('這天這個帳戶沒有要出的款');
  const payees = await payeeMap(reqs);
  const ok = [], skipped = [];
  for (const r of reqs) {
    const p = payees[r.id];
    if (!p || p.problem) { skipped.push({ request_no: r.request_no, vendor: r.source?.name, reason: p ? p.problem : '廠商沒有收款帳號' }); continue; }
    ok.push({ r, p });
  }
  if (!ok.length) throw new Error('全部都缺廠商收款帳號：' + skipped.map(s => `${s.request_no}（${s.reason}）`).join('、'));
  const total = ok.reduce((s, x) => s + Number(x.r.total_amount || 0), 0);
  const buffer = buildYuantaXlsx({
    payment_date: d,
    payer_account_no: bank.account_no, payer_account_name: bank.account_name,
    payer_bank_code: bank.bank_code, payer_branch_code: bank.branch_code,
    items: ok.map(({ r, p }) => ({
      amount: Math.round(Number(r.total_amount || 0)),
      account_no: p.account_no, account_name: p.account_name,
      bank_code: p.bank_code, branch_code: p.branch_code || '',
      fee_burden_code: '15', notify_method: '0',
      memo: (r.remit_memo || r.request_no || '').slice(0, 30),
    })),
  });
  const ids = ok.map(x => x.r.id);
  const now = new Date().toISOString();
  await supabase.from('vendor_payment_requests').update({ payout_exported_at: now }).in('id', ids);
  await supabase.from('vendor_payout_exports').insert([{ payout_date: d, bank_id, request_ids: ids, total_amount: total, exported_by: actor || null }]);
  const filename = `廠商出款_${d.replace(/-/g, '')}_${bank.label}_${ok.length}筆.xlsx`;
  return { buffer, filename, count: ok.length, total, skipped };
}

// ── 銀行付完 → 標記已出款（＝markPaid，自動產生帳單進月報）──
async function markPaidMany(ids, actor) {
  if (!Array.isArray(ids) || !ids.length) throw new Error('請勾要標記的請款');
  const done = [], failed = [];
  for (const id of ids) {
    try { const r = await vp.markPaid(id, actor); done.push({ id, request_no: r.request_no, bill_id: r.linked_bill_id || null }); }
    catch (e) { failed.push({ id, error: e.message }); }
  }
  return { done, failed };
}

async function exportLog(limit = 50) {
  const { data, error } = await supabase.from('vendor_payout_exports').select('*').order('exported_at', { ascending: false }).limit(limit);
  if (error) throw new Error(error.message);
  return data || [];
}

module.exports = { twToday, listBanks, saveBank, setPayout, day, upcoming, unscheduled, exportYuanta, markPaidMany, exportLog, payeeMap };
