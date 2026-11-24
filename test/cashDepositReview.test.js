const test = require('node:test');
const assert = require('node:assert');
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'x';
const S = require('../src/services/cashDepositReview');
const dep = (id, store, amt, to, at) => ({ id, store_erpid: store, expected: amt, period_to: to, created_at: at });
const tx = (id, amt, date, store) => ({ id, in_amt: amt, txn_date: date, store_erpid: store || null, cash_deposit_id: null });
test('一對一自動配對', () => {
  const r = S.pairUp([dep('a', '1', 5000, '2026-11-20', '2026-11-21T03:00:00Z')], [tx('t1', 5000, '2026-11-21'), tx('t2', 4000, '2026-11-21')]);
  assert.deepStrictEqual(r.pairs.map((p) => [p.dep.id, p.txn.id]), [['a', 't1']]);
});
test('兩家店同金額同一天 → 不自動配，留給人工', () => {
  const r = S.pairUp([dep('a', '1', 5000, '2026-11-20', '2026-11-21T03:00:00Z'), dep('b', '2', 5000, '2026-11-20', '2026-11-21T04:00:00Z')], [tx('t1', 5000, '2026-11-21'), tx('t2', 5000, '2026-11-21')]);
  assert.strictEqual(r.pairs.length, 0); assert.strictEqual(r.ambiguous.length, 2);
});
test('本子那筆有標門市 → 只配同門市', () => {
  const r = S.pairUp([dep('a', '1', 5000, '2026-11-20', '2026-11-21T03:00:00Z'), dep('b', '2', 5000, '2026-11-20', '2026-11-21T04:00:00Z')], [tx('t1', 5000, '2026-11-21', '1'), tx('t2', 5000, '2026-11-21', '2')]);
  assert.strictEqual(r.pairs.length, 2);
});
test('日期太早（結算前兩天）不配', () => {
  const r = S.pairUp([dep('a', '1', 5000, '2026-11-20', '2026-11-21T03:00:00Z')], [tx('t1', 5000, '2026-11-17')]);
  assert.strictEqual(r.pairs.length, 0);
});
