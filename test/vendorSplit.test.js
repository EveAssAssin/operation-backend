const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const S = require('../src/services/vendorSplit');
const targets = [['120061', '東山店'], ['120085', '愛民眼鏡後甲店'], ['120074', '新竹店'], ['120075', '竹北店'], ['2471300', '愛民眼鏡北屯店'], ['120048', '熱河店'], ['120055', '高美店']].map(([store_erpid, store_name]) => ({ store_erpid, store_name }));
test('晶碩 2026-10 對帳單：東山 請款 101587 → 門市開帳 106557（中間商 3313、總部 1657）', () => {
  const p = S.parseStatement(fs.readFileSync(path.join(__dirname, 'fixtures_jingshuo_202610.xlsx')));
  assert.strictEqual(p.rows.length, 26);
  const s = S.computeSplit(p, [{ match: '38%抽成', rate: 38, intermediary: 2, hq: 1 }], { PV67022: '120055' }, targets);
  const ds = s.rows.find((r) => r.code === 'PV67001');
  assert.deepStrictEqual([ds.store_erpid, ds.payout, ds.intermediary, ds.hq, ds.store_cost], ['120061', 101587, 3313, 1657, 106557]);
  assert.strictEqual(s.totals.payout, 1736715);
  assert.strictEqual(s.rows.find((r) => r.code === 'PV67022').store_erpid, '120055');   // 設過對照的照對照
  assert.strictEqual(s.rows.find((r) => r.code === 'PV67028').store_erpid, '2471300');  // 北屯 → 愛民眼鏡北屯店
});
test('自動對照：新竹不會對到竹北', () => { assert.strictEqual(S.autoMatch('樂活新竹門市', targets).store_erpid, '120074'); });
