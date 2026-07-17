// jobs/notifyDuplicateNeeds.js
// 每天 11:00 檢查重複的人力需求並推播給建需求的人
//   重複定義：同一門市「且」同一備註 有 2 筆以上 status='open' 的需求
//     ─ 備註空白視為同一組（都是「未註記」）
//     ─ 同門市但不同備註（例：營運部/人事行政 vs 營運部/稽查專員）→ 不算重複
//   推播對象：每筆需求的 created_by_app_number（若 null 則跳過該筆，不推）
//   每位 created_by_app_number 一天最多收到一則「該組重複」的提醒（去重）

const cron     = require('node-cron');
const supabase = require('../config/supabase');
const { pushToUser } = require('../services/linePushService');

// 備註正規化：null / undefined / 全空白 都當「」，前後去空白
function normalizeNote(note) {
  return String(note || '').trim();
}

/**
 * 找出有重複 open 需求的（門市 + 備註）組，及對應的需求紀錄
 * @returns {Map<key, { store_erpid, store_name, note, needs: [] }>}
 *   key = `${store_erpid}|${normalizeNote(note)}`
 */
async function findDuplicateStores() {
  const { data, error } = await supabase
    .from('recruitment_needs')
    .select('id, store_erpid, store_name, total_needed, urgent_needed, note, created_at, created_by_app_number, source')
    .eq('status', 'open')
    .order('created_at', { ascending: true });
  if (error) throw error;

  const map = new Map(); // key -> { store_erpid, store_name, note, needs: [] }
  for (const n of (data || [])) {
    const noteKey = normalizeNote(n.note);
    const key = `${n.store_erpid}|${noteKey}`;
    if (!map.has(key)) {
      map.set(key, {
        store_erpid: n.store_erpid,
        store_name:  n.store_name,
        note:        noteKey,
        needs:       [],
      });
    }
    map.get(key).needs.push(n);
  }
  // 過濾出重複的
  const duplicates = new Map();
  for (const [k, v] of map) {
    if (v.needs.length >= 2) duplicates.set(k, v);
  }
  return duplicates;
}

/**
 * 組推播訊息
 * @param {string} storeName
 * @param {Array}  needs
 * @param {string} note  該組的備註（空字串表示無備註）
 */
function buildMessage(storeName, needs, note = '') {
  const noteTag = note ? `／${note}` : '（無備註）';
  let msg = `⚠ 人力需求重複提醒\n`;
  msg += '─'.repeat(20) + '\n';
  msg += `【${storeName}${noteTag}】已建立過相同需求，請確認是否為重複派工。\n`;
  msg += '─'.repeat(20) + '\n';
  msg += `目前 ${needs.length} 筆 open 需求：\n`;
  for (const n of needs) {
    const dateStr = new Date(n.created_at).toLocaleDateString('zh-TW', { timeZone: 'Asia/Taipei' });
    const urgent  = n.urgent_needed > 0 ? `（急 ${n.urgent_needed}）` : '';
    msg += `• ${dateStr}：${n.total_needed} 人${urgent}`;
    if (n.note) msg += `\n  備註：${n.note}`;
    msg += '\n';
  }
  msg += '\n請至「人力招募」確認，並關閉重複的需求。';
  return msg;
}

/**
 * 執行檢查 + 推播
 */
async function checkAndNotify() {
  const duplicates = await findDuplicateStores();
  if (duplicates.size === 0) {
    console.log('[DupNeeds] 無重複需求，略過推播');
    return { stores: 0, notified: 0, skipped: true };
  }

  // 收集每個 created_by_app_number 對應的所有重複門市
  // app_number -> [{ store_name, needs }]
  const userMap = new Map();
  for (const [_, info] of duplicates) {
    const uniqueCreators = new Set(
      info.needs.map(n => n.created_by_app_number).filter(Boolean)
    );
    for (const appNumber of uniqueCreators) {
      if (!userMap.has(appNumber)) userMap.set(appNumber, []);
      userMap.get(appNumber).push(info);
    }
  }

  if (userMap.size === 0) {
    console.log('[DupNeeds] 重複需求都無 created_by（system 來源），跳過推播');
    return { stores: duplicates.size, notified: 0, skipped: true };
  }

  let pushed = 0;
  for (const [appNumber, stores] of userMap) {
    // 一個人可能有多組（門市+備註）重複；合併成一則訊息
    let combined = '';
    for (const s of stores) {
      combined += buildMessage(s.store_name, s.needs, s.note) + '\n\n';
    }
    try {
      await pushToUser(appNumber, combined.trim());
      pushed++;
    } catch (err) {
      console.error(`[DupNeeds] 推播失敗 → ${appNumber}：`, err.message);
    }
  }

  return { stores: duplicates.size, notified: pushed, skipped: false };
}

/**
 * 啟動排程：每天 11:00（Asia/Taipei）
 */
function startDuplicateNeedsNotifyJob() {
  cron.schedule('0 11 * * *', async () => {
    console.log('[DupNeeds] 定時檢查重複需求...');
    try {
      const result = await checkAndNotify();
      console.log('[DupNeeds] 完成：', JSON.stringify(result));
    } catch (err) {
      console.error('[DupNeeds] 失敗：', err.message);
    }
  }, { timezone: 'Asia/Taipei' });

  console.log('[DupNeeds] 重複需求推播排程已啟動（每天 11:00）');
}

module.exports = {
  startDuplicateNeedsNotifyJob,
  checkAndNotify,
  findDuplicateStores,
  buildMessage,
};
