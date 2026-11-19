// services/requestNo.js — 請款單號 REQ-YYYYMM-NNNNN（2026-11-19 芽芽回報 #263）
//
// DB trigger generate_request_no 用「當月筆數＋1」產號：當月刪過一張（11 月刪了 00004）就會撞到已存在的最大號，
// 之後每一張新請款都 duplicate key（vendor_payment_requests_request_no_key）。
// trigger 只在 request_no IS NULL 時才產號 → 這裡改由程式帶「當月最大號＋1」，撞號（同時送出）就重抓再試。
// 月份跟原 trigger 一樣用 DB 時區（UTC）的 now()。

const supabase = require('../config/supabase');

function prefixOf(d = new Date()) {
  return `REQ-${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}-`;
}

async function nextRequestNo() {
  const p = prefixOf();
  const { data, error } = await supabase.from('vendor_payment_requests')
    .select('request_no').like('request_no', p + '%')
    .order('request_no', { ascending: false }).limit(1);
  if (error) throw new Error(`讀取請款單號失敗：${error.message}`);
  const last = data && data[0] ? parseInt(String(data[0].request_no).slice(p.length), 10) || 0 : 0;
  return p + String(last + 1).padStart(5, '0');
}

const isNoClash = (e) => e && e.code === '23505' && /request_no/.test(e.message || '');

/** 新增一張請款單（自動帶單號、撞號重試）。回傳跟 supabase 一樣的 { data, error } */
async function insertRequest(row, select = '*') {
  let last = null;
  for (let i = 0; i < 5; i++) {
    const request_no = await nextRequestNo();
    const { data, error } = await supabase.from('vendor_payment_requests')
      .insert([{ ...row, request_no }]).select(select).single();
    if (!error) return { data, error: null };
    if (!isNoClash(error)) return { data: null, error };
    last = error;
  }
  return { data: null, error: last };
}

module.exports = { insertRequest, nextRequestNo, prefixOf, _test: { isNoClash } };
