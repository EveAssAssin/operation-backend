// app.js
// 營運部系統 Backend 入口

require('dotenv').config();

const express    = require('express');
const cors       = require('cors');
const helmet     = require('helmet');
const morgan     = require('morgan');
const rateLimit  = require('express-rate-limit');

const app  = express();
const PORT = process.env.PORT || 3001;

// ── 安全 & 中間件 ─────────────────────────────────────────
app.use(helmet());
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
app.use(express.json({ limit: '5mb' }));

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
const { startScheduledSync }        = require('./jobs/syncEmployees');
const { startLineUidScheduledSync } = require('./jobs/syncLineUid');
const { startBillingScheduledSync } = require('./jobs/syncBilling');
const { startHubPoller }            = require('./jobs/hubPoller');
const { startCheckNotifyJob }       = require('./jobs/checkNotify');
const { init: initHolidays }        = require('./services/taiwanHolidayService');

startScheduledSync();
startLineUidScheduledSync();
startBillingScheduledSync();
startHubPoller();         // 每 5 分鐘自動掃 Hub 收件匣
startCheckNotifyJob();    // 每天 10:00 支票到期通知
initHolidays();           // 預載台灣假日快取（本年 + 明年）

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
