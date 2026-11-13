// 規範 AI 檢查收斂（2026-11-12）：用假 AI 回應驗 regulationCheckCore。執行：node --test test/
const test = require('node:test');
const assert = require('node:assert');
const Core = require('../src/services/regulationCheckCore');

const REG = 1254;
const mk = (texts) => ({ title: '年年換新', sections: [{ title: '活動內容', items: Object.entries(texts).map(([code, text]) => ({ code, text })) }] });
const published = mk({ '1254-1': '原 A', '1254-2': '原 B', '1254-3': '原 C' });
const okFix = (ops) => ({ ops, preview: null });

// 假 AI：依「這次要檢查的條文」回固定問題；記錄每次被問了哪些條文
function fakeAi(table) {
  const calls = [];
  const ask = async ({ changes }) => {
    const codes = changes.map(c => c.code); calls.push(codes);
    const out = [];
    for (const c of codes) for (const it of (table[c] || [])) out.push(it);
    return out;
  };
  return { ask, calls };
}
const issue = (code, kind = '模糊', extra = {}) => ({ level: 'warn', kind, title: `${code} 有問題`, detail: 'x', codes: [code], fix: null, ...extra });

test('① 同內容檢查兩次結果一致（key 相同、第二次不叫 AI）', async () => {
  const doc = mk({ '1254-1': '新 A', '1254-2': '新 B', '1254-3': '原 C' });
  const ai = fakeAi({ '1254-1': [issue('1254-1', '缺漏')], '1254-2': [issue('1254-2')] });
  const r1 = await Core.runRound({ prev: null, oldDoc: published, doc, regId: REG, ask: ai.ask, validateFix: okFix });
  const r2 = await Core.runRound({ prev: r1, oldDoc: published, doc, regId: REG, ask: ai.ask, validateFix: okFix });
  assert.deepStrictEqual(r1.issues.map(i => i.id).sort(), r2.issues.map(i => i.id).sort());
  assert.strictEqual(ai.calls.length, 1, '沒有變動不應再叫 AI');
  assert.strictEqual(r2.round, 1, '沒有新變動的重新檢查不算一輪');
  assert.ok(r2.issues.every(i => i.is_new === false));
});

test('② 忽略後只改別條 → 該問題不再出現（保留已忽略狀態）', async () => {
  const d1 = mk({ '1254-1': '新 A', '1254-2': '新 B', '1254-3': '原 C' });
  const ai = fakeAi({ '1254-1': [issue('1254-1')], '1254-2': [issue('1254-2')], '1254-3': [issue('1254-3', '缺漏')] });
  const r1 = await Core.runRound({ prev: null, oldDoc: published, doc: d1, regId: REG, ask: ai.ask, validateFix: okFix });
  const target = r1.issues.find(i => i.codes.includes('1254-1'));
  r1.resolved[target.id] = { how: 'ignored', reason: '刻意' };
  const d2 = mk({ '1254-1': '新 A', '1254-2': '新 B', '1254-3': '改 C' });   // 只改 3
  const r2 = await Core.runRound({ prev: r1, oldDoc: published, doc: d2, regId: REG, ask: ai.ask, validateFix: okFix });
  assert.deepStrictEqual(ai.calls[1], ['1254-3'], '第二輪只該問改過的 1254-3');
  const again = r2.issues.find(i => i.id === target.id);
  assert.ok(again && r2.resolved[target.id]?.how === 'ignored', '被忽略的問題保留且仍是已忽略');
  assert.strictEqual(Core.blocking(r2).some(i => i.id === target.id), false);
  assert.ok(r2.issues.find(i => i.codes.includes('1254-3')).is_new, '1254-3 的問題標 🆕');
});

test('③ 改了被忽略問題的條文 → 重新出現（未處理、標之前就有）', async () => {
  const d1 = mk({ '1254-1': '新 A', '1254-2': '原 B', '1254-3': '原 C' });
  const ai = fakeAi({ '1254-1': [issue('1254-1', '缺漏')] });
  const r1 = await Core.runRound({ prev: null, oldDoc: published, doc: d1, regId: REG, ask: ai.ask, validateFix: okFix });
  const id = r1.issues[0].id; r1.resolved[id] = { how: 'ignored', reason: 'x' };
  const d2 = mk({ '1254-1': '再改 A', '1254-2': '原 B', '1254-3': '原 C' });
  const r2 = await Core.runRound({ prev: r1, oldDoc: published, doc: d2, regId: REG, ask: ai.ask, validateFix: okFix });
  const back = r2.issues.find(i => i.id === id);
  assert.ok(back, '同 key 問題重新出現');
  assert.strictEqual(r2.resolved[id], undefined, '條文改過 → 不沿用忽略');
  assert.strictEqual(back.is_new, false, '之前就有');
});

test('④ 同條文三個修法合併成一個問題、一個 fix', async () => {
  const d1 = mk({ '1254-1': '新 A', '1254-2': '原 B', '1254-3': '原 C' });
  const three = [1, 2, 3].map(n => issue('1254-1', '模糊', { title: `改法${n}`, fix: { label: `修${n}`, ops: [{ op: 'replace_text', code: '1254-1', text: `A${n}` }] } }));
  const ai = fakeAi({ '1254-1': three });
  const r1 = await Core.runRound({ prev: null, oldDoc: published, doc: d1, regId: REG, ask: ai.ask, validateFix: okFix });
  assert.strictEqual(r1.issues.length, 1);
  assert.strictEqual(r1.issues[0].fix.label, '修1');
  assert.match(r1.issues[0].detail, /改法2/);
});

test('⑤ 第 3 輪起模糊類不擋送審、缺漏照擋', async () => {
  const ai = fakeAi({ '1254-1': [issue('1254-1', '模糊')], '1254-2': [issue('1254-2', '缺漏')], '1254-3': [issue('1254-3', '範圍')] });
  let prev = null;
  const docs = [
    mk({ '1254-1': 'a1', '1254-2': '原 B', '1254-3': '原 C' }),
    mk({ '1254-1': 'a2', '1254-2': '原 B', '1254-3': '原 C' }),
    mk({ '1254-1': 'a3', '1254-2': 'b3', '1254-3': 'c3' }),
  ];
  for (const d of docs) prev = await Core.runRound({ prev, oldDoc: published, doc: d, regId: REG, ask: ai.ask, validateFix: okFix });
  assert.strictEqual(prev.round, 3);
  const by = Object.fromEntries(prev.issues.map(i => [i.kind, i]));
  assert.strictEqual(by['模糊'].level, 'info'); assert.strictEqual(by['模糊'].downgraded, 'warn');
  assert.strictEqual(by['範圍'].level, 'info');
  assert.strictEqual(by['缺漏'].level, 'warn');
  assert.deepStrictEqual(Core.blocking(prev).map(i => i.kind), ['缺漏']);
});

test('舊格式 ai_checks（沒有 key／clause_hash）→ 當第一輪：完整重查、忽略依身分沿用', async () => {
  const legacy = { at: '2026-11-12T01:50:29Z', doc_hash: 'x', issues: [{ id: 'i1', level: 'warn', kind: '缺漏', title: '舊標題', detail: '', codes: ['1254-1'] }], resolved: { i1: { how: 'ignored', reason: 'r' } } };
  const d = mk({ '1254-1': '新 A', '1254-2': '原 B', '1254-3': '原 C' });
  const ai = fakeAi({ '1254-1': [issue('1254-1', '缺漏', { title: 'AI 換了說法' })] });
  const r = await Core.runRound({ prev: legacy, oldDoc: published, doc: d, regId: REG, ask: ai.ask, validateFix: okFix });
  assert.strictEqual(r.round, 2);
  assert.ok(r.checked.full, '舊格式沒有條文快照 → 完整重查');
  assert.strictEqual(r.issues.length, 1);
  assert.strictEqual(r.issues[0].is_new, false, '同身分視為之前就有');
  assert.strictEqual(r.resolved[r.issues[0].id]?.how, 'ignored', '舊格式的忽略依身分沿用');
});

test('⑦ 跨規範一起改：衝突的對方規範正在修改（isStale）→ 不沿用舊衝突、重新問 AI；AI 判定已一致就消失（2026-11-13）', async () => {
  const d1 = mk({ '1254-1': '新 A', '1254-2': '原 B', '1254-3': '原 C' });
  let conflict = true;
  const calls = [];
  const ask = async ({ changes }) => { calls.push(changes.map(c => c.code)); return conflict ? [issue('1254-1', '衝突', { codes: ['1254-1', '900-4.1'] })] : []; };
  const r1 = await Core.runRound({ prev: null, oldDoc: published, doc: d1, regId: REG, ask, validateFix: okFix });
  assert.strictEqual(Core.blocking(r1).length, 1, '第一次有衝突（擋送審）');
  // 沒有 isStale：條文沒動 → 沿用舊衝突、不叫 AI（舊行為：會卡住）
  const r2 = await Core.runRound({ prev: r1, oldDoc: published, doc: d1, regId: REG, ask, validateFix: okFix });
  assert.strictEqual(calls.length, 1); assert.strictEqual(Core.blocking(r2).length, 1);
  // 對方規範 900 正在改、改完已一致 → isStale 讓 1254-1 重新檢查，AI 不再回報
  conflict = false;
  const r3 = await Core.runRound({ prev: r1, oldDoc: published, doc: d1, regId: REG, ask, validateFix: okFix, isStale: (i) => i.kind === '衝突' && i.codes.some(c => c.startsWith('900-')) });
  assert.deepStrictEqual(calls[1], ['1254-1'], '只重問那條');
  assert.strictEqual(r3.issues.length, 0, '衝突消失');
  // 對照：isStale 回 false 的不受影響
  conflict = true;
  const r4 = await Core.runRound({ prev: r1, oldDoc: published, doc: d1, regId: REG, ask, validateFix: okFix, isStale: () => false });
  assert.strictEqual(calls.length, 2, 'isStale false 不叫 AI'); assert.strictEqual(Core.blocking(r4).length, 1);
});
