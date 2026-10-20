// services/ledgerSubjects.js —— 會計科目（2026-10-21，migration 033）
// 月報格子（ledger_accounts）＝大分類；會計科目＝格子底下的細項。選科目＝決定月報格子。
// 每個支出格子有一個同名「預設科目」：系統自動進來的帳（路奇、企劃、倉庫、水電…）沒指定科目就算在預設科目。
const supabase = require('../config/supabase');

let cache = null;
async function all(fresh) {
  if (!fresh && cache && Date.now() - cache.at < 60e3) return cache.v;
  const [{ data: subs, error }, { data: accs }] = await Promise.all([
    supabase.from('ledger_subjects').select('*').order('ledger_code').order('sort_order').order('name'),
    supabase.from('ledger_accounts').select('code, name, group_code, kind, is_active, sort_order'),
  ]);
  if (error) throw new Error(error.message);
  const acc = Object.fromEntries((accs || []).map((a) => [a.code, a]));
  const v = (subs || []).map((s) => ({ ...s, ledger_name: (acc[s.ledger_code] || {}).name || s.ledger_code, group_code: (acc[s.ledger_code] || {}).group_code || null }));
  cache = { at: Date.now(), v };
  return v;
}
const clear = () => { cache = null; };

async function byId(id) { return (await all()).find((s) => s.id === id) || null; }
async function defaultOf(code) { return (await all()).find((s) => s.ledger_code === code && s.is_default) || null; }

/** 驗證：科目存在、啟用中；有給 ledger_code 時要屬於那一格。回傳科目 */
async function mustGet(subjectId, ledgerCode) {
  if (!subjectId) throw new Error('請選會計科目（之後才能歸類分析）');
  const s = await byId(String(subjectId));
  if (!s) throw new Error('找不到這個會計科目');
  if (!s.is_active) throw new Error(`會計科目「${s.name}」已停用`);
  if (ledgerCode && s.ledger_code !== ledgerCode) throw new Error(`會計科目「${s.name}」不屬於月報格子「${ledgerCode}」`);
  return s;
}

/** 支出格子才要科目 */
async function needsSubject(ledgerCode) {
  const { data } = await supabase.from('ledger_accounts').select('kind').eq('code', ledgerCode).maybeSingle();
  return !!data && data.kind === 'expense';
}

async function create({ ledger_code, name, note }, by) {
  const nm = String(name || '').trim();
  if (!ledger_code || !nm) throw new Error('要選月報格子、填科目名稱');
  const { data: a } = await supabase.from('ledger_accounts').select('code, kind').eq('code', ledger_code).maybeSingle();
  if (!a) throw new Error('找不到這個月報格子');
  if (a.kind !== 'expense') throw new Error('只有支出格子可以加科目');
  const { data, error } = await supabase.from('ledger_subjects').insert({ ledger_code, name: nm.slice(0, 40), note: note || null, created_by: by }).select().single();
  if (error) throw new Error(/duplicate|unique/i.test(error.message) ? `「${nm}」在這一格已經有了` : error.message);
  clear();
  return data;
}

async function patch(id, b) {
  const s = await byId(id);
  if (!s) throw new Error('找不到這個科目');
  const up = {};
  if (b.name !== undefined) { const nm = String(b.name || '').trim(); if (!nm) throw new Error('名稱不能空白'); up.name = nm.slice(0, 40); }
  if (b.is_active !== undefined) { if (s.is_default && !b.is_active) throw new Error('預設科目不能停用'); up.is_active = !!b.is_active; }
  if (b.sort_order !== undefined) up.sort_order = Number(b.sort_order) || 0;
  if (b.note !== undefined) up.note = b.note || null;
  const { data, error } = await supabase.from('ledger_subjects').update(up).eq('id', id).select().single();
  if (error) throw new Error(/duplicate|unique/i.test(error.message) ? '這一格已經有同名科目' : error.message);
  clear();
  return data;
}

/** 新增月報格子時順手建預設科目 */
async function ensureDefault(code, name) {
  await supabase.from('ledger_subjects').upsert({ ledger_code: code, name, is_default: true, sort_order: 0, created_by: 'auto' }, { onConflict: 'ledger_code,name', ignoreDuplicates: true });
  clear();
}

/**
 * 每一列帳補 subject_id／subject_name／subject_set（true＝有人選過；false＝用格子的預設科目）
 * 帳單看 bills.subject_id；手填／調帳／分攤看 ledger_manual_entries.subject_id；其他來源用預設科目
 */
async function attach(lines) {
  if (!lines.length) return lines;
  const billIds = [...new Set(lines.filter((l) => l.source === 'bill').map((l) => String(l.ref_id)))];
  const manIds = [...new Set(lines.filter((l) => String(l.source || '').startsWith('manual_')).map((l) => String(l.ref_id)))];
  const pick = async (table, ids) => {
    const m = {};
    for (let i = 0; i < ids.length; i += 300) {
      const { data } = await supabase.from(table).select('id, subject_id').in('id', ids.slice(i, i + 300));
      for (const r of data || []) if (r.subject_id) m[r.id] = r.subject_id;
    }
    return m;
  };
  const [bm, mm, subs] = await Promise.all([pick('bills', billIds), pick('ledger_manual_entries', manIds), all()]);
  const byIdMap = Object.fromEntries(subs.map((s) => [s.id, s]));
  const defs = Object.fromEntries(subs.filter((s) => s.is_default).map((s) => [s.ledger_code, s]));
  for (const l of lines) {
    const sid = l.source === 'bill' ? bm[l.ref_id] : String(l.source || '').startsWith('manual_') ? mm[l.ref_id] : null;
    const s = sid && byIdMap[sid];
    const d = defs[l.ledger_code || l.code];
    l.subject_id = s ? s.id : d ? d.id : null;
    l.subject_name = s ? s.name : d ? d.name : null;
    l.subject_set = !!s;
  }
  return lines;
}

module.exports = { all, clear, byId, defaultOf, mustGet, needsSubject, create, patch, ensureDefault, attach };
