const test = require('node:test');
const assert = require('node:assert');
const RB = require('../src/services/vendorRebate');
test('內含 10%：帳單 100 → 帳面 100、回饋 10、出款 90', () => {
  assert.deepStrictEqual(RB.compute(100, 10, 'inclusive'), { rebate_pct: 10, rebate_mode: 'inclusive', gross_amount: 100, rebate_amount: 10, payout_amount: 90 });
});
test('外加 10%：帳單 90 → 帳面 100、回饋 10、出款 90', () => {
  assert.deepStrictEqual(RB.compute(90, 10, 'exclusive'), { rebate_pct: 10, rebate_mode: 'exclusive', gross_amount: 100, rebate_amount: 10, payout_amount: 90 });
});
test('沒設回饋 → 全空', () => { assert.strictEqual(RB.compute(100, null, null).payout_amount, null); });
test('外加分帳放大，合計＝帳面', () => {
  const rows = RB.scaleRows([{ amount: 30 }, { amount: 30 }, { amount: 30.5 }], 101);
  assert.strictEqual(rows.reduce((s, x) => s + x.amount, 0), 101);
});
test('payAmt 沒算過回饋就用請款金額', () => { assert.strictEqual(RB.payAmt({ total_amount: 50 }), 50); assert.strictEqual(RB.payAmt({ total_amount: 50, payout_amount: 45 }), 45); });
