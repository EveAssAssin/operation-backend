// routes/regulationsInternal.js — 企劃部平台（發文工作室企劃 AI）→「一鍵轉規範草稿」（2026-11-09 Louis）
//   header x-planning-key＝PLANNING_REG_KEY（營運部＋業績系統 Render 共用，至少 32 字）
//   POST /clarify  { app_number, reference_ids[1..3], requirement, title } → 先確認方向（同 /regulations/ref-generate/clarify）
//   POST /generate { app_number, reference_ids, requirement, title, category } → { job }；背景：RefGen.generate → 建新規範＋草稿
//   GET  /job/:id?app_number=… → { status: running|done|error, result:{ version_id, regulation_id, version, title, ai_notes, stats } }
//   草稿建立者＝這位企劃人員（created_by_id＝app:<APP 編號>，同 App「提出規範修改」→ App「我的提案」也看得到）；名字後綴「（企劃 AI）」。
//   一律只建草稿、不送審；送審由人在規範管理按。
const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const RefGen = require('../services/regulationRefGen');
const reg = require('../services/regulationService');
const pub = require('../services/regulationPublic');

const ok = (res, data) => res.json({ success: true, data });
const fail = (res, e, code = 400) => res.status(e.status || code).json({ success: false, message: e.message || String(e) });

router.use((req, res, next) => {
  const key = String(process.env.PLANNING_REG_KEY || '');
  const got = String(req.headers['x-planning-key'] || '');
  const a = Buffer.from(key), b = Buffer.from(got);
  if (key.length < 32 || a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(403).json({ success: false, message: 'forbidden' });
  next();
});
async function who(req) {
  const app = String(req.body?.app_number || req.query.app_number || '').trim();
  if (!/^\d{4,12}$/.test(app)) { const e = new Error('缺少企劃人員的 APP 編號'); e.status = 400; throw e; }
  const emp = await pub.verify(app);   // 在職員工才過
  return { emp, user: { id: `app:${emp.app_number}`, name: `${emp.name}（企劃 AI）`, erpid: emp.erpid, role: 'app_staff' } };
}

router.post('/clarify', async (req, res) => {
  try { await who(req); ok(res, await RefGen.clarify(req.body || {})); } catch (e) { fail(res, e); }
});

const jobs = new Map();   // id → { owner, status, result, error, at }
router.post('/generate', async (req, res) => {
  try {
    const { emp, user } = await who(req);
    const b = req.body || {};
    const id = crypto.randomBytes(9).toString('hex');
    const owner = `pa:${emp.app_number}`;
    jobs.set(id, { owner, status: 'running', at: Date.now() });
    (async () => {
      const g = await RefGen.generate({ reference_ids: b.reference_ids, requirement: b.requirement, title: b.title });
      const title = String(b.title || g.title || '').trim().slice(0, 120) || '未命名規範';
      const category = String(b.category || '').trim() || '行銷類--活動策劃';
      const v0 = await reg.createNewRegulation({ title, category }, user);
      const doc = { title, category, doc_type: null, summary: g.summary || '', scenario: g.scenario || '', owner_dept: '', roles: [], sections: g.sections };
      const refs = (g.references || []).map((r) => `#${r.id}《${r.title}》`).join('、');
      const v = await reg.saveDraft(v0.id, { doc, change_note: `企劃 AI 依企劃案產生（參考 ${refs}）` }, user);
      return { version_id: v.id, regulation_id: v.regulation_id, version: v.version, title, ai_notes: g.ai_notes, stats: g.stats, references: g.references };
    })()
      .then((result) => jobs.set(id, { owner, status: 'done', result, at: Date.now() }))
      .catch((e) => { const m = e.response?.data?.error?.message || e.message; console.warn('[regInternal] 產生失敗：', m); jobs.set(id, { owner, status: 'error', error: m, at: Date.now() }); });
    for (const [k, v] of jobs) if (Date.now() - v.at > 3 * 3600e3) jobs.delete(k);
    ok(res, { job: id });
  } catch (e) { fail(res, e); }
});
router.get('/job/:id', async (req, res) => {
  try {
    const { emp } = await who(req);
    const j = jobs.get(String(req.params.id));
    if (!j || j.owner !== `pa:${emp.app_number}`) return fail(res, new Error('找不到這個產生工作（營運部系統重新啟動過的話請再按一次）'), 404);
    ok(res, { status: j.status, result: j.result || null, error: j.error || null });
  } catch (e) { fail(res, e); }
});


// ── 規範草稿提醒／清除：手動跑（驗收用；only_ids 只處理指定版本）2026-11-09 ──
//   POST /drafts/jobs { job: remind_idle|remind_daily|cleanup, dry, only_ids:[] }
//   POST /drafts/notify-reviewer { version_id } → 重送一次「送審通知」給審核人（report_settings.regulation_reviewer）
router.post('/drafts/jobs', async (req, res) => {
  try {
    const Care = require('../services/regulationDraftCare');
    const b = req.body || {}; const onlyIds = Array.isArray(b.only_ids) && b.only_ids.length ? b.only_ids : null;
    const dry = b.dry !== false;
    if (!onlyIds && !dry) return fail(res, Object.assign(new Error('非 dry 一定要帶 only_ids'), { status: 400 }));
    const r = b.job === 'cleanup' ? await Care.cleanupDrafts({ dry, onlyIds })
      : await Care.remindDrafts({ mode: b.job === 'remind_daily' ? 'daily' : 'idle', dry, onlyIds });
    ok(res, r);
  } catch (e) { fail(res, e); }
});
router.post('/drafts/notify-reviewer', async (req, res) => {
  try {
    const supabase = require('../config/supabase');
    const v = await reg.getVersion(Number(req.body?.version_id));
    const { data: r } = await supabase.from('regulations').select('*').eq('id', v.regulation_id).single();
    await reg.notifyReviewer(v, r);
    ok(res, { sent_to: (await reg.getReviewer()).name });
  } catch (e) { fail(res, e); }
});

module.exports = router;
