// services/reportAi.js —— 月報 AI（2026-11-09）
// 大腦在樂維斯（LAVIS 職務 acct）；這裡：組「選取門市＋月份」的系統現況 → 呼叫 → 存對話 → AI 開的動作單存 report_ai_orders（pending）
// 會計按「確認執行」→ apply()：照 kind 寫帳本（跟 /api/ledger 同一套規則：關帳擋、會計科目必選、同店同月同科目同廠商覆蓋…），全部留紀錄。
const supabase = require('../config/supabase');
const MR = require('./monthlyReport');
const MA = require('./monthlyAudit');
const LS = require('./ledgerSubjects');
const LAVIS_URL = (process.env.LAVIS_URL || 'https://jarvis-backend-94d6.onrender.com').replace(/\/$/, '');
const LAVIS_KEY = process.env.LAVIS_AGENT_KEY || '';
const YM = /^\d{4}-(0[1-9]|1[0-2])$/;
const E = (status, message) => Object.assign(new Error(message), { status });
const addYm = (ym, k) => { const [y, m] = ym.split('-').map(Number); return new Date(Date.UTC(y, m - 1 + k, 1)).toISOString().slice(0, 7); };
const r0 = (n) => Math.round(Number(n) || 0);

async function closed(store, ym) { const { data } = await supabase.from('store_month_reports').select('status').eq('store_erpid', store).eq('ym', ym).maybeSingle(); return data && data.status === 'closed'; }
async function storeList() { const { data } = await supabase.from('departments').select('store_erpid, store_name, report_kind').eq('is_active', true).order('store_name'); return (data || []).map((d) => ({ erpid: d.store_erpid, name: d.store_name, kind: d.report_kind })); }

/** 一家店月報的精簡摘要（給 AI 看的；完整版用 get_store_report 工具） */
function summarize(r) {
  if (!r || r.error) return r;
  const groups = [...(r.left || []), ...(r.right || [])].map((g) => ({ group: g.group, name: g.name, total: r0(g.total), rows: (g.rows || []).filter((x) => x.amount).map((x) => ({ code: x.code, name: x.name, amount: r0(x.amount), from: x.from || null, n: (x.lines || []).length || undefined })) }));
  return { store: r.store, store_name: r.store_name, ym: r.ym, status: r.status, totals: { total_in: r0(r.totals.total_in), sales_total: r.totals.sales_total == null ? null : r0(r.totals.sales_total), receipt_total: r.totals.receipt_total == null ? null : r0(r.totals.receipt_total), total_out: r0(r.totals.total_out), profit: r0(r.totals.profit), ratio: r.totals.ratio }, gap: r.gap, groups, dividend: r.dividend ? { marketing_fund: r.dividend.marketing_fund, depreciation: r.dividend.depreciation, retained: r.dividend.retained, distributable: r.dividend.distributable } : null, warnings: (r.warnings || []).slice(0, 8) };
}

async function context({ stores, ym }) {
  const all = await storeList();
  const sel = (stores || []).map(String).filter((s) => all.some((a) => a.erpid === s)).slice(0, 8);
  const [accs, subs] = await Promise.all([supabase.from('ledger_accounts').select('code, name, group_code, kind').eq('is_active', true).order('sort_order'), LS.all()]);
  const reports = []; let audit = null;
  if (ym && YM.test(ym) && sel.length) {
    for (const s of sel) { try { reports.push(summarize(await MR.build(ym, s))); } catch (e) { reports.push({ store: s, error: e.message }); } }
    try { const a = await MA.audit(ym); audit = { counts: a.counts, findings: a.findings.filter((f) => sel.includes(f.store) || f.store === '*').map((f) => ({ store: f.store, store_name: f.store_name, sev: f.sev, key: f.key, title: f.title, detail: f.detail ? String(f.detail).slice(0, 200) : null, amount: f.amount, ack: f.ack ? f.ack.status : null })).slice(0, 40) }; } catch (e) { audit = { error: e.message }; }
  }
  return { stores: all.filter((a) => sel.includes(a.erpid)), ym: ym || null, all_stores: all, accounts: accs.data || [], subjects: (subs || []).filter((s) => s.is_active !== false).map((s) => ({ id: s.id, name: s.name, ledger_code: s.ledger_code, is_default: s.is_default })), reports, audit };
}

async function chat({ user, chatId, stores, ym, message }) {
  if (!LAVIS_KEY) throw E(500, '還沒設定樂維斯金鑰（LAVIS_AGENT_KEY）');
  const app = String(user.member_id || user.app_number);
  let chatRow = null;
  if (chatId) { const { data } = await supabase.from('report_ai_chats').select('*').eq('id', chatId).eq('app_number', app).maybeSingle(); chatRow = data; }
  if (!chatRow) { const { data, error } = await supabase.from('report_ai_chats').insert({ app_number: app, title: String(message).slice(0, 40), stores: stores || [], ym: ym || null, messages: [] }).select('*').single(); if (error) throw new Error(error.message); chatRow = data; }
  const history = (chatRow.messages || []).map((m) => ({ role: m.role, content: m.content }));
  const ctx = await context({ stores, ym });
  const r = await fetch(`${LAVIS_URL}/api/agents/acct/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-agent-key': LAVIS_KEY }, body: JSON.stringify({ asker: { app, name: user.name, role: user.role }, context: ctx, history, message }), signal: AbortSignal.timeout(300000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.success === false) throw E(502, '月報 AI：' + (j.message || r.status));
  if (j.off) throw E(503, '月報 AI 目前停用');
  const orders = []; const messages = []; const needs = [];
  for (const a of j.actions || []) {
    if (a.type === 'order') { const { data } = await supabase.from('report_ai_orders').insert({ chat_id: chatRow.id, run_id: j.run_id || null, kind: a.kind, payload: a.payload, summary: a.summary, reason: a.reason, stores: stores || [], ym: ym || null }).select('*').single(); if (data) orders.push(data); }
    else if (a.type === 'message') messages.push(a);
    else if (a.type === 'dev_need') { const { data } = await supabase.from('report_ai_dev_needs').insert({ chat_id: chatRow.id, title: a.title, text: a.text, by_app: app }).select('*').single(); if (data) needs.push(data); }
  }
  const msgs = [...(chatRow.messages || []), { role: 'user', content: message, at: new Date().toISOString(), stores, ym }, { role: 'assistant', content: j.reply, at: new Date().toISOString(), orders: orders.map((o) => o.id), drafts: messages, run_id: j.run_id, queries: (j.queries || []).length }].slice(-60);
  await supabase.from('report_ai_chats').update({ messages: msgs, stores: stores || chatRow.stores, ym: ym || chatRow.ym, updated_at: new Date().toISOString() }).eq('id', chatRow.id);
  return { chat_id: chatRow.id, reply: j.reply, orders, drafts: messages, dev_needs: needs, run_id: j.run_id, queries: j.queries || [] };
}

// ── 套用動作單 ──
async function applyPost(p, by) {
  const out = [];
  for (const e of p.entries || []) {
    const store = String(e.store || ''), ym = String(e.ym || ''), code = String(e.ledger_code || ''); const type = e.entry_type === 'adjust' ? 'adjust' : 'value';
    try {
      if (!store || !YM.test(ym) || !code) throw new Error('缺門市／月份／科目');
      const amount = Number(e.amount); if (!Number.isFinite(amount)) throw new Error('金額不對');
      if (type === 'adjust' && !String(e.reason || '').trim()) throw new Error('調帳要寫原因');
      if (await closed(store, ym)) throw new Error(`${ym} 已關帳`);
      const vendor = String(e.vendor || '').trim() || null;
      let subjectId = null; if (await LS.needsSubject(code)) subjectId = (await LS.mustGet(e.subject_id, code)).id;
      if (type === 'value') { let q = supabase.from('ledger_manual_entries').update({ void_at: new Date().toISOString(), void_by: by }).eq('store_erpid', store).eq('report_ym', ym).eq('ledger_code', code).eq('entry_type', 'value').is('void_at', null); q = vendor ? q.eq('vendor', vendor) : q.is('vendor', null); await q; }
      const { data, error } = await supabase.from('ledger_manual_entries').insert({ entry_type: type, store_erpid: store, report_ym: ym, fee_ym: e.fee_ym && YM.test(String(e.fee_ym)) ? e.fee_ym : null, ledger_code: code, amount, vendor, reason: e.reason ? String(e.reason).slice(0, 500) : 'AI 動作單', files: [], created_by: by, subject_id: subjectId }).select('id').single();
      if (error) throw error; out.push({ store, ym, ok: true, id: data.id, amount });
    } catch (err) { out.push({ store, ym, error: err.message }); }
  }
  return out;
}
async function applyAmortize(p, by) {
  const out = [];
  for (const it of p.items || []) {
    try {
      const subj = await LS.mustGet(it.subject_id, it.ledger_code || null);
      const store = String(it.store || ''), code = subj.ledger_code, from = String(it.from_ym || ''); const total = Math.round(Number(it.total)), n = Math.floor(Number(it.months));
      if (!store || !YM.test(from)) throw new Error('缺門市／起始月份'); if (!Number.isFinite(total) || total === 0) throw new Error('總金額不對'); if (!(n >= 2 && n <= 60)) throw new Error('分攤月數要 2～60');
      const yms = Array.from({ length: n }, (_, k) => addYm(from, k));
      const { data: cl } = await supabase.from('store_month_reports').select('ym').eq('store_erpid', store).in('ym', yms).eq('status', 'closed');
      if ((cl || []).length) throw new Error(`${cl.map((x) => x.ym).join('、')} 已關帳`);
      const each = Math.trunc(total / n), last = total - each * (n - 1); const group = `am_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      const rows = yms.map((ym, k) => ({ entry_type: 'amort', store_erpid: store, report_ym: ym, fee_ym: ym, ledger_code: code, amount: k === n - 1 ? last : each, vendor: String(it.vendor || '').trim() || null, reason: `分攤 ${k + 1}/${n}（總額 ${total.toLocaleString()}）：${p.reason || 'AI 動作單'}`, files: [], created_by: by, amort_group: group, amort_seq: k + 1, amort_n: n, amort_total: total, subject_id: subj.id }));
      const { error } = await supabase.from('ledger_manual_entries').insert(rows); if (error) throw error;
      out.push({ store, ok: true, group, months: yms, each, last });
    } catch (err) { out.push({ store: it.store, error: err.message }); }
  }
  return out;
}
async function applyVoid(p, by) {
  const out = []; const now = new Date().toISOString();
  for (const id of p.ids || []) { try { const { data: m } = await supabase.from('ledger_manual_entries').select('store_erpid, report_ym').eq('id', id).maybeSingle(); if (!m) throw new Error('找不到'); if (await closed(m.store_erpid, m.report_ym)) throw new Error('已關帳'); const { error } = await supabase.from('ledger_manual_entries').update({ void_at: now, void_by: by }).eq('id', id).is('void_at', null); if (error) throw error; out.push({ id, ok: true }); } catch (err) { out.push({ id, error: err.message }); } }
  for (const g of p.amort_groups || []) { try { const { data } = await supabase.from('ledger_manual_entries').select('id, store_erpid, report_ym').eq('amort_group', g).is('void_at', null); const ids = []; const kept = []; for (const r of data || []) { if (await closed(r.store_erpid, r.report_ym)) kept.push(r.report_ym); else ids.push(r.id); } if (ids.length) await supabase.from('ledger_manual_entries').update({ void_at: now, void_by: by }).in('id', ids); out.push({ group: g, ok: true, voided: ids.length, kept_closed: kept }); } catch (err) { out.push({ group: g, error: err.message }); } }
  return out;
}
const FIXED_SPECIAL = ['marketing_fund', 'depreciation'];
async function fixedTarget(b) { if (b.subject_id) { const s = await LS.mustGet(b.subject_id); if (!(await LS.needsSubject(s.ledger_code))) throw new Error('只能選支出的會計科目'); return { ledger_code: s.ledger_code, subject_id: s.id }; } if (FIXED_SPECIAL.includes(b.ledger_code)) return { ledger_code: b.ledger_code, subject_id: null }; throw new Error('請選行銷基金／折舊，或一個會計科目'); }
async function applyFixed(p, by) {
  const out = [];
  for (const it of p.items || []) {
    try {
      if (it.action === 'add') { if (!it.store) throw new Error('缺門市'); const t = await fixedTarget(it); if (!YM.test(String(it.from_ym || ''))) throw new Error('起始月份要 YYYY-MM'); const amount = Number(it.amount); if (!Number.isFinite(amount) || amount === 0) throw new Error('金額不對'); const { data, error } = await supabase.from('store_fixed_items').insert({ store_erpid: String(it.store), ...t, amount, from_ym: it.from_ym, to_ym: it.to_ym && YM.test(String(it.to_ym)) ? it.to_ym : null, note: it.note || p.reason || null, created_by: by }).select('id').single(); if (error) throw error; out.push({ action: 'add', store: it.store, ok: true, id: data.id }); }
      else if (it.action === 'patch' || it.action === 'end') { if (!it.id) throw new Error('缺 id'); const up = {}; if (it.action === 'end') { if (!YM.test(String(it.to_ym || ''))) throw new Error('停用要給結束月份'); up.to_ym = it.to_ym; } else { if (it.amount !== undefined) { const a = Number(it.amount); if (!Number.isFinite(a) || a === 0) throw new Error('金額不對'); up.amount = a; } if (it.from_ym) up.from_ym = it.from_ym; if (it.to_ym !== undefined) up.to_ym = it.to_ym || null; if (it.note !== undefined) up.note = it.note; if (it.subject_id || it.ledger_code) Object.assign(up, await fixedTarget(it)); } const { error } = await supabase.from('store_fixed_items').update(up).eq('id', it.id); if (error) throw error; out.push({ action: it.action, id: it.id, ok: true }); }
      else if (it.action === 'delete') { const { error } = await supabase.from('store_fixed_items').delete().eq('id', it.id); if (error) throw error; out.push({ action: 'delete', id: it.id, ok: true }); }
      else throw new Error('不認識的 action');
    } catch (err) { out.push({ action: it.action, store: it.store, id: it.id, error: err.message }); }
  }
  MR.clearBookCache && MR.clearBookCache();
  return out;
}
async function applyAck(p, by) {
  const out = [];
  for (const it of p.items || []) { try { if (!it.store || !YM.test(String(it.ym)) || !it.rule_key) throw new Error('缺門市／月份／規則'); const { error } = await supabase.from('ledger_audit_acks').upsert({ store_erpid: String(it.store), ym: it.ym, rule_key: it.rule_key, status: ['ok', 'fixed', 'follow'].includes(it.status) ? it.status : 'ok', note: it.note ? String(it.note).slice(0, 500) : null, created_by: by }, { onConflict: 'store_erpid,ym,rule_key' }); if (error) throw error; out.push({ ...it, ok: true }); } catch (err) { out.push({ ...it, error: err.message }); } }
  return out;
}
async function applyStatus(p, by, role) {
  const ym = String(p.ym || ''), action = String(p.action || ''); if (!YM.test(ym)) throw new Error('月份要是 YYYY-MM');
  if ((action === 'close' || action === 'reopen') && role !== 'super_admin') throw new Error('關帳／重開只有最高管理者可以確認');
  if (action === 'reopen' && !String(p.reason || '').trim()) throw new Error('重開要寫原因');
  const now = new Date().toISOString(); const out = [];
  const stores = (p.stores || []).map(String);
  const { data: cur } = await supabase.from('store_month_reports').select('store_erpid, status, snapshot->imported').eq('ym', ym).in('store_erpid', stores);
  const st = Object.fromEntries((cur || []).map((r) => [r.store_erpid, r.status])); const imp = Object.fromEntries((cur || []).map((r) => [r.store_erpid, !!r.imported]));
  for (const store of stores) {
    const s0 = st[store] || 'draft';
    try {
      if (action === 'submit') { if (s0 !== 'draft') { out.push({ store, skip: `目前是 ${s0}` }); continue; } await supabase.from('store_month_reports').upsert({ store_erpid: store, ym, status: 'review', submitted_by: by, submitted_at: now, updated_at: now }, { onConflict: 'store_erpid,ym' }); }
      else if (action === 'close') { if (s0 === 'closed') { out.push({ store, skip: '已關帳' }); continue; } const snap = await MR.build(ym, store, { withLines: true }); snap.snapshot_at = now; await supabase.from('store_month_reports').upsert({ store_erpid: store, ym, status: 'closed', snapshot: snap, closed_by: by, closed_at: now, updated_at: now }, { onConflict: 'store_erpid,ym' }); }
      else { if (s0 !== 'closed') { out.push({ store, skip: `目前是 ${s0}` }); continue; } if (imp[store]) { out.push({ store, skip: '試算表匯入的月份不能重開' }); continue; } await supabase.from('store_month_reports').update({ status: 'draft', reopened_by: by, reopened_at: now, reopen_reason: String(p.reason).slice(0, 500), updated_at: now }).eq('store_erpid', store).eq('ym', ym); }
      out.push({ store, ok: true });
    } catch (e) { out.push({ store, error: e.message }); }
  }
  return out;
}

async function apply(id, user) {
  const by = user.name || user.member_id; const role = user.role;
  const { data: o } = await supabase.from('report_ai_orders').select('*').eq('id', id).maybeSingle();
  if (!o) throw E(404, '沒有這張單'); if (o.status !== 'pending') throw E(400, '這張單已處理');
  const p = o.payload || {}; let result; const now = new Date().toISOString();
  try {
    if (o.kind === 'post') result = await applyPost(p, by);
    else if (o.kind === 'amortize') result = await applyAmortize({ ...p, reason: o.reason }, by);
    else if (o.kind === 'void') result = await applyVoid(p, by);
    else if (o.kind === 'fixed') result = await applyFixed({ ...p, reason: o.reason }, by);
    else if (o.kind === 'ack') result = await applyAck(p, by);
    else if (o.kind === 'status') result = await applyStatus(p, by, role);
    else if (o.kind === 'subject') result = await LS.create({ ledger_code: p.ledger_code, name: p.name, note: p.note }, by);
    else throw new Error('不認識的動作單類型 ' + o.kind);
    const failed = Array.isArray(result) ? result.filter((r) => r.error) : [];
    const status = Array.isArray(result) && failed.length === result.length && result.length ? 'failed' : (failed.length ? 'partial' : 'applied');
    await supabase.from('report_ai_orders').update({ status, decided_by: by, decided_at: now, result, error: failed.length ? failed.map((f) => `${f.store || f.id || ''}：${f.error}`).join('；').slice(0, 1000) : null }).eq('id', id);
    MR.clearBookCache && MR.clearBookCache();
    return { status, result };
  } catch (e) {
    await supabase.from('report_ai_orders').update({ status: 'failed', decided_by: by, decided_at: now, error: e.message }).eq('id', id);
    throw E(400, '套用失敗：' + e.message);
  }
}
async function reject(id, user) { await supabase.from('report_ai_orders').update({ status: 'rejected', decided_by: user.name || user.member_id, decided_at: new Date().toISOString() }).eq('id', id).eq('status', 'pending'); return { ok: true }; }

/** 回饋／糾正 → 樂維斯（糾正立刻變成 AI 的筆記） */
async function feedback({ run_id, verdict, note, final, by, scope }) {
  const r = await fetch(`${LAVIS_URL}/api/agents/review`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-agent-key': LAVIS_KEY }, body: JSON.stringify({ run_id, agent_key: 'acct', verdict, note, final, by, scope }), signal: AbortSignal.timeout(30000) });
  const j = await r.json().catch(() => ({})); if (!r.ok || j.success === false) throw E(502, '回饋失敗：' + (j.message || r.status)); return j;
}
async function lavis(method, path, body) {
  const r = await fetch(`${LAVIS_URL}/api/agents${path}`, { method, headers: { 'Content-Type': 'application/json', 'x-agent-key': LAVIS_KEY }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30000) });
  const j = await r.json().catch(() => ({})); if (!r.ok || j.success === false) throw E(502, j.message || String(r.status)); return j;
}

module.exports = { context, chat, apply, reject, feedback, lavis, summarize, storeList };
