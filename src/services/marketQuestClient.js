// services/marketQuestClient.js
// 市場部任務系統 internal API client
// - 派發：營運部 → 市場部建立任務
// - 審核：market 員工提交後，營運部審核（通過 / 駁回 / 退回重交）

const axios = require('axios');

const MARKET_BASE = process.env.MARKET_BACKEND_URL || 'https://market-backend-0544.onrender.com';
const MARKET_KEY  = process.env.MARKET_INTERNAL_KEY || '<2026-ject-2026>';

const marketApi = axios.create({
  baseURL: MARKET_BASE,
  headers: {
    'Content-Type':  'application/json',
    'x-internal-key': MARKET_KEY,
  },
  timeout: 20000,
});

// ──────────────────────────────────────────────────────────
// 派發 / 群組
// ──────────────────────────────────────────────────────────

/**
 * 建立任務
 * @param {Object} payload
 *   { title, description, task_deadline, source_system, source_system_name,
 *     created_by_name, external_id, award_points,
 *     assignees: [{type:"group", group_id:"..."}],
 *     required_submission: ["text", ...] }
 */
async function createQuest(payload) {
  const { data } = await marketApi.post('/api/internal/quest/create', payload);
  return data;
}

/**
 * 列出市場部任務（debug / 對帳用）
 */
async function listQuests(params = {}) {
  const { data } = await marketApi.get('/api/internal/quest/list', { params });
  return data;
}

/**
 * 取得市場部 employee_groups 列表
 * @param {Object} opts
 * @param {boolean} opts.includeMembers
 */
async function listGroups({ includeMembers = false } = {}) {
  const params = includeMembers ? { include_members: 1 } : {};
  const { data } = await marketApi.get('/api/internal/quest/groups', { params });
  return data;
}

// ──────────────────────────────────────────────────────────
// 審核（key 自動 filter source_system，後端只回我們派的任務）
// ──────────────────────────────────────────────────────────

/**
 * 列出待審核交付
 * 回應：{ success, data: [{ id, quest_id, member_id, name, submitted_at,
 *                          submission_data, quests: { id, title, ... } }] }
 */
async function listPendingSubmissions() {
  const { data } = await marketApi.get('/api/internal/quest/submissions/pending');
  return data;
}

/**
 * 列出已審核紀錄
 * @param {Object} opts
 * @param {number} opts.limit
 */
async function listReviewedSubmissions({ limit = 50 } = {}) {
  const { data } = await marketApi.get('/api/internal/quest/submissions/reviewed', {
    params: { limit },
  });
  return data;
}

/**
 * 通過
 * @param {string} submissionId
 * @param {Object} body  { reviewer_name (必填), reviewer_member_id (選填) }
 */
async function approveSubmission(submissionId, body) {
  const { data } = await marketApi.post(
    `/api/internal/quest/submissions/${submissionId}/approve`,
    body
  );
  return data;
}

/**
 * 駁回（任務失敗，員工不能再交）
 * @param {string} submissionId
 * @param {Object} body  { reason (必填), reviewer_name (必填) }
 */
async function rejectSubmission(submissionId, body) {
  const { data } = await marketApi.post(
    `/api/internal/quest/submissions/${submissionId}/reject`,
    body
  );
  return data;
}

/**
 * 退回重交（員工可重新提交）
 * @param {string} submissionId
 * @param {Object} body  { reason (必填), reviewer_name (必填) }
 */
async function rejectResubmitSubmission(submissionId, body) {
  const { data } = await marketApi.post(
    `/api/internal/quest/submissions/${submissionId}/reject-resubmit`,
    body
  );
  return data;
}

module.exports = {
  // 派發
  createQuest,
  listQuests,
  listGroups,
  // 審核
  listPendingSubmissions,
  listReviewedSubmissions,
  approveSubmission,
  rejectSubmission,
  rejectResubmitSubmission,
};
