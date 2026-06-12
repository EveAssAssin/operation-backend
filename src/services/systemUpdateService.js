// services/systemUpdateService.js
//   「系統更新」模組業務邏輯
//   - 從 GitHub Commits API 抓 commits
//   - 解析 conventional commit 類型（feat / fix / chore / refactor / docs）
//   - 分日 / 分月整理

const supabase = require('../config/supabase');

// ── 工具 ────────────────────────────────────────────────────

/** 解析「feat: xxx」「fix(scope): xxx」這種 conventional commit 為 { type, scope, subject } */
function parseConventional(msg) {
  if (!msg) return { type: 'other', scope: null, subject: msg || '' };
  const firstLine = msg.split('\n')[0];
  const m = firstLine.match(/^(\w+)(?:\(([^)]+)\))?\s*:\s*(.+)$/);
  if (!m) return { type: 'other', scope: null, subject: firstLine };
  return {
    type:    m[1].toLowerCase(),
    scope:   m[2] || null,
    subject: m[3].trim(),
  };
}

/** 取台北時區的 YYYY-MM-DD */
function toTaipeiDate(isoStr) {
  return new Date(isoStr).toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' });
}

/** 取台北時區的 YYYY-MM */
function toTaipeiYM(isoStr) {
  return toTaipeiDate(isoStr).slice(0, 7);
}

// ── 成員 / Repo CRUD ────────────────────────────────────────

async function listMembers() {
  const { data: members, error } = await supabase
    .from('system_update_members')
    .select('*')
    .eq('is_active', true)
    .order('display_order', { ascending: true });
  if (error) throw new Error(error.message);

  // 撈每個成員的 repos
  const { data: repos, error: rErr } = await supabase
    .from('system_update_repos')
    .select('id, member_id, repo_label, github_owner, github_repo, is_active');
  if (rErr) throw new Error(rErr.message);

  return (members || []).map(m => ({
    ...m,
    repos: (repos || []).filter(r => r.member_id === m.id && r.is_active),
  }));
}

async function getMemberRepos(memberId) {
  const { data, error } = await supabase
    .from('system_update_repos')
    .select('*')
    .eq('member_id', memberId)
    .eq('is_active', true);
  if (error) throw new Error(error.message);
  return data || [];
}


// ── GitHub API ──────────────────────────────────────────────

async function fetchCommitsFromRepo(repo, sinceISO, untilISO) {
  // GitHub API：/repos/:owner/:repo/commits?since=...&until=...&per_page=100
  const url = new URL(`https://api.github.com/repos/${repo.github_owner}/${repo.github_repo}/commits`);
  if (sinceISO) url.searchParams.set('since', sinceISO);
  if (untilISO) url.searchParams.set('until', untilISO);
  url.searchParams.set('per_page', '100');

  const headers = {
    'Accept':               'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent':           'operation-backend',
  };
  // token：repo 有設用 repo 的；沒設 fallback 環境變數 GITHUB_TOKEN
  const token = repo.github_token || process.env.GITHUB_TOKEN || null;
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const commits = [];
  let nextUrl = url.toString();
  let safety  = 5;   // 最多翻 5 頁（500 筆）
  while (nextUrl && safety-- > 0) {
    const res = await fetch(nextUrl, { headers });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`GitHub API ${res.status}: ${text.slice(0, 200)}`);
    }
    const arr = await res.json();
    for (const c of arr) {
      const commit = c.commit || {};
      const parsed = parseConventional(commit.message || '');
      commits.push({
        sha:         c.sha,
        date:        commit.author?.date || commit.committer?.date || null,
        message:     commit.message || '',
        type:        parsed.type,
        scope:       parsed.scope,
        subject:     parsed.subject,
        author_name: commit.author?.name || '',
        repo_label:  repo.repo_label || `${repo.github_owner}/${repo.github_repo}`,
      });
    }
    // 取 Link header 的 next
    const link = res.headers.get('link') || '';
    const m = link.match(/<([^>]+)>;\s*rel="next"/);
    nextUrl = m ? m[1] : null;
  }
  return commits;
}


// ── 業務查詢 ────────────────────────────────────────────────

/**
 * 該成員「最近 N 天」的詳細 commits（依日期分組）
 *   回傳 [{ date: 'YYYY-MM-DD', commits: [...] }]，新 → 舊
 */
async function dailyCommits(memberId, days = 14) {
  const repos = await getMemberRepos(memberId);
  if (repos.length === 0) {
    return { days: [], total: 0, repos: [] };
  }
  const sinceISO = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();

  const all = [];
  for (const repo of repos) {
    try {
      const cs = await fetchCommitsFromRepo(repo, sinceISO);
      all.push(...cs);
    } catch (e) {
      console.warn('[systemUpdate] fetch fail', repo.github_owner, repo.github_repo, e.message);
    }
  }

  // 過濾 merge commit（commit message 開頭是 Merge）
  const filtered = all.filter(c => !/^Merge /.test(c.message));

  // 依日期分組
  const byDate = {};
  for (const c of filtered) {
    const d = toTaipeiDate(c.date);
    (byDate[d] = byDate[d] || []).push(c);
  }
  const dayList = Object.keys(byDate).sort().reverse().map(d => ({
    date:    d,
    commits: byDate[d].sort((a, b) => (b.date || '').localeCompare(a.date || '')),
  }));

  return {
    days:      dayList,
    total:     filtered.length,
    repos:     repos.map(r => `${r.github_owner}/${r.github_repo}`),
    since:     sinceISO,
  };
}

/**
 * 該成員指定月份的摘要（依 type 分類）
 *   yearMonth: 'YYYY-MM'
 */
async function monthlySummary(memberId, yearMonth) {
  const repos = await getMemberRepos(memberId);
  if (repos.length === 0 || !/^\d{4}-\d{2}$/.test(yearMonth)) {
    return { yearMonth, total: 0, by_type: {}, repos: [] };
  }
  const [y, m] = yearMonth.split('-').map(Number);
  // 該月 1 號 ~ 下月 1 號 (用台北時區)
  const sinceTpe = new Date(Date.UTC(y, m - 1, 1, -8, 0, 0)).toISOString();
  const untilTpe = new Date(Date.UTC(y, m,     1, -8, 0, 0)).toISOString();

  const all = [];
  for (const repo of repos) {
    try {
      const cs = await fetchCommitsFromRepo(repo, sinceTpe, untilTpe);
      all.push(...cs);
    } catch (e) {
      console.warn('[systemUpdate] fetch fail', repo.github_owner, repo.github_repo, e.message);
    }
  }

  const filtered = all.filter(c => !/^Merge /.test(c.message));

  // 依 type 分組
  const byType = {};
  for (const c of filtered) {
    const t = c.type || 'other';
    (byType[t] = byType[t] || []).push(c);
  }
  // 同型內依時間倒序
  for (const t of Object.keys(byType)) {
    byType[t].sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  }

  return {
    yearMonth,
    total:   filtered.length,
    by_type: byType,           // { feat: [...], fix: [...], chore: [...] }
    repos:   repos.map(r => `${r.github_owner}/${r.github_repo}`),
  };
}

/** 可用的月份清單（往前推 12 個月） */
function listAvailableMonths() {
  const out = [];
  const now = new Date();
  for (let i = 0; i < 12; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  }
  return out;
}


module.exports = {
  listMembers,
  getMemberRepos,
  dailyCommits,
  monthlySummary,
  listAvailableMonths,
  parseConventional,
};
