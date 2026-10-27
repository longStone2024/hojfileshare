require('dotenv').config();

function int(v, d) { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; }

module.exports = {
  port: int(process.env.PORT, 3000),
  databaseUrl: process.env.DATABASE_URL,
  rootPassword: process.env.ROOT_PASSWORD || 'root123456',
  sessionTTL: int(process.env.SESSION_TTL_DAYS, 7) * 86400 * 1000,
  challengeTTL: 5 * 60 * 1000,
  defaultQuotaBytes: int(process.env.DEFAULT_USER_QUOTA_MB, 1024) * 1024 * 1024,
  maxUploadBytes: int(process.env.MAX_UPLOAD_MB, 100) * 1024 * 1024,
  proxyDownload: process.env.PROXY_DOWNLOAD === '1',
};