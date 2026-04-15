// services/hubClient.js
// AI Hub Client — 讓營運部系統後端自動與其他系統 AI 溝通
// 不再需要用戶透過瀏覽器 Console 手動收發訊息

const axios = require('axios');

const HUB_BASE   = process.env.HUB_BASE_URL  || 'https://operation-backend.onrender.com/api/hub';
const HUB_KEY    = process.env.HUB_API_KEY   || 'lohas-ai-hub-2026';
const SYSTEM_ID  = 'operation';

const hubApi = axios.create({
  baseURL:  HUB_BASE,
  headers:  { 'x-hub-key': HUB_KEY, 'Content-Type': 'application/json' },
  timeout:  10000,
});

/**
 * 取得收件匣
 * @param {string} status - unread | read | in_progress | done
 * @returns {Promise<{ count, data }>}
 */
async function getInbox(status = 'unread') {
  const { data } = await hubApi.get(`/inbox/${SYSTEM_ID}`, { params: { status } });
  return data;
}

/**
 * 發送訊息
 * @param {string} to       - 目標系統代碼 或 'all'
 * @param {string} category - request | response | notify | sync
 * @param {string} subject  - 主旨
 * @param {string} body     - 詳細內容（markdown）
 * @param {Object} opts     - 選填：{ priority, ref_message_id }
 */
async function sendMessage(to, category, subject, body, opts = {}) {
  const { data } = await hubApi.post('/send', {
    from_system:    SYSTEM_ID,
    to_system:      to,
    category,
    subject,
    body,
    priority:       opts.priority       || 'normal',
    ref_message_id: opts.ref_message_id || null,
  });
  console.log(`[Hub] 訊息已送出 → ${to} [${category}] ${subject}`);
  return data;
}

/**
 * 更新訊息狀態
 * @param {string} msgId  - 訊息 UUID
 * @param {string} status - read | in_progress | done | rejected
 */
async function updateStatus(msgId, status) {
  const { data } = await hubApi.patch(`/messages/${msgId}/status`, {
    status,
    system_id: SYSTEM_ID,
  });
  return data;
}

/**
 * 取得訊息串（原始訊息 + 所有回覆）
 */
async function getThread(messageId) {
  const { data } = await hubApi.get(`/thread/${messageId}`);
  return data;
}

module.exports = { getInbox, sendMessage, updateStatus, getThread, SYSTEM_ID };
