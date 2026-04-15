// services/personnelSync.js
// 人員資料同步服務：左手 API → Supabase
// 同時處理：departments 表 + employees 表 + sync_logs 記錄

const supabase = require('../config/supabase');
const { syncAllEmployees } = require('./leftHandApi');
const { SYNC_TYPE, SYNC_STATUS } = require('../config/constants');

/**
 * 執行完整人員同步
 * @param {string} syncType - 'manual' | 'scheduled'
 * @param {string|null} triggeredBy - system_users.id（手動觸發者 UUID）
 * @returns {Promise<{ logId, success, totalCount, successCount, errorCount, errors }>}
 */
async function runEmployeeSync(syncType = SYNC_TYPE.MANUAL, triggeredBy = null) {
  // ── 建立同步記錄（狀態：執行中）──────────────────────────
  const { data: logEntry, error: logCreateErr } = await supabase
    .from('sync_logs')
    .insert({
      sync_type:    syncType,
      status:       SYNC_STATUS.IN_PROGRESS,
      triggered_by: triggeredBy,
      started_at:   new Date().toISOString(),
    })
    .select('id')
    .single();

  if (logCreateErr) {
    console.error('[Sync] 建立 sync_log 失敗：', logCreateErr.message);
    throw new Error('無法建立同步記錄');
  }

  const logId = logEntry.id;
  console.log(`[Sync] 開始同步（${syncType}），Log ID：${logId}`);

  try {
    // ── 取得已知部門清單，補入行政部門 erpid ────────────────
    const { data: knownDepts } = await supabase
      .from('departments')
      .select('store_erpid')
      .eq('is_active', true);

    const extraGroupErpIds = (knownDepts || []).map(d => d.store_erpid).filter(Boolean);
    console.log(`[Sync] 已知部門數：${extraGroupErpIds.length}，將補入 syncAllEmployees`);

    // ── 從左手 API 取得完整資料 ─────────────────────────────
    const { departments, employees, errors: apiErrors } = await syncAllEmployees(extraGroupErpIds);

    // ── 補齊所有員工引用的部門（避免 FK 約束失敗）─────────────
    // 從員工資料收集所有 store_erpid，確保 departments 表中都有對應記錄
    const allDeptMap = {};
    departments.forEach(d => { allDeptMap[d.store_erpid] = d; });
    employees.forEach(emp => {
      if (emp.store_erpid && !allDeptMap[emp.store_erpid]) {
        allDeptMap[emp.store_erpid] = {
          store_erpid: emp.store_erpid,
          store_name:  emp.store_name || '特殊部門',
        };
      }
    });
    // 處理 store_erpid 為空的特殊部門員工：改為 '000000'
    const SPECIAL_DEPT_ERPID = '000000';
    let hasSpecialDept = false;
    employees.forEach(emp => {
      if (!emp.store_erpid) {
        emp.store_erpid = SPECIAL_DEPT_ERPID;
        hasSpecialDept = true;
      }
    });
    if (hasSpecialDept && !allDeptMap[SPECIAL_DEPT_ERPID]) {
      allDeptMap[SPECIAL_DEPT_ERPID] = {
        store_erpid: SPECIAL_DEPT_ERPID,
        store_name:  '特殊部門',
      };
    }

    const allDepts = Object.values(allDeptMap);

    // ── 同步 departments 表（upsert by store_erpid）────────────
    if (allDepts.length > 0) {
      const { error: deptErr } = await supabase
        .from('departments')
        .upsert(
          allDepts.map(d => ({ ...d, updated_at: new Date().toISOString() })),
          { onConflict: 'store_erpid', ignoreDuplicates: false }
        );
      if (deptErr) throw new Error(`部門更新失敗：${deptErr.message}`);
      console.log(`[Sync] 部門更新完成：${allDepts.length} 筆`);
    }

    // ── 去除重複 app_number（同一 app_number 只保留第一筆，其餘設 null）──
    const seenAppNumbers = new Set();
    employees.forEach(emp => {
      if (!emp.app_number) return;
      if (seenAppNumbers.has(emp.app_number)) {
        console.warn(`[Sync] 重複 app_number ${emp.app_number}，員工 ${emp.erpid}(${emp.name}) 設為 null`);
        emp.app_number = null;
      } else {
        seenAppNumbers.add(emp.app_number);
      }
    });

    // ── 同步 employees 表（upsert by erpid）───────────────────
    let successCount = 0;
    const employeeErrors = [...apiErrors];

    // 批次 upsert（每批 50 筆，減少單批失敗影響範圍）
    const batchSize = 50;
    for (let i = 0; i < employees.length; i += batchSize) {
      const batch = employees.slice(i, i + batchSize).map(emp => ({
        ...emp,
        last_synced_at: new Date().toISOString(),
        updated_at:     new Date().toISOString(),
      }));

      const { error: empErr } = await supabase
        .from('employees')
        .upsert(batch, { onConflict: 'erpid', ignoreDuplicates: false });

      if (empErr) {
        console.error(`[Sync] 批次 ${i}~${i + batchSize} 失敗：`, empErr.message);
        employeeErrors.push({ batch: `${i}~${i + batchSize}`, error: empErr.message });
      } else {
        successCount += batch.length;
      }
    }

    // ── 標記離職人員（在資料庫中存在，但此次同步未出現的人員）──
    const syncedErpIds = employees.map(e => e.erpid);
    if (syncedErpIds.length > 0) {
      // Supabase PostgREST in 過濾器不需要引號：(val1,val2,val3)
      const inList = `(${syncedErpIds.join(',')})`;
      const { error: deactErr } = await supabase
        .from('employees')
        .update({ is_active: false, updated_at: new Date().toISOString() })
        .not('erpid', 'in', inList)
        .eq('is_active', true);

      if (deactErr) {
        console.warn('[Sync] 標記離職人員失敗：', deactErr.message);
      }
    }

    // ── 更新 sync_log（成功）─────────────────────────────────
    const finalStatus = employeeErrors.length === 0 ? SYNC_STATUS.SUCCESS : SYNC_STATUS.SUCCESS;
    // 即使有部分錯誤，只要主流程完成就記為 success，錯誤細節記在 error_details

    await supabase
      .from('sync_logs')
      .update({
        status:        finalStatus,
        total_count:   employees.length,
        success_count: successCount,
        error_count:   employeeErrors.length,
        error_details: employeeErrors.length > 0 ? employeeErrors : null,
        finished_at:  new Date().toISOString(),
      })
      .eq('id', logId);

    console.log(`[Sync] 完成：成功 ${successCount}，錯誤 ${employeeErrors.length}`);

    return {
      logId,
      success:      true,
      totalCount:   employees.length,
      successCount,
      errorCount:   employeeErrors.length,
      errors:       employeeErrors,
    };

  } catch (err) {
    // ── 更新 sync_log（失敗）─────────────────────────────────
    await supabase
      .from('sync_logs')
      .update({
        status:       SYNC_STATUS.FAILED,
        error_details: [{ error: err.message }],
        finished_at:  new Date().toISOString(),
      })
      .eq('id', logId);

    console.error('[Sync] 同步失敗：', err.message);

    return {
      logId,
      success:      false,
      totalCount:   0,
      successCount: 0,
      errorCount:   1,
      errors:       [{ error: err.message }],
    };
  }
}

module.exports = { runEmployeeSync };
