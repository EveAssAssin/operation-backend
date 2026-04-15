// routes/personnel.js
// 人員管理 API 路由

const express  = require('express');
const router   = express.Router();
const supabase = require('../config/supabase');
const { authenticate, authorize } = require('../middleware/auth');
const { runEmployeeSync }  = require('../services/personnelSync');
const { runLineUidSync }   = require('../services/lineUidSync');
const { SYNC_TYPE } = require('../config/constants');

// 所有路由均需登入
router.use(authenticate);

// ============================================================
// 部門 (Departments)
// ============================================================

/**
 * GET /api/personnel/departments
 * 取得所有部門清單
 */
router.get('/departments', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('departments')
      .select('id, store_erpid, store_name, is_active, updated_at')
      .order('store_name', { ascending: true });

    if (error) throw error;
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ============================================================
// 人員 (Employees)
// ============================================================

/**
 * GET /api/personnel/employees
 * 查詢人員列表（支援過濾：部門、關鍵字、是否在職）
 * Query params:
 *   - store_erpid: 篩選部門
 *   - keyword:     搜尋姓名 / erpid
 *   - is_active:   true | false（預設 true）
 *   - page:        頁碼（預設 1）
 *   - limit:       每頁筆數（預設 20，最大 100）
 */
router.get('/employees', async (req, res) => {
  try {
    const {
      store_erpid,
      keyword,
      is_active = 'true',
      page  = 1,
      limit = 20,
    } = req.query;

    const pageNum  = Math.max(1, parseInt(page));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit)));
    const from     = (pageNum - 1) * limitNum;

    let query = supabase
      .from('employees')
      .select('id, erpid, app_number, name, jobtitle, store_erpid, store_name, line_uid, is_active, last_synced_at', { count: 'exact' })
      .order('store_name', { ascending: true })
      .order('name',       { ascending: true })
      .range(from, from + limitNum - 1);

    if (store_erpid) query = query.eq('store_erpid', store_erpid);
    if (is_active !== 'all') query = query.eq('is_active', is_active === 'true');
    if (keyword) {
      query = query.or(`name.ilike.%${keyword}%,erpid.ilike.%${keyword}%`);
    }

    const { data, error, count } = await query;
    if (error) throw error;

    res.json({
      success: true,
      data,
      pagination: {
        total: count,
        page:  pageNum,
        limit: limitNum,
        pages: Math.ceil(count / limitNum),
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * GET /api/personnel/employees/:id
 * 取得單一人員詳細資料
 */
router.get('/employees/:id', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('employees')
      .select('*')
      .eq('id', req.params.id)
      .single();

    if (error || !data) {
      return res.status(404).json({ success: false, message: '找不到此人員' });
    }
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * PATCH /api/personnel/employees/:id/line-uid
 * 手動更新人員 LINE UID（工務師以上）
 */
router.patch('/employees/:id/line-uid', authorize('personnel.edit'), async (req, res) => {
  try {
    const { line_uid } = req.body;
    if (line_uid === undefined) {
      return res.status(400).json({ success: false, message: '缺少 line_uid 欄位' });
    }

    const { data, error } = await supabase
      .from('employees')
      .update({ line_uid: line_uid || null, updated_at: new Date().toISOString() })
      .eq('id', req.params.id)
      .select('id, name, line_uid')
      .single();

    if (error) throw error;
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ============================================================
// 同步作業 (Sync)
// ============================================================

/**
 * POST /api/personnel/sync
 * 手動觸發人員同步（市場部主管以上）
 */
router.post('/sync', authorize('personnel.sync'), async (req, res) => {
  try {
    // 避免同時多次觸發：檢查是否有進行中的同步
    const { data: running } = await supabase
      .from('sync_logs')
      .select('id, started_at')
      .eq('status', 'in_progress')
      .order('started_at', { ascending: false })
      .limit(1);

    if (running && running.length > 0) {
      return res.status(409).json({
        success: false,
        message: '已有同步作業進行中，請稍後再試',
        runningLogId: running[0].id,
      });
    }

    // 非同步執行（立即回應，背景同步）
    res.json({ success: true, message: '同步作業已啟動，請稍後查詢結果' });

    // 背景執行同步
    runEmployeeSync(SYNC_TYPE.MANUAL, req.user.id).catch(err => {
      console.error('[Sync] 背景同步失敗：', err.message);
    });

  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * GET /api/personnel/sync/status
 * 查詢最近同步狀態
 */
router.get('/sync/status', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('sync_logs')
      .select('id, sync_type, status, total_count, success_count, error_count, error_details, started_at, finished_at, triggered_by')
      .order('started_at', { ascending: false })
      .limit(10);

    if (error) throw error;
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * GET /api/personnel/sync/status/:logId
 * 查詢特定同步作業詳細結果
 */
router.get('/sync/status/:logId', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('sync_logs')
      .select('*')
      .eq('id', req.params.logId)
      .single();

    if (error || !data) {
      return res.status(404).json({ success: false, message: '找不到此同步記錄' });
    }
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ============================================================
// LINE UID 同步
// ============================================================

/**
 * POST /api/personnel/sync-line-uid
 * 手動觸發 LINE UID 同步（工務師以上）
 */
router.post('/sync-line-uid', authorize('personnel.edit'), async (req, res) => {
  try {
    // 避免同時多次觸發
    const { data: running } = await supabase
      .from('line_uid_sync_logs')
      .select('id, started_at')
      .eq('status', 'in_progress')
      .limit(1);

    if (running && running.length > 0) {
      return res.status(409).json({
        success: false,
        message: 'LINE UID 同步作業進行中，請稍後再試',
      });
    }

    res.json({ success: true, message: 'LINE UID 同步作業已啟動' });

    // 背景執行
    runLineUidSync(req.user.id).catch(err => {
      console.error('[LineUID] 背景同步失敗：', err.message);
    });

  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * GET /api/personnel/sync-line-uid/status
 * 查詢 LINE UID 同步記錄
 */
router.get('/sync-line-uid/status', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('line_uid_sync_logs')
      .select(`
        id, status, total_count, updated_count, error_count,
        started_at, finished_at,
        system_users!triggered_by ( name )
      `)
      .order('started_at', { ascending: false })
      .limit(10);

    if (error) throw error;
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ============================================================
// 除錯端點（確認左手 API 回傳）
// ============================================================

/**
 * GET /api/personnel/debug/stores
 * 查看 getstoredatas 回傳的所有門市/部門 erpid
 */
router.get('/debug/stores', async (req, res) => {
  try {
    const { syncAllEmployees, ...leftHand } = require('../services/leftHandApi');
    // 直接呼叫 getStoreDatas（透過 require 繞進去）
    const leftHandApi = require('../services/leftHandApi');
    // 用 internal 方式呼叫
    const crypto = require('crypto');
    const axios  = require('axios');

    const AES_KEY  = process.env.LEFTHAND_AES_KEY || 'GmAOoS003d5OJ2G2';
    const AES_IV   = process.env.LEFTHAND_AES_IV  || 'bgfDcfWdWG6NSUr5';
    const BASE_URL = process.env.LEFTHAND_API_URL  || 'https://map.lohasglasses.com/_api/v1.ashx';

    const resp = await axios.post(BASE_URL, { method: 'getstoredatas' }, { timeout: 15000 });
    const raw  = resp.data;
    const data = typeof raw.data === 'string' ? JSON.parse(raw.data) : (raw.data || []);

    res.json({
      success: true,
      count:   data.length,
      erpids:  data.map(s => ({ erpid: s.erpid, name: s.name })),
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * GET /api/personnel/debug/group/:erpid
 * 查看指定部門 erpid 的員工清單（直接打左手 API）
 */
router.get('/debug/group/:erpid', async (req, res) => {
  try {
    const { aesEncrypt } = require('../services/leftHandApi');
    const axios  = require('axios');
    const BASE_URL = process.env.LEFTHAND_API_URL || 'https://map.lohasglasses.com/_api/v1.ashx';

    const encrypted = aesEncrypt(req.params.erpid);
    const resp = await axios.post(BASE_URL, {
      method:  'getemployeebygroup',
      groupid: encrypted,
    }, { timeout: 15000 });

    const raw  = resp.data;
    const data = typeof raw.data === 'string' ? JSON.parse(raw.data) : (raw.data || []);

    res.json({
      success:   true,
      erpid:     req.params.erpid,
      encrypted,
      count:     data.length,
      employees: data,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
