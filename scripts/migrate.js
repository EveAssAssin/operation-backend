#!/usr/bin/env node
// scripts/migrate.js
// migration 手動操作 CLI
//
// 用法：
//   node scripts/migrate.js status      # 只回報：磁碟有幾支、已跑幾支、還缺幾支
//   node scripts/migrate.js baseline    # 把所有待跑檔案標為「已跑」但不執行 SQL
//                                         （既有專案第一次接入時用；auto 模式會自動做這件事）
//   node scripts/migrate.js apply       # 一定執行待跑檔案（不觸發首次 baseline 邏輯）
//
// 讀 .env 拿 SUPABASE_DB_URL。

require('dotenv').config();
const { runMigrations } = require('../src/lib/migrator');

const cmd = (process.argv[2] || 'status').toLowerCase();
const validModes = { status: 'status', baseline: 'baseline', apply: 'apply-only' };
const mode = validModes[cmd];

if (!mode) {
  console.error('用法：node scripts/migrate.js <status|baseline|apply>');
  process.exit(2);
}

(async () => {
  try {
    const r = await runMigrations({ mode });
    if (r.skipped) {
      console.error('SUPABASE_DB_URL 未設定，無法執行');
      process.exit(1);
    }
    console.log('');
    console.log('─── 結果 ────────────────────────────');
    console.log(`模式          ：${r.mode}`);
    console.log(`磁碟總檔案數  ：${r.totalFiles}`);
    console.log(`執行前已套用  ：${r.appliedBefore}`);
    if (r.baselined != null) console.log(`本次 baseline ：${r.baselined}`);
    if (r.applied   != null) console.log(`本次執行套用  ：${r.applied}`);
    if (r.pending   != null) console.log(`目前尚待執行  ：${r.pending}`);
    if (Array.isArray(r.pendingList) && r.pendingList.length > 0 && cmd === 'status') {
      console.log('');
      console.log('待跑清單：');
      r.pendingList.forEach(f => console.log(`  - ${f}`));
    }
    if (Array.isArray(r.results) && r.results.length > 0) {
      console.log('');
      console.log('本次執行明細：');
      r.results.forEach(x => console.log(`  ✓ ${x.file}  (${x.ms}ms)`));
    }
    process.exit(0);
  } catch (e) {
    console.error('');
    console.error('❌ 失敗：', e.message);
    process.exit(1);
  }
})();
