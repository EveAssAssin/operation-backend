// lib/migrator.js
// 資料庫 migration 自動執行器
//
// 設計目標：
//   1. 後端啟動時自動掃 database/*.sql + migrations/*.sql，跑新增的
//   2. 不改現有檔案命名（保留 015_xxx.sql 這種）
//   3. 用 Postgres advisory lock 擋多 instance 同時跑
//   4. 首次啟動偵測：如果 tracker 表是空的但磁碟上有檔，
//      表示是「既有專案接入 runner」，把現有全部 baseline 為「已跑」，
//      之後只跑新增的檔案
//
// 追蹤表：_migrations_applied
//   folder + filename 為 unique key
//
// 環境變數：
//   SUPABASE_DB_URL — Postgres 直連字串（Session pooler 或 direct，port 5432）
//     沒設 → 直接跳過 migration（本地開發用）
//   RUN_MIGRATIONS_ON_START=false → 就算有 URL 也跳過（緊急停用）

const fs   = require('fs');
const path = require('path');
const { Client } = require('pg');

// 掃描順序：database/ 先跑，再跑 migrations/
// 兩個資料夾都是既有專案沿用的命名，內部依檔名排序
const MIGRATION_FOLDERS = ['database', 'migrations'];

// Advisory lock key（隨便一組固定整數，只要專案內獨一無二即可）
const LOCK_KEY_HI = 4747;
const LOCK_KEY_LO = 6512;

const TRACKER_TABLE = '_migrations_applied';

function backendRoot() {
  // src/lib/migrator.js → 專案根 = 上上層
  return path.resolve(__dirname, '..', '..');
}

// 掃出所有 .sql 檔案，回傳 [{folder, filename, filepath}, ...]
function scanFiles() {
  const out = [];
  const root = backendRoot();
  for (const folder of MIGRATION_FOLDERS) {
    const dir = path.join(root, folder);
    if (!fs.existsSync(dir)) continue;
    const files = fs.readdirSync(dir)
      .filter(f => f.endsWith('.sql'))
      .sort();                              // 字典序：015_xxx 會排在 023_xxx 之前
    for (const f of files) {
      out.push({ folder, filename: f, filepath: path.join(dir, f) });
    }
  }
  return out;
}

async function ensureTracker(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${TRACKER_TABLE} (
      id           SERIAL      PRIMARY KEY,
      folder       TEXT        NOT NULL,
      filename     TEXT        NOT NULL,
      applied_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      duration_ms  INT,
      UNIQUE (folder, filename)
    );
    COMMENT ON TABLE ${TRACKER_TABLE} IS
      'migration 執行紀錄。由 src/lib/migrator.js 維護，請勿手動改。';
  `);
}

async function listApplied(client) {
  const { rows } = await client.query(
    `SELECT folder, filename FROM ${TRACKER_TABLE}`
  );
  return new Set(rows.map(r => `${r.folder}/${r.filename}`));
}

async function markApplied(client, folder, filename, durationMs) {
  await client.query(
    `INSERT INTO ${TRACKER_TABLE} (folder, filename, duration_ms) VALUES ($1, $2, $3)
     ON CONFLICT (folder, filename) DO NOTHING`,
    [folder, filename, durationMs || null]
  );
}

/**
 * 執行 migration。
 *
 * @param {object} opts
 * @param {'auto'|'apply-only'|'baseline'|'status'} [opts.mode='auto']
 *   - auto        (預設)：tracker 空 = baseline；否則 apply
 *   - apply-only  ：一定 apply，就算 tracker 空也不 baseline
 *   - baseline    ：把磁碟上所有檔案標為已跑，但不執行 SQL
 *   - status      ：只回報，不動任何東西
 * @param {console} [opts.logger=console]
 * @returns {Promise<{
 *   skipped?: boolean, mode: string,
 *   totalFiles: number, appliedBefore: number,
 *   baselined?: number, applied?: number, pending?: number,
 *   pendingList?: string[], results?: Array<{file:string, ms:number}>,
 * }>}
 */
async function runMigrations({ mode = 'auto', logger = console } = {}) {
  const connStr = process.env.SUPABASE_DB_URL;
  if (!connStr) {
    logger.warn('[Migrator] SUPABASE_DB_URL 未設定 — 跳過 migration（本地開發正常）');
    return { skipped: true, mode, totalFiles: 0, appliedBefore: 0 };
  }

  const client = new Client({
    connectionString: connStr,
    ssl: { rejectUnauthorized: false },   // Supabase 需要 SSL
    statement_timeout: 5 * 60 * 1000,     // 單一 SQL 上限 5 分鐘
  });
  await client.connect();

  let lockAcquired = false;
  try {
    // 1. 拿 advisory lock — 擋多 instance
    logger.log('[Migrator] 取得 advisory lock...');
    await client.query('SELECT pg_advisory_lock($1, $2)', [LOCK_KEY_HI, LOCK_KEY_LO]);
    lockAcquired = true;

    // 2. 確保 tracker table 存在
    await ensureTracker(client);

    // 3. 掃檔案 + 讀已跑過的
    const allFiles = scanFiles();
    const applied  = await listApplied(client);
    const pending  = allFiles.filter(f => !applied.has(`${f.folder}/${f.filename}`));

    const summary = {
      mode,
      totalFiles:    allFiles.length,
      appliedBefore: applied.size,
      pending:       pending.length,
      pendingList:   pending.map(f => `${f.folder}/${f.filename}`),
    };

    // status 模式：只回報
    if (mode === 'status') {
      return summary;
    }

    // baseline 模式：全部標為已跑
    if (mode === 'baseline') {
      for (const f of pending) await markApplied(client, f.folder, f.filename, 0);
      logger.log(`[Migrator] baseline 完成：新標記 ${pending.length} 支`);
      return { ...summary, baselined: pending.length };
    }

    // auto 模式：如果 tracker 是空的但磁碟上有檔，做首次接入 baseline
    if (mode === 'auto' && applied.size === 0 && allFiles.length > 0) {
      logger.log(`[Migrator] 首次啟動偵測：資料庫還沒有 tracker 紀錄，`
        + `但磁碟上有 ${allFiles.length} 支 SQL 檔案。`);
      logger.log(`[Migrator] 假設這些 migration 之前已手動跑過，將全部 baseline 為「已套用」。`);
      logger.log(`[Migrator] 之後只有新增的 .sql 檔案會被自動執行。`);
      for (const f of allFiles) await markApplied(client, f.folder, f.filename, 0);
      return { ...summary, baselined: allFiles.length, applied: 0, pending: 0, pendingList: [] };
    }

    // apply 模式（或 auto 已 baseline 過）：跑新增的
    if (pending.length === 0) {
      logger.log('[Migrator] 沒有新的 migration，資料庫已是最新');
      return { ...summary, applied: 0 };
    }

    logger.log(`[Migrator] 發現 ${pending.length} 支新 migration，開始執行`);
    const results = [];
    for (const f of pending) {
      const key = `${f.folder}/${f.filename}`;
      const sql = fs.readFileSync(f.filepath, 'utf8');
      logger.log(`[Migrator] → ${key}`);
      const t0 = Date.now();
      try {
        await client.query('BEGIN');
        await client.query(sql);
        const ms = Date.now() - t0;
        await markApplied(client, f.folder, f.filename, ms);
        await client.query('COMMIT');
        results.push({ file: key, ms });
        logger.log(`[Migrator]   ✅ ${key} (${ms}ms)`);
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        logger.error(`[Migrator]   ❌ ${key}：${e.message}`);
        throw new Error(`Migration failed at ${key}: ${e.message}`);
      }
    }
    logger.log(`[Migrator] 完成 ${results.length} 支 migration`);
    return { ...summary, applied: results.length, results };

  } finally {
    if (lockAcquired) {
      try { await client.query('SELECT pg_advisory_unlock($1, $2)', [LOCK_KEY_HI, LOCK_KEY_LO]); }
      catch (_) { /* 連線可能已斷 */ }
    }
    await client.end().catch(() => {});
  }
}

module.exports = { runMigrations, scanFiles, TRACKER_TABLE };
