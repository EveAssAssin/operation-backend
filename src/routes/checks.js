// routes/checks.js
// 支票紀錄系統 API（v2）

const express  = require('express');
const router   = express.Router();
const multer   = require('multer');
const XLSX     = require('xlsx');
const { authenticate, authorize } = require('../middleware/auth');
const svc      = require('../services/checkService');
const { fetchAndCacheYear } = require('../services/taiwanHolidayService');

// 所有路由需登入
router.use(authenticate);

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// ── 工具 ─────────────────────────────────────────────────
function ok(res, data)  { res.json({ success: true, data }); }
function err(res, e, code = 400) {
  res.status(code).json({ success: false, message: e.message || e });
}

// ══════════════════════════════════════════════════════════
// 支票科目
// ══════════════════════════════════════════════════════════
router.get('/subjects', async (req, res) => {
  try { ok(res, await svc.getSubjects()); } catch(e) { err(res, e, 500); }
});

router.post('/subjects', async (req, res) => {
  try {
    const { name } = req.body;
    if (!name) return err(res, { message: '請填寫科目名稱' });
    ok(res, await svc.createSubject(name));
  } catch(e) { err(res, e); }
});

router.patch('/subjects/:id', async (req, res) => {
  try { ok(res, await svc.updateSubject(req.params.id, req.body)); } catch(e) { err(res, e); }
});

// ══════════════════════════════════════════════════════════
// 支票批次
// ══════════════════════════════════════════════════════════
router.get('/batches', async (req, res) => {
  try { ok(res, await svc.getBatches(req.query)); } catch(e) { err(res, e, 500); }
});

router.get('/batches/:id', async (req, res) => {
  try { ok(res, await svc.getBatchById(req.params.id)); } catch(e) { err(res, e, 500); }
});

router.post('/batches', async (req, res) => {
  try { ok(res, await svc.createBatch(req.body)); } catch(e) { err(res, e); }
});

router.patch('/batches/:id', async (req, res) => {
  try { ok(res, await svc.updateBatch(req.params.id, req.body)); } catch(e) { err(res, e); }
});

// ══════════════════════════════════════════════════════════
// 個別支票操作
// ══════════════════════════════════════════════════════════
router.patch('/checks/:id', async (req, res) => {
  try { ok(res, await svc.updateCheck(req.params.id, req.body)); } catch(e) { err(res, e); }
});

router.post('/checks/:id/pay', async (req, res) => {
  try { ok(res, await svc.payCheck(req.params.id)); } catch(e) { err(res, e); }
});

router.post('/checks/:id/bounce', async (req, res) => {
  try { ok(res, await svc.bounceCheck(req.params.id)); } catch(e) { err(res, e); }
});

router.post('/checks/:id/void', async (req, res) => {
  try {
    const { void_reason } = req.body;
    ok(res, await svc.voidCheck(req.params.id, void_reason));
  } catch(e) { err(res, e); }
});

// ══════════════════════════════════════════════════════════
// 出款清單
// ══════════════════════════════════════════════════════════
router.get('/today', async (req, res) => {
  try { ok(res, await svc.getTodayDueChecks()); } catch(e) { err(res, e, 500); }
});

router.get('/upcoming', async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 7;
    ok(res, await svc.getUpcomingChecks(days));
  } catch(e) { err(res, e, 500); }
});

// ══════════════════════════════════════════════════════════
// 台灣假日手動更新
// ══════════════════════════════════════════════════════════
router.post('/holidays/refresh', async (req, res) => {
  try {
    const year = parseInt(req.query.year) || new Date().getFullYear();
    await fetchAndCacheYear(year);
    ok(res, { message: `${year} 年假日已更新` });
  } catch(e) { err(res, e, 500); }
});

// ══════════════════════════════════════════════════════════
// 通知名單
// ══════════════════════════════════════════════════════════
router.get('/notify-targets', async (req, res) => {
  try { ok(res, await svc.getNotifyTargets()); } catch(e) { err(res, e, 500); }
});

router.post('/notify-targets', async (req, res) => {
  try {
    const { name, app_number, notes } = req.body;
    if (!name || !app_number) return err(res, { message: '請填寫姓名與員工編號' });
    ok(res, await svc.createNotifyTarget({ name, app_number, notes }));
  } catch(e) { err(res, e); }
});

router.patch('/notify-targets/:id', async (req, res) => {
  try { ok(res, await svc.updateNotifyTarget(req.params.id, req.body)); } catch(e) { err(res, e); }
});

router.delete('/notify-targets/:id', async (req, res) => {
  try {
    await svc.deleteNotifyTarget(req.params.id);
    ok(res, { message: '已刪除' });
  } catch(e) { err(res, e); }
});

// ══════════════════════════════════════════════════════════
// 刪除批次 / 清除全部 / 補標已付款
// ══════════════════════════════════════════════════════════

// 刪除單一批次（含其下所有支票）
router.delete('/batches/:id', authorize('operation_lead', 'super_admin'), async (req, res) => {
  try { ok(res, await svc.deleteBatch(req.params.id)); } catch(e) { err(res, e, 500); }
});

// 清除全部支票資料
router.post('/clear-all', authorize('operation_lead', 'super_admin'), async (req, res) => {
  try { ok(res, await svc.clearAll()); } catch(e) { err(res, e, 500); }
});

// 批次補標已付款：到期日 < 今天 且 status=pending → paid
router.post('/bulk-pay-past', authorize('operation_lead', 'super_admin'), async (req, res) => {
  try { ok(res, await svc.bulkPayPast()); } catch(e) { err(res, e, 500); }
});

// ══════════════════════════════════════════════════════════
// Excel 匯入
// ══════════════════════════════════════════════════════════

// ── 解析出款戶名 ─────────────────────────────────────────
function parseDrawer(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const s = raw.trim();

  // 特殊：董事長高銀票10643 → 黃志雄/高銀
  if (s.includes('董事長')) return { drawer_name: '黃志雄', bank_name: '高銀' };

  // 標準：黃信儒高銀 / 黃志雄高銀 / 黃志雄三信
  const match = s.match(/^(黃信儒|黃志雄)(高銀|三信)/);
  if (match) return { drawer_name: match[1], bank_name: match[2] };

  return null; // 非標準 → 跳過
}

// ── 驗證日期是否真實存在 ─────────────────────────────────
function isValidDate(dateStr) {
  // dateStr 格式：YYYY-MM-DD
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
}

// ── 解析支票日期（民國/西元混合）────────────────────────
function parseDate(raw) {
  if (!raw) return null;

  let result = null;

  // 若是 Excel datetime（number）
  if (typeof raw === 'number') {
    // xlsx 序列日期
    const d = XLSX.SSF.parse_date_code(raw);
    if (!d) return null;
    const year = d.y < 1900 ? d.y + 1911 : d.y; // 民國年轉換
    result = `${year}-${String(d.m).padStart(2,'0')}-${String(d.d).padStart(2,'0')}`;
  } else {
    const s = String(raw).trim();

    // 民國年格式：107.10.30 或 107/10/30
    const roc = s.match(/^(\d{2,3})[./](\d{1,2})[./](\d{1,2})$/);
    if (roc) {
      const [, y, m, d] = roc;
      const year = parseInt(y) < 1000 ? parseInt(y) + 1911 : parseInt(y);
      result = `${year}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    }

    if (!result) {
      // 西元格式：2018.10.10 / 2018/10/10 / 2018-10-10
      const ce = s.match(/^(\d{4})[./-](\d{1,2})[./-](\d{1,2})$/);
      if (ce) {
        const [, y, m, d] = ce;
        result = `${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
      }
    }
  }

  // 額外驗證：確認該日期真實存在（例如排除 2019-02-30）
  if (result && !isValidDate(result)) return null;

  return result;
}

// ── 解析備註 → 科目 & 序號 ──────────────────────────────
// 格式：東山12-1 → subject=東山, totalInNote=12, seq=1
function parseNote(raw) {
  if (!raw) return { subject: null, seq: null, rawNote: null };
  const s = String(raw).trim();

  // 過濾特殊標記
  if (s.includes('請續票') || s.includes('作廢')) {
    return { subject: null, seq: null, rawNote: s, specialFlag: s };
  }

  // 格式：{中文地點}{數字}-{序號}
  const m = s.match(/^([\u4e00-\u9fff\w]+?)(\d+)-(\d+)$/);
  if (m) {
    return {
      subject:      m[1],
      totalInNote:  parseInt(m[2]),
      seq:          parseInt(m[3]),
      rawNote:      s,
    };
  }

  return { subject: null, seq: null, rawNote: s };
}

// ── Step 1：Parse（POST /checks/import/parse）──────────
// 上傳 Excel → 回傳解析預覽，不寫 DB
router.post('/import/parse', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return err(res, { message: '請上傳 Excel 檔案' });

    const wb  = XLSX.read(req.file.buffer, { type: 'buffer', cellDates: false });
    const ws  = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });

    const today = new Date().toISOString().slice(0, 10);

    // 找標題列（包含「出款月份」的那列）
    let headerRow = -1;
    for (let i = 0; i < Math.min(rows.length, 10); i++) {
      if (rows[i] && rows[i].some(c => c && String(c).includes('出款月份'))) {
        headerRow = i;
        break;
      }
    }
    if (headerRow < 0) return err(res, { message: '找不到標題列（含「出款月份」）' });

    const headers = rows[headerRow].map(h => h ? String(h).trim() : '');
    const colIdx  = {};
    headers.forEach((h, i) => {
      if (h.includes('出款月份'))  colIdx.month      = i;
      if (h.includes('出款戶名'))  colIdx.drawer     = i;
      if (h.includes('支票日期'))  colIdx.dueDate    = i;
      if (h.includes('支票備註'))  colIdx.note       = i;
      if (h.includes('出款金額') || h.includes('金額')) colIdx.amount = i;
      if (h.includes('支票號碼') || h.includes('票號'))  colIdx.checkNo = i;
    });

    const batches = {}; // key = `${subject}_${totalInNote}_${drawer}_${bank}` → batch group
    const skipped = [];
    let parsedCount = 0;

    for (let i = headerRow + 1; i < rows.length; i++) {
      const row = rows[i];
      if (!row || !row[colIdx.month]) continue; // 空列跳過

      // 解析出款戶名
      const drawerInfo = parseDrawer(row[colIdx.drawer]);
      if (!drawerInfo) {
        skipped.push({ row: i + 1, reason: '出款戶名非標準格式', raw: row[colIdx.drawer] });
        continue;
      }

      // 解析支票日期
      const dueDate = parseDate(row[colIdx.dueDate]);
      if (!dueDate) {
        skipped.push({ row: i + 1, reason: '日期無法解析', raw: row[colIdx.dueDate] });
        continue;
      }

      // 解析備註
      const noteInfo = parseNote(row[colIdx.note]);

      // 批次 key
      const batchKey = `${noteInfo.subject || 'unknown'}_${noteInfo.totalInNote || 0}_${drawerInfo.drawer_name}_${drawerInfo.bank_name}`;

      if (!batches[batchKey]) {
        batches[batchKey] = {
          subject:      noteInfo.subject,
          totalInNote:  noteInfo.totalInNote,
          drawer_name:  drawerInfo.drawer_name,
          bank_name:    drawerInfo.bank_name,
          checks:       [],
        };
      }

      const isPast     = dueDate < today;
      const amount     = colIdx.amount != null ? parseFloat(row[colIdx.amount]) || null : null;
      const checkNo    = colIdx.checkNo != null ? row[colIdx.checkNo] || null : null;

      batches[batchKey].checks.push({
        seq_no:   noteInfo.seq || batches[batchKey].checks.length + 1,
        due_date: dueDate,
        amount,
        check_no: checkNo ? String(checkNo).trim() : null,
        status:   isPast ? 'paid' : 'pending',
        notes:    noteInfo.rawNote || null,
      });

      parsedCount++;
    }

    const batchList = Object.values(batches).map(b => ({
      ...b,
      check_count: b.checks.length,
      pending_count: b.checks.filter(c => c.status === 'pending').length,
      paid_count:    b.checks.filter(c => c.status === 'paid').length,
    }));

    res.json({
      success: true,
      data: {
        total_rows:    parsedCount,
        skipped_count: skipped.length,
        batch_count:   batchList.length,
        batches:       batchList,
        skipped:       skipped.slice(0, 50), // 只回前 50 筆給預覽
      },
    });
  } catch (e) {
    console.error('[Excel Parse]', e);
    err(res, { message: `解析失敗：${e.message}` }, 500);
  }
});

// ── Step 2：Confirm（POST /checks/import/confirm）──────
// 批量寫入：subjects upsert → batches bulk insert → checks bulk insert（分批500筆）
// 從原本逐筆（300+ DB calls）壓縮到 ~5 次 DB 呼叫
router.post('/import/confirm', async (req, res) => {
  try {
    const { batches } = req.body;
    if (!batches || !Array.isArray(batches) || batches.length === 0) {
      return err(res, { message: '沒有可匯入的批次' });
    }

    const supabase = require('../config/supabase');

    // ── 1. 科目：一次 upsert 全部 ─────────────────────────
    const subjectMap = {};
    const uniqueSubjectNames = [...new Set(batches.map(b => b.subject).filter(Boolean))];

    if (uniqueSubjectNames.length > 0) {
      // upsert（已存在的不動）
      await supabase
        .from('check_subjects')
        .upsert(uniqueSubjectNames.map(name => ({ name })), { onConflict: 'name', ignoreDuplicates: true });

      // 一次查回所有科目 ID
      const { data: subRows } = await supabase
        .from('check_subjects')
        .select('id, name')
        .in('name', uniqueSubjectNames);
      (subRows || []).forEach(s => { subjectMap[s.name] = s.id; });
    }

    // ── 2. 批次：一次 bulk insert ─────────────────────────
    // batch_no 由 DB trigger 自動填入（WHEN batch_no IS NULL）
    const batchRows = batches.map(b => ({
      subject_id:    b.subject ? (subjectMap[b.subject] || null) : null,
      drawer_name:   b.drawer_name,
      bank_name:     b.bank_name,
      check_count:   b.checks.length,
      renewal_needed: false,
      status: b.checks.every(c => c.status === 'paid') ? 'completed' : 'active',
    }));

    const { data: insertedBatches, error: batchErr } = await supabase
      .from('check_batches')
      .insert(batchRows)
      .select('id, status');
    if (batchErr) throw new Error(`批次寫入失敗：${batchErr.message}`);

    // ── 3. 支票：收集全部後分 500 筆 bulk insert ──────────
    const allChecks = [];
    insertedBatches.forEach((batch, i) => {
      const b = batches[i];
      // 依 due_date 排序後強制重新編號，避免 Excel 備註解析出重複 seq_no
      const sorted = [...b.checks].sort((a, z) => (a.due_date || '').localeCompare(z.due_date || ''));
      sorted.forEach((c, idx) => {
        allChecks.push({
          batch_id: batch.id,
          seq_no:   idx + 1,          // 強制 1,2,3... 不信任原始 seq
          check_no: c.check_no || null,
          amount:   c.amount   || null,
          due_date: c.due_date,
          status:   c.status   || 'pending',
          notes:    c.notes    || null,
        });
      });
    });

    const CHUNK = 500;
    for (let i = 0; i < allChecks.length; i += CHUNK) {
      const { error: chkErr } = await supabase
        .from('checks')
        .insert(allChecks.slice(i, i + CHUNK));
      if (chkErr) throw new Error(`支票寫入失敗（第 ${i}~${i + CHUNK} 筆）：${chkErr.message}`);
    }

    console.log(`[Import] 完成：${insertedBatches.length} 批次，${allChecks.length} 張支票`);
    res.json({
      success: true,
      data: {
        imported_batches: insertedBatches.length,
        imported_checks:  allChecks.length,
        errors: [],
      },
    });
  } catch (e) {
    console.error('[Excel Confirm]', e);
    err(res, { message: `匯入失敗：${e.message}` }, 500);
  }
});

module.exports = router;
