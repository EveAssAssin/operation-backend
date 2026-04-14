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

// ── 排程任務 ──────────────────────────────────────────────
const { startScheduledSync }        = require('./jobs/syncEmployees');
const { startLineUidScheduledSync } = require('./jobs/syncLineUid');

startScheduledSync();
startLineUidScheduledSync();

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
