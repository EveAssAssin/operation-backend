// 規範編輯助理查各系統現況（2026-11-25）：挑主題只收清單裡的、沒挑到就不查、沒金鑰不打市場部
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'x';
process.env.SUPABASE_KEY = process.env.SUPABASE_KEY || 'x';
delete process.env.MARKET_INTERNAL_KEY;
const test = require('node:test');
const assert = require('node:assert');
const C = require('../src/services/regulationContext');

test('沒設 MARKET_INTERNAL_KEY：清單只有營運部自己的主題', async () => {
  const list = await C.catalog();
  assert.deepStrictEqual(list.map((t) => t.key), ['store_profit']);
});
test('AI 挑了清單外的主題 → 丟掉；最多 4 個', async () => {
  const fake = async () => ({ topics: ['store_profit', 'hack_db', 'store_profit'] });
  assert.deepStrictEqual(await C.pick(fake, { message: '店長分紅用盈餘算', title: 'x' }), ['store_profit']);
});
test('AI 挑主題失敗 → 空陣列，不擋編輯助理', async () => {
  const boom = async () => { throw new Error('timeout'); };
  assert.deepStrictEqual(await C.pick(boom, { message: 'x' }), []);
});
test('沒挑到主題 → 不查、text 空', async () => {
  const none = async () => ({ topics: [] });
  const r = await C.forRequest(none, { message: '把第 3 條的錯字改掉' });
  assert.deepStrictEqual(r, { used: [], text: '', errors: {} });
});
test('市場部主題但沒金鑰 → 記在 errors，不丟例外', async () => {
  const r = await C.gather(['store_eval']);
  assert.strictEqual(r.text, '');
  assert.match(r.errors.store_eval, /MARKET_INTERNAL_KEY/);
});
