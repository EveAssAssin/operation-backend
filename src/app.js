// app.js
// 營運部系統 Backend 入口
// force redeploy 2026-07-07 (adbudget v2 sync)

require('dotenv').config();

const express    = require('express');
const cors       = require('cors');
const helmet     = require('helmet');
const morgan     = require('morgan');
const rateLimit  = require('express-rate-limit');

const app  = express();
const PORT = process.env.PORT || 3001;

// Render / 反向代理環境：信任第一層 proxy（修正 express-rate-limit X-Forwarded-For 警告）
app.set('trust proxy', 1);

// ── 安全 & 中間件 ─────────────────────────────────────────
// helmet 預設 cross-origin-resource-policy=same-origin 會阻擋跨網域 POST 讀 response body
// （frontend 跟 backend 在不同 onrender.com 子網域 → 算跨網域）
// 改成 cross-origin 才能讓 frontend POST 拿到 body
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
}));
app.use(cors({
  origin: function (origin, callback) {
    const allowed = (process.env.CORS_ORIGIN || 'http://localhost:5173')
      .split(',').map(s => s.trim());
    // 允許無 origin 的請求（如 Postman、Server-to-Server）
    if (!origin || allowed.includes(origin)) {
      callback(null, true);
    } else {
      callback(null, true); // 開發階段先全開，正式環境可改 false
    }
  },
  credentials: true,
}));
app.use(morgan('dev'));
app.use(express.json({
  limit: '5mb',
  // 把原始 body 留一份在 req.rawBody，給 LINE webhook 簽章驗證用
  verify: (req, _res, buf) => { req.rawBody = buf.toString('utf8'); },
}));

// 速率限制
app.use('/api/', rateLimit({
  windowMs: 15 * 60 * 1000,
  max:      200,
  message:  { success: false, message: '請求過於頻繁，請稍後再試' },
}));

// ── 健康檢查 ──────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'operation-backend', timestamp: new Date().toISOString() });
});

// ── 路由載入 ──────────────────────────────────────────────
const { authenticate, authorize } = require('./middleware/auth');

// 認證（不需登入）
app.use('/api/auth',       require('./routes/auth'));

// 人員管理（需登入）
app.use('/api/personnel',  authenticate, require('./routes/personnel'));

// 系統用戶管理（需登入）
app.use('/api/system',     authenticate, require('./routes/system'));

// 通用 QR Code 簽收（不需 SSO，由 LINE UID / app_number 驗證）
app.use('/api/sign/universal', require('./routes/sign/universal'));

// 開帳系統（需登入，operation_lead 以上）
app.use('/api/billing', authenticate, require('./routes/billing'));

// AI Hub 跨系統訊息中樞（API Key 驗證，供所有 Cowork AI 使用）
app.use('/api/hub', require('./routes/hub'));

// 開帳系統 v2（需登入）
app.use('/api/billing-v2', authenticate, require('./routes/billingV2'));

// 廠商後台入口（獨立 JWT，不共用 SSO）
app.use('/api/vendor', require('./routes/vendor'));

// 支票紀錄系統（需登入）
app.use('/api/checks', require('./routes/checks'));

// 首頁今日重點（代理外部系統 Highlight API，需登入）
app.use('/api/dashboard', require('./routes/dashboard'));

// 人力招募模組（公開跨系統端點先掛，內部端點需登入）
app.use('/api/recruitment/external', require('./routes/recruitmentExternal'));
app.use('/api/recruitment', authenticate, require('./routes/recruitment'));

// 業績系統活動模組（需登入）
app.use('/api/sales-events', authenticate, require('./routes/salesEvents'));

// 推播群組管理（需登入）
app.use('/api/push-groups', authenticate, require('./routes/pushGroups'));

// 常態費用模組（需登入）
app.use('/api/recurring-expenses', authenticate, require('./routes/recurringExpenses'));

// 營運費用模組（電費/水費/電話 ...，需登入）
app.use('/api/operational-expenses', require('./routes/operationalExpenses'));

// 系統更新模組（從 GitHub 抓 commits 展示開發績效，需登入）
app.use('/api/system-updates', authenticate, require('./routes/systemUpdates'));

// 合約管理模組（房租/廠商/員工，需登入）
app.use('/api/contracts', authenticate, require('./routes/contracts'));

// 通用附件模組（Supabase Storage，需登入）
app.use('/api/files', authenticate, require('./routes/files'));

// 文件庫（廠商/門市/員工 分類 + tag，需登入）
app.use('/api/doc-library', authenticate, require('./routes/documentLibrary'));

// 對外 API — 特約廠商綁定報表（x-api-key 認證，給其他部門/系統用）
app.use('/api/external/appointed-units', require('./routes/appointedUnitsExternal'));

// 任務派發模組（送任務到市場部，需登入）
app.use('/api/quests', authenticate, require('./routes/quests'));

// 特約廠商模組（公開的 LIFF 綁定 + LINE webhook + 後台管理；內部自行處理 auth）
app.use('/api/appointed-units', require('./routes/appointedUnits'));

// 各類流程模組
//   公開端點（QR 掃描後填寫，不需登入，由 line_uid 驗證）
app.use('/api/processes/public', require('./routes/processes/public'));
//   管理端（需登入）
app.use('/api/processes', authenticate, require('./routes/processes/admin'));

// 分數加分申請模組
//   公開 + 管理 在同一個 router 內（router.use(authenticate) 切分）
app.use('/api/score-application', require('./routes/scoreApplication'));

// 分數兌換模組（公開的員工自助 /public/* + 後台管理；內部自行處理 auth）
app.use('/api/point-redemption', require('./routes/pointRedemption'));

// 基本資料模組（電費 / 電話 / 房租 / 自訂；含 audit log + LINE 推播）
app.use('/api/basic-data', authenticate, require('./routes/basicData'));

// 排程推播模組（自訂排程 + 變數展開 + 個人/角色群收件人）
app.use('/api/scheduled-notify', authenticate, require('./routes/scheduledNotify'));

// 分權系統（角色 / 模組 / 權限設定）
app.use('/api/permissions', authenticate, require('./routes/permissions'));

// 廠商請款（系統人員端 / 含 company_profile）
app.use('/api/vendor-payment', require('./routes/vendorPayment'));

// 匯款批次（S2：元大格式匯出 + 進項發票）
app.use('/api/payment-batch', authenticate, require('./routes/paymentBatch'));

// ── 內部同步觸發（部署初期用，確認正常後可移除）──────
app.post('/api/internal/sync', async (req, res) => {
  const { runEmployeeSync } = require('./services/personnelSync');
  const { SYNC_TYPE } = require('./config/constants');
  try {
    res.json({ success: true, message: '同步已啟動，背景執行中' });
    const result = await runEmployeeSync(SYNC_TYPE.MANUAL, null);
    console.log('[內部同步] 完成：', JSON.stringify(result));
  } catch (err) {
    console.error('[內部同步] 失敗：', err.message);
  }
});

app.post('/api/internal/sync-line-uid', async (req, res) => {
  const { runLineUidSync } = require('./services/lineUidSync');
  try {
    res.json({ success: true, message: 'LINE UID 同步已啟動，背景執行中' });
    const result = await runLineUidSync(null);
    console.log('[內部LINE UID同步] 完成：', JSON.stringify(result));
  } catch (err) {
    console.error('[內部LINE UID同步] 失敗：', err.message);
  }
});

// ── 排程任務 ──────────────────────────────────────────────
const { startScheduledSync }                  = require('./jobs/syncEmployees');
const { startLineUidScheduledSync }           = require('./jobs/syncLineUid');
const { startBillingScheduledSync }           = require('./jobs/syncBilling');
const { startHubPoller }                      = require('./jobs/hubPoller');
const { startCheckNotifyJob }                 = require('./jobs/checkNotify');
const { startRecurringExpenseNotifyJob }      = require('./jobs/notifyRecurringExpenses');
const { start: startOpexAnomalyJob }          = require('./jobs/notifyOpexAnomalies');
const { startDuplicateNeedsNotifyJob }        = require('./jobs/notifyDuplicateNeeds');
const { startAppointedUnitJobs }              = require('./jobs/syncAppointedUnits');
const { startScheduledNotifyDispatcher }      = require('./jobs/scheduledNotifyDispatcher');
const { init: initHolidays }                  = require('./services/taiwanHolidayService');

startScheduledSync();
startLineUidScheduledSync();
startBillingScheduledSync();
startHubPoller();                  // 每 5 分鐘自動掃 Hub 收件匣
startCheckNotifyJob();             // 每天 10:00 支票到期通知
startRecurringExpenseNotifyJob();  // 每天 09:00 常態費用到期通知
startOpexAnomalyJob();             // 每天 09:00 營運費用異常掃描 + LINE 推播
startDuplicateNeedsNotifyJob();    // 每天 11:00 重複人力需求提醒
startAppointedUnitJobs();          // 特約單位 / 廠商員工 同步
startScheduledNotifyDispatcher();  // 每分鐘掃自訂排程推播
initHolidays();                    // 預載台灣假日快取（本年 + 明年）

// ── 錯誤處理 ──────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ success: false, message: '找不到此 API 路徑' });
});

app.use((err, req, res, next) => {
  console.error('[Error]', err);
  res.status(500).json({ success: false, message: '伺服器內部錯誤' });
});

// ── 啟動 ──────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🚀 營運部系統 Backend 啟動 → port ${PORT}`);
});
