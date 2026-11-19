// #263 請款單號：當月最大號＋1、撞號重試
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const supaPath = require.resolve(path.join(__dirname, '../src/config/supabase'));
const existing = new Set();          // 已存在的單號
let inserts = 0, raceOnce = false;
function q() {
  const st = { like: null, row: null };
  const api = {
    select() { return api; },
    like(_c, v) { st.like = v.replace('%', ''); return api; },
    order() { return api; },
    limit() {
      const rows = [...existing].filter((n) => n.startsWith(st.like)).sort().reverse().slice(0, 1).map((request_no) => ({ request_no }));
      return Promise.resolve({ data: rows, error: null });
    },
    insert(arr) { st.row = arr[0]; return api; },
    single() {
      inserts++;
      const no = st.row.request_no;
      if (raceOnce) { raceOnce = false; existing.add(no); }   // 模擬別人同時搶走這個號
      if (existing.has(no)) return Promise.resolve({ data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "vendor_payment_requests_request_no_key"' } });
      existing.add(no);
      return Promise.resolve({ data: { ...st.row, id: 'x' }, error: null });
    },
  };
  return api;
}
require.cache[supaPath] = { id: supaPath, filename: supaPath, loaded: true, exports: { from: () => q() } };
const R = require('../src/services/requestNo');

test('刪過中間一張（00004）仍接在最大號後面', async () => {
  const p = R.prefixOf();
  [1, 2, 3, 5, 25].forEach((n) => existing.add(p + String(n).padStart(5, '0')));
  const { data, error } = await R.insertRequest({ title: 't' });
  assert.equal(error, null);
  assert.equal(data.request_no, p + '00026');
});

test('同時送出撞號 → 重抓再試', async () => {
  const p = R.prefixOf();
  raceOnce = true; inserts = 0;
  const { data, error } = await R.insertRequest({ title: 't2' });
  assert.equal(error, null);
  assert.equal(data.request_no, p + '00028');
  assert.equal(inserts, 2);
});

test('月份前綴用 UTC', () => {
  assert.equal(R.prefixOf(new Date('2026-11-30T17:00:00Z')), 'REQ-202611-');
  assert.equal(R.prefixOf(new Date('2026-12-01T00:00:00Z')), 'REQ-202612-');
});
