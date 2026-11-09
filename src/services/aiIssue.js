// services/aiIssue.js — AI 問題紀錄回報（2026-11-10 Louis）：送原始資料到市場部 POST /api/internal/ai-issues（x-ai-issue-key＝AI_ISSUE_KEY）
//   分類規則只在市場部 services/aiIssues.js（原則 9）；這裡只決定「要不要送」。fire-and-forget、4 秒逾時，失敗不影響原本流程。
//   與 LAVIS backend/ai-issue.js、業績系統 planning-ai/ai-issue.ts、寵物服務 src/aiIssue.js 同一份邏輯（改一份要四份一起改）
const HINT = /無法|查不到|找不到|沒有.{0,6}(資料|權限|紀錄)|權限|不知道|沒辦法|資料不足|請(洽|詢問|聯絡)|答不出來/;
function track(o) {
  try {
    const key = process.env.AI_ISSUE_KEY || '';
    if (key.length < 32 || !o) return;
    const worth = o.error || o.timed_out || o.unanswered || Number(o.feedback) === -1
      || (Array.isArray(o.tool_errors) && o.tool_errors.some((x) => x && x.error))
      || (o.answer && HINT.test(String(o.answer).slice(0, 600)));
    if (!worth) return;
    const body = { ...o, answer: o.answer ? String(o.answer).slice(0, 1500) : null, question: o.question ? String(o.question).slice(0, 800) : null };
    const url = (process.env.MARKET_API_URL || 'https://market-backend-0544.onrender.com').replace(/\/+$/, '') + '/api/internal/ai-issues';
    fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-ai-issue-key': key }, body: JSON.stringify(body), signal: AbortSignal.timeout(4000) })
      .then((r) => { if (!r.ok) console.warn('[ai-issue] HTTP', r.status); }).catch((e) => console.warn('[ai-issue]', e.message));
  } catch (e) { console.warn('[ai-issue]', e.message); }
}
module.exports = { track };
