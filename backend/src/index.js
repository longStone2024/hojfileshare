const express = require('express');
const config = require('./config');
const db = require('./db');
const { router: authRouter } = require('./routes/auth');
const filesRouter = require('./routes/files');
const { privateRouter: sharesPrivate, publicRouter: sharesPublic } = require('./routes/shares');
const adminRouter = require('./routes/admin');
const noticesRouter = require('./routes/notices');
const webdavRouter = require('./routes/webdav');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: '1mb' }));

app.get('/api/site', async (_req, res, next) => {
  try {
    const row = await db.one('SELECT * FROM site_settings WHERE id=1');
    if (!row) {
      return res.json({ status: 200, data: { siteName: '云盘', siteDescription: '', siteFooter: '' } });
    }
    res.json({
      status: 200,
      data: {
        siteName: row.site_name || '云盘',
        siteDescription: row.site_description || '',
        siteFooter: row.site_footer || '',
      },
    });
  } catch (e) { next(e); }
});

app.get('/api/health', async (_req, res) => {
  try { await db.query('SELECT 1'); res.json({ status: 200, ok: true }); }
  catch (e) { res.status(500).json({ status: 500, ok: false, msg: e.message }); }
});

app.use('/api/auth', authRouter);
app.use('/api/files', filesRouter);
app.use('/api/shares', sharesPrivate);   // 登录用户管理自己的分享
app.use('/api/share', sharesPublic);     // 公开分享（JSON，给独立 share.html 用）
app.use('/api/notices', noticesRouter);
app.use('/api/admin', adminRouter);
app.use('/dav', webdavRouter);

app.use((err, _req, res, _next) => {
  console.error('[error]', err);
  if (res.headersSent) return;
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ status: 413, msg: '文件超过大小限制' });
  }
  res.status(500).json({ status: 500, msg: err.message || '服务器错误' });
});

(async () => {
  await db.waitForDb();
  await db.init();
  app.listen(config.port, () => console.log(`[backend] listening on ${config.port}`));
})().catch((e) => {
  console.error('[fatal]', e);
  process.exit(1);
});