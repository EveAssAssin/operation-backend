// jobs/hubPoller.js
// 每 5 分鐘自動掃 Hub 收件匣，處理其他系統 AI 的訊息
// 讓 AI 之間的溝通完全在 server 端自動進行，不再需要用戶介入

const cron = require('node-cron');
const { getInbox, sendMessage, updateStatus } = require('../services/hubClient');

const POLL_SCHEDULE = process.env.HUB_POLL_CRON || '*/5 * * * *'; // 每 5 分鐘

/**
 * 處理單則訊息
 * - request：自動回覆「已收到，處理中」，並 log 以便後續手動跟進
 * - sync / notify：標為 read，記錄到 console
 * - response：標為 done
 */
async function handleMessage(msg) {
  const { id, from_system, category, subject, body, priority } = msg;

  console.log(`[Hub] 收到訊息 [${category}][${priority}] from=${from_system} subject="${subject}"`);

  try {
    if (category === 'request') {
      // 自動回覆「已收到」，讓對方知道我們有看到
      await sendMessage(from_system, 'response', `RE: ${subject}`, '已收到此需求，正在處理中。', {
        ref_message_id: id,
      });
      await updateStatus(id, 'in_progress');
      console.log(`[Hub] request 已自動回覆並標為 in_progress：${subject}`);

    } else if (category === 'response') {
      await updateStatus(id, 'done');
      console.log(`[Hub] response 已標為 done：${subject}`);

    } else {
      // notify / sync → 標為 read，留給後續處理
      await updateStatus(id, 'read');
      console.log(`[Hub] ${category} 已標為 read：${subject}`);
    }
  } catch (err) {
    console.error(`[Hub] 處理訊息失敗 (id=${id})：`, err.message);
  }
}

/**
 * 執行一次收件匣掃描
 */
async function pollInbox() {
  try {
    const result = await getInbox('unread');
    if (!result.success) {
      console.warn('[Hub] 收件匣查詢失敗');
      return;
    }

    if (result.count === 0) return; // 無新訊息，靜默略過

    console.log(`[Hub] 發現 ${result.count} 則未讀訊息，開始處理...`);

    for (const msg of result.data) {
      await handleMessage(msg);
    }
  } catch (err) {
    console.error('[Hub] pollInbox 錯誤：', err.message);
  }
}

/**
 * 啟動排程
 */
function startHubPoller() {
  console.log(`[Hub] 收件匣自動掃描已啟動（${POLL_SCHEDULE}）`);

  cron.schedule(POLL_SCHEDULE, pollInbox, {
    timezone: 'Asia/Taipei',
  });

  // 啟動時立即掃一次（讓已積壓的訊息馬上被處理）
  pollInbox();
}

module.exports = { startHubPoller, pollInbox };
