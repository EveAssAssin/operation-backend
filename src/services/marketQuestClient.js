// services/marketQuestClient.js
// 市場部任務系統 internal API client
// 用於從營運部送出任務到市場部

const axios = require('axios');

const MARKET_BASE = process.env.MARKET_BACKEND_URL || 'https://market-backend-0544.onrender.com';
const MARKET_KEY  = process.env.MARKET_INTERNAL_KEY || '<2026-ject-2026>';

const marketApi = axios.create({
  baseURL: MARKET_BASE,
  headers: {
    'Content-Type':  'application/json',
    'x-internal-key': MARKET_KEY,
  },
  timeout: 15000,
});

/**
 * 建立任務（市場部 internal API）
 * @param {Object} payload
 *   {
 *     title, description, task_deadline,
 *     source_system, source_system_name, created_by_name,
 *     external_id, award_points,
 *     assignees: [{ type:"group", group_id:"..." }],
 *     required_submission: ["text", ...]
 *   }
 * @returns {Promise<Object>} 市場部回應
 */
async function createQuest(payload) {
  const { data } = await marketApi.post('/api/internal/quest/create', payload);
  return data;
}

/**
 * 列出市場部任務（debug / 對帳用，目前 UI 沒接）
 * @param {Object} params
 */
async function listQuests(params = {}) {
  const { data } = await marketApi.get('/api/internal/quest/list', { params });
  return data;
}

/**
 * 取得市場部 employee_groups 列表（給前端 dropdown）
 * 回傳格式：
 *   { success: true, data: [{ id, name, description, member_count, members? }, ...] }
 * @param {Object} opts
 * @param {boolean} opts.includeMembers - 是否帶 include_members=1
 */
async function listGroups({ includeMembers = false } = {}) {
  const params = includeMembers ? { include_members: 1 } : {};
  const { data } = await marketApi.get('/api/internal/quest/groups', { params });
  return data;
}

module.exports = {
  createQuest,
  listQuests,
  listGroups,
};
