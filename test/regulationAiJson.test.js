// 規範 AI 回覆的 JSON 修復（2026-11-19）：條文原文裡的半形雙引號沒跳脫 → 以前整包「格式不正確」
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'x';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'x';
process.env.SUPABASE_KEY = process.env.SUPABASE_KEY || 'x';
const test = require('node:test');
const assert = require('node:assert');
const { parseJson, repairJson } = require('../src/services/regulationAi');

test('正常的 JSON 不受影響（含合法跳脫、```json 包裝）', () => {
  assert.deepStrictEqual(parseJson('```json\n{"a":"他說\\"好\\"","b":[1,2]}\n```'), { a: '他說"好"', b: [1, 2] });
  assert.deepStrictEqual(parseJson('前言 {"a": "x"} 後記'), { a: 'x' });
});
test('條文裡沒跳脫的半形雙引號：修得回來', () => {
  const bad = '```json\n{"understanding":"改獎金","options":[{"key":"A","ops":[{"op":"replace_text","code":"3.2","text":"取得"樂活認證晶碩專員“稱號，獎金加倍"}],\n "other_regs": []}]}\n```';
  const j = parseJson(bad);
  assert.strictEqual(j.options[0].ops[0].text, '取得"樂活認證晶碩專員“稱號，獎金加倍');
  assert.deepStrictEqual(j.options[0].other_regs, []);
});
test('成對的引號、字串裡直接換行：修得回來', () => {
  const j = parseJson('{"text":"銷售"招財寶"第一支\n第二行","n":1}');
  assert.strictEqual(j.text, '銷售"招財寶"第一支\n第二行'); assert.strictEqual(j.n, 1);
});
test('真的壞掉的還是報錯', () => {
  assert.throws(() => parseJson('{"a": [1, 2'), /格式不正確/);
  assert.throws(() => parseJson('抱歉，我無法處理'), /格式不正確/);
});
test('repairJson 不動結構', () => { assert.strictEqual(repairJson('{"a":"b","c":[{"d":"e"}]}'), '{"a":"b","c":[{"d":"e"}]}'); });
