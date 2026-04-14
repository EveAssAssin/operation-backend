// services/lineUidSync.js
// LINE UID 同步服務：從工單系統 API 批次抓取並填入 employees 表
//
// API 端點：https://ticket.ruki-ai.com/api/v1/employee/
//   - 批次查詢 POST /lookup-batch  { app_numbers: [...] }
//   - 單筆查詢 GET  /lookup?app_number=xxxxx

const https   = require('https');
const http    = require('http');
const supabase = require('../config/supabase');
const { SYNC_STATUS } = require('../config/constants');

const WORKORDER_BASE = process.env.WORKORDER_API_URL || 'https://ticket.ruki-ai.com/api/v1/employee';
const BATCH_SIZE = 50; // 每批最多 50 筆（避免超過 API 限制）

// ── HTTP 請求工具 ─────────────────────────────────────────────
function httpRequest(url, options = {}, body = null) {
  return new Promise((resolve, reject) => {
    const urlObj  = new URL(url);
    const isHttps = urlObj.protocol === 'https:';
    const lib     = isHttps ? https : http;

    const payload = body ? JSON.stringify(body) : null;
    const reqOptions = {
      hostname: urlObj.hostname,
      path:     urlObj.pathname + urlObj.search,
      method:   options.method || 'GET',
      headers:  {
        'Content-Type': 'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
        ...(options.headers || {}),
      },
    };

    const req = lib.request(reqOptions, (res) => {
      let raw = '';
      res.on('data', chunk => raw += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); }
        catch (e) { reject(new Error(`工單 API 回應非 JSON：${raw.slice(0, 100)}`)); }
      });
    });

    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('工單 API 請求超時')); });
    if (payload) req.write(payload);
    req.end();
  });
}

// ── 批次查詢 LINE UID ─────────────────────────────────────────
async function batchLookup(appNumbers) {
  const res = await httpRequest(
    `${WORKORDER_BASE}/lookup-batch`,
    { method: 'POST' },
    { app_numbers: appNumbers }
  );

  if (!res.success) throw new Error(`批次查詢失敗：${res.message || '未知錯誤'}`);
  return res.data || {}; // { app_number: { line_uid, line_bound, ... } }
}

// ── 單筆查詢 LINE UID（補撈用）─────────────────────────────────
async function singleLookup(appNumber) {
  const res = await httpRequest(
    `${WORKORDER_BASE}/lookup?app_number=${encodeURIComponent(appNumber)}`
  );
  if (!res.success || !res.found) return null;
  return res.data;
}

/**
 * 執行完整 LINE UID 同步
 * 流程：
 *   1. 從 employees 取出所有在職且有 app_number 的人員
 *   2. 分批呼叫工單系統批次查詢 API
 *   3. 將取得的 line_uid 更新回 employees 表
 *   4. 記錄到 line_uid_sync_logs
 *
 * @param {string|null} triggeredBy - system_users.id（手動觸發者）
 * @returns {Promise<{ success, updatedCount, errorCount, notBoundCount }>}
 */
async function runLineUidSync(triggeredBy = null) {
  // 建立同步記錄
  const { data: logEntry, error: logErr } = await supabase
    .from('line_uid_sync_logs')
    .insert({
      status:       SYNC_STATUS.IN_PROGRESS,
      triggered_by: triggeredBy,
      started_at:   new Date().toISOString(),
    })
    .select('id')
    .single();

  if (logErr) {
    console.error('[LineUID] 建立 log 失敗：', logErr.message);
    throw new Error('無法建立同步記錄');
  }

  const logId = logEntry.id;
  console.log(`[LineUID] 開始同步，Log ID：${logId}`);

  try {
    // Step 1：取得所有在職且有 app_number 的員工
    const { data: employees, error: empErr } = await supabase
      .from('employees')
      .select('id, app_number, name')
      .eq('is_active', true)
      .not('app_number', 'is', null);

    if (empErr) throw new Error(`讀取員工資料失敗：${empErr.message}`);

    const total = employees.length;
    console.log(`[LineUID] 需同步人員：${total} 人`);

    let updatedCount = 0;
    let notBoundCount = 0;
    const errors = [];

    // Step 2：分批查詢
    for (let i = 0; i < employees.length; i += BATCH_SIZE) {
      const batch    = employees.slice(i, i + BATCH_SIZE);
      const appNums  = batch.map(e => e.app_number);

      let lookupData = {};
      try {
        lookupData = await batchLookup(appNums);
      } catch (err) {
        errors.push({ batch: `${i}~${i + BATCH_SIZE}`, error: err.message });
        continue;
      }

      // Step 3：依回傳結果更新資料庫
      for (const emp of batch) {
        const info = lookupData[emp.app_number];

        if (!info) {
          // 工單系統查無此人員（可能尚未建立）
          continue;
        }

        if (!info.line_bound || !info.line_uid) {
          notBoundCount++;
          // 未綁定 LINE：清空 line_uid（保持 null）
          continue;
        }

        // 有 LINE UID → 寫入資料庫
        const { error: updateErr } = await supabase
          .from('employees')
          .update({
            line_uid:   info.line_uid,
            updated_at: new Date().toISOString(),
          })
          .eq('id', emp.id);

        if (updateErr) {
          errors.push({ erpid: emp.app_number, error: updateErr.message });
        } else {
          updatedCount++;
        }
      }
    }

    // 更新 sync_log（成功）
    await supabase
      .from('line_uid_sync_logs')
      .update({
        status:        SYNC_STATUS.SUCCESS,
        total_count:   total,
        updated_count: updatedCount,
        error_count:   errors.length,
        error_details: errors.length > 0 ? errors : null,
        completed_at:  new Date().toISOString(),
      })
      .eq('id', logId);

    console.log(`[LineUID] 完成：更新 ${updatedCount}，未綁定 ${notBoundCount}，錯誤 ${errors.length}`);

    return {
      logId,
      success:      true,
      total,
      updatedCount,
      notBoundCount,
      errorCount:   errors.length,
    };

  } catch (err) {
    await supabase
      .from('line_uid_sync_logs')
      .update({
        status:       SYNC_STATUS.FAILED,
        error_details: [{ error: err.message }],
        completed_at:  new Date().toISOString(),
      })
      .eq('id', logId);

    console.error('[LineUID] 同步失敗：', err.message);

    return {
      logId,
      success:      false,
      total:        0,
      updatedCount: 0,
      errorCount:   1,
    };
  }
}

module.exports = { runLineUidSync, singleLookup };
