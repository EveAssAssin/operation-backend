// routes/appointedUnitsExternal.js
// 對外 API（給其他部門 / 系統呼叫）
// 認證：HTTP header  `x-api-key: <BINDING_REPORT_API_KEY>`
//
// 提供 endpoint:
//   GET /api/external/appointed-units/binding-report
//     query:
//       from         YYYY-MM-DD（區間起，含當日）
//       to           YYYY-MM-DD（區間迄，含當日）
//       store_erpid  （選）介紹門市 ERP 代碼，篩特定門市
//       status       (預設 all) all | active
//     回傳:
//       {
//         "success": true,
//         "data": {
//           "total":   123,              # 總綁定數
//           "units":   [{ unit_code, unit_name, count, first_bound_at, last_bound_at }, ...],
//           "by_store":[{ store_erpid, store_name, count }, ...],
//           "from": "2026-06-01", "to": "2026-06-30", "store_erpid": null
//         }
//       }

const express = require('express');
const router  = express.Router();
const supabase = require('../config/supabase');

// ── x-api-key 認證 middleware ───────────────────────────────
router.use((req, res, next) => {
  const expected = process.env.BINDING_REPORT_API_KEY;
  if (!expected) {
    return res.status(500).json({ success: false, message: '伺服器未設 BINDING_REPORT_API_KEY' });
  }
  const got = req.get('x-api-key') || req.query.api_key;
  if (got !== expected) {
    return res.status(401).json({ success: false, message: '未授權（x-api-key 不正確）' });
  }
  next();
});

// ── GET /binding-report ─────────────────────────────────────
router.get('/binding-report', async (req, res) => {
  try {
    const { from, to, store_erpid, status = 'all' } = req.query;
    if (!from || !to) {
      return res.status(400).json({ success: false, message: 'from 與 to 必填（格式 YYYY-MM-DD）' });
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
      return res.status(400).json({ success: false, message: 'from / to 格式須為 YYYY-MM-DD' });
    }

    let q = supabase.from('appointed_unit_bindings')
      .select('unit_code, unit_name_snap, introducer_store_erpid, introducer_store_name, bound_at, status');
    q = q.gte('bound_at', from + 'T00:00:00+08:00');
    q = q.lte('bound_at', to   + 'T23:59:59+08:00');
    if (store_erpid) q = q.eq('introducer_store_erpid', store_erpid);
    if (status === 'active') q = q.eq('status', 'active');

    const { data, error } = await q;
    if (error) return res.status(500).json({ success: false, message: error.message });

    // 廠商 group by
    const uMap = new Map();
    for (const b of data || []) {
      const k = b.unit_code || '_';
      if (!uMap.has(k)) uMap.set(k, {
        unit_code: b.unit_code, unit_name: b.unit_name_snap || '',
        count: 0, first_bound_at: b.bound_at, last_bound_at: b.bound_at,
      });
      const r = uMap.get(k);
      r.count++;
      if (b.bound_at < r.first_bound_at) r.first_bound_at = b.bound_at;
      if (b.bound_at > r.last_bound_at)  r.last_bound_at  = b.bound_at;
    }
    const units = [...uMap.values()].sort((a, b) => b.count - a.count);

    // 門市 group by
    const sMap = new Map();
    for (const b of data || []) {
      const k = b.introducer_store_erpid || '_未知';
      if (!sMap.has(k)) sMap.set(k, {
        store_erpid: b.introducer_store_erpid || null,
        store_name:  b.introducer_store_name  || '未指定門市',
        count: 0,
      });
      sMap.get(k).count++;
    }
    const by_store = [...sMap.values()].sort((a, b) => b.count - a.count);

    res.json({
      success: true,
      data: {
        total:    (data || []).length,
        units,
        by_store,
        from, to,
        store_erpid: store_erpid || null,
        status,
      },
    });
  } catch (e) {
    console.error('[external/binding-report]', e);
    res.status(500).json({ success: false, message: e.message || '伺服器錯誤' });
  }
});

module.exports = router;
