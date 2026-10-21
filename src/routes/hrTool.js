// routes/hrTool.js —— 人事工具（2026-10-20）掛 /api/hr-tool
// 離職申請（市場部 resign_requests）後續作業：人事確認 → 退保（勞保局 e化服務／健保署）→ 資遣通報（只有資遣）
//   → 離職交接（自動）→ 關閉登入（離職日隔天自動，也可提前／恢復）→ 結案。
// 資料在市場部，經 services/resignClient.js（/api/internal/resign）讀寫；投保單位設定在這邊 report_settings.insurance_units。
// 系統不能代送勞保局／健保署／資遣通報（要憑證或各縣市網站帳號）：只把資料整理好、一鍵開網站、逐欄複製。
const express = require('express');
const router = express.Router();
const supabase = require('../config/supabase');
const { authorize } = require('../middleware/auth');
const rc = require('../services/resignClient');

const ok = (res, data) => res.json({ success: true, data });
const fail = (res, e) => res.status(e.status && e.status < 500 ? e.status : 500).json({ success: false, message: e.message || '伺服器錯誤' });
const HR = ['operation_hr', 'operation_lead', 'super_admin', 'dept_head'];

// 資遣通報受理單位（勞動部說明頁 2026-10 查）：北北中有自己的系統，其他縣市用勞動力發展署
const LAYOFF_SITES = {
  '臺北市': { name: '臺北市政府勞動局－勞動即時通', url: 'https://ap.bola.gov.taipei/ZT.aspx' },
  '新北市': { name: '新北勞動雲－資遣通報', url: 'https://ilabor.ntpc.gov.tw/cloud/LayOffNotice' },
  '臺中市': { name: '臺中市政府勞工局（企業服務 > 資遣員工通報）', url: 'https://www.labor.taichung.gov.tw/1229008/1229025/1238619/1238620/1352678/post' },
};
const LAYOFF_DEFAULT = { name: '勞動部勞動力發展署 資遣通報系統', url: 'https://layoff.ejob.gov.tw/' };
const LINKS = {
  li: { name: '勞保局 e化服務系統（投保單位）', url: 'https://edesk.bli.gov.tw/', note: '要單位憑證＋自然人憑證。勞保、就保、職保、勞退同一張退保申報；離職日前 10 天內可以預辦。' },
  nhi: { name: '健保署 多憑證網路承保作業', url: 'https://eservice.nhi.gov.tw/', note: '健保退保另外辦（不在勞保局那張）。' },
};
function cityOf(store) {
  const t = String((store && (store.city || store.address)) || '').replace(/台/g, '臺');
  const m = t.match(/(臺北市|新北市|桃園市|臺中市|臺南市|高雄市|基隆市|新竹市|嘉義市|新竹縣|苗栗縣|彰化縣|南投縣|雲林縣|嘉義縣|屏東縣|宜蘭縣|花蓮縣|臺東縣|澎湖縣|金門縣|連江縣)/);
  return m ? m[1] : '';
}
async function insuranceUnits() {
  const { data } = await supabase.from('report_settings').select('value').eq('key', 'insurance_units').maybeSingle();
  return Array.isArray(data && data.value) ? data.value : [];
}
function unitFor(units, storeErpid, chosenId) {
  if (chosenId) { const u = units.find((x) => x.id === chosenId); if (u) return u; }
  return units.find((u) => (u.store_erpids || []).map(String).includes(String(storeErpid))) || units.find((u) => u.is_default) || units[0] || null;
}
const roc = (ymd) => { if (!ymd) return ''; const [y, m, d] = String(ymd).split('-'); return `${Number(y) - 1911}/${m}/${d}`; };
const TYPE_NAME = { voluntary: '自願離職', layoff: '資遣', other: '其他' };

// ── 交接（門市交接＋離職交接，唯讀；給「各類流程 → 門市交接表」用）──
router.get('/handovers', async (req, res) => {
  try { ok(res, await rc.call('get', '/handovers', { params: { kind: req.query.kind, status: req.query.status } })); } catch (e) { fail(res, e); }
});
router.get('/handovers/:id', async (req, res) => {
  try { ok(res, await rc.call('get', `/handovers/${encodeURIComponent(req.params.id)}`)); } catch (e) { fail(res, e); }
});

// 交接預設項目（2026-10-21 從市場部後台搬過來；資料仍在市場部 handover_templates，門市交接＋離職交接共用）
const TPL_EDIT = ['operation_lead', 'operation_hr', 'super_admin', 'dept_head'];
router.get('/handover-templates', async (req, res) => {
  try { ok(res, { items: await rc.call('get', '/handover-templates'), can_edit: TPL_EDIT.includes(req.user && req.user.role) }); } catch (e) { fail(res, e); }
});
router.put('/handover-templates', authorize(...TPL_EDIT), async (req, res) => {
  try { ok(res, await rc.call('put', '/handover-templates', { data: { items: (req.body || {}).items }, actor: req.user })); } catch (e) { fail(res, e); }
});

router.use(authorize(...HR));   // 以下限人事

router.get('/list', async (req, res) => {
  try { ok(res, await rc.call('get', '/list', { params: { status: req.query.status || 'open' } })); } catch (e) { fail(res, e); }
});

router.get('/settings', async (req, res) => {
  try {
    const [units, mk] = await Promise.all([insuranceUnits(), rc.call('get', '/settings').catch((e) => ({ error: e.message }))]);
    const { data: hrUsers } = await supabase.from('system_users').select('member_id, name, role').eq('is_active', true).in('role', ['operation_hr', 'operation_lead']);
    ok(res, { insurance_units: units, hr_apps: mk.hr_apps || [], market_error: mk.error || null, hr_users: hrUsers || [] });
  } catch (e) { fail(res, e); }
});
router.put('/settings', authorize('operation_hr', 'operation_lead', 'super_admin'), async (req, res) => {
  try {
    const b = req.body || {};
    if (Array.isArray(b.insurance_units)) {
      const units = b.insurance_units.map((u, i) => ({
        id: String(u.id || `u${Date.now().toString(36)}${i}`),
        name: String(u.name || '').trim().slice(0, 60),
        li_no: String(u.li_no || '').replace(/\s/g, '').slice(0, 20),
        nhi_no: String(u.nhi_no || '').replace(/\s/g, '').slice(0, 20),
        store_erpids: (Array.isArray(u.store_erpids) ? u.store_erpids : String(u.store_erpids || '').split(/[,，\s]+/)).map((x) => String(x).trim()).filter(Boolean),
        is_default: !!u.is_default,
        note: String(u.note || '').slice(0, 200),
      })).filter((u) => u.name);
      await supabase.from('report_settings').upsert({ key: 'insurance_units', value: units });
    }
    if (Array.isArray(b.hr_apps)) await rc.call('put', '/settings', { data: { hr_apps: b.hr_apps }, actor: req.user });
    ok(res, { ok: true });
  } catch (e) { fail(res, e); }
});

router.get('/:id', async (req, res) => {
  try {
    const d = await rc.call('get', `/${encodeURIComponent(req.params.id)}`, { actor: req.user });
    const r = d.request, pii = d.pii || {}, x = r.hr_extra || {};
    const units = await insuranceUnits();
    const unit = unitFor(units, r.store_erpid, x.insurance_unit_id);
    const city = x.city || cityOf(d.store);
    const layoffSite = LAYOFF_SITES[city] || LAYOFF_DEFAULT;
    const gender = x.gender || r.gender || '';
    // 退保要的欄位（照勞保局 e化服務的順序）
    const li = [
      ['投保單位保險證號', unit ? unit.li_no : ''],
      ['姓名', r.name],
      ['身分證統一編號', pii.id_no],
      ['出生日期', pii.birthday ? `${pii.birthday}（民國 ${roc(pii.birthday)}）` : ''],
      ['退保日期', r.resign_date ? `${r.resign_date}（民國 ${roc(r.resign_date)}）` : ''],
    ];
    const nhi = [
      ['投保單位代號', unit ? unit.nhi_no : ''],
      ['姓名', r.name],
      ['身分證統一編號', pii.id_no],
      ['出生日期', pii.birthday ? `${pii.birthday}（民國 ${roc(pii.birthday)}）` : ''],
      ['退保日期', r.resign_date ? `${r.resign_date}（民國 ${roc(r.resign_date)}）` : ''],
      ['退保原因', '離職'],
    ];
    const layoff = [
      ['事業單位', unit ? unit.name : ''],
      ['被資遣員工姓名', r.name],
      ['身分證統一編號', pii.id_no],
      ['性別', gender],
      ['出生日期', pii.birthday || ''],
      ['到職日', x.hire_date || ''],
      ['預定離職日', r.resign_date],
      ['職稱', r.jobtitle || ''],
      ['工作地點', [d.store && d.store.store_name, d.store && d.store.address].filter(Boolean).join(' ')],
      ['資遣事由', x.layoff_reason || ''],
      ['聯絡電話', r.phone || ''],
      ['通訊地址', pii.address || ''],
      ['是否需就業服務', x.need_job_service || ''],
    ];
    ok(res, {
      ...d, units, unit, city,
      forms: {
        li: { ...LINKS.li, fields: li },
        nhi: { ...LINKS.nhi, fields: nhi },
        layoff: { ...layoffSite, city, note: '法定：離職日前 10 日通報（勞基法第 16 條、就服法第 33 條）。網站要手動登入填寫，下面逐欄複製。', fields: layoff },
      },
      type_name: TYPE_NAME[r.resign_type] || '',
    });
  } catch (e) { fail(res, e); }
});

router.post('/:id/action', async (req, res) => {
  try { ok(res, await rc.call('post', `/${encodeURIComponent(req.params.id)}/hr`, { data: req.body || {}, actor: req.user })); } catch (e) { fail(res, e); }
});

module.exports = router;
