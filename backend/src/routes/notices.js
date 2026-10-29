const express = require('express');
const { one, many, query } = require('../db');
const { auth, requireAdmin } = require('../middleware/auth');

const router = express.Router();

function normalizeNoticeInput(body = {}) {
  const title = String(body.title || '').trim();
  const content = String(body.content || '').trim();
  const active = body.active !== false;
  if (!title || !content) {
    throw new Error('公告标题和内容不能为空');
  }
  return { title, content, active };
}

router.get('/', async (_req, res, next) => {
  try {
    let notices = await many(
      `SELECT * FROM notices WHERE is_active = TRUE ORDER BY created_at DESC, id DESC`
    );
    if (!notices.length) {
      notices = [{
        id: 0,
        title: '站点须知',
        content: '请勿上传政治敏感、淫秽、暴力或其他违法违规内容。所有上传内容必须遵守本平台管理规定。',
        is_active: true,
        created_at: Date.now(),
        updated_at: Date.now(),
      }];
    }
    res.json({ status: 200, data: { notices: notices.map(n => ({
      id: n.id,
      title: n.title,
      content: n.content,
      active: !!n.is_active,
      createdAt: n.created_at,
      updatedAt: n.updated_at,
    })) } });
  } catch (e) { next(e); }
});

router.get('/manage', auth, requireAdmin, async (_req, res, next) => {
  try {
    const notices = await many('SELECT * FROM notices ORDER BY created_at DESC, id DESC');
    res.json({ status: 200, data: { notices: notices.map(n => ({
      id: n.id,
      title: n.title,
      content: n.content,
      active: !!n.is_active,
      createdAt: n.created_at,
      updatedAt: n.updated_at,
    })) } });
  } catch (e) { next(e); }
});

router.post('/', auth, requireAdmin, async (req, res, next) => {
  try {
    const { title, content, active } = normalizeNoticeInput(req.body || {});
    const now = Date.now();
    const r = await query(
      `INSERT INTO notices (title, content, is_active, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [title, content, active, now, now]
    );
    res.json({ status: 200, data: { notice: { id: r.rows[0].id, title: r.rows[0].title, content: r.rows[0].content, active: !!r.rows[0].is_active, createdAt: r.rows[0].created_at, updatedAt: r.rows[0].updated_at } } });
  } catch (e) { next(e); }
});

router.patch('/:id', auth, requireAdmin, async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const row = await one('SELECT * FROM notices WHERE id=$1', [id]);
    if (!row) return res.status(404).json({ status: 404, msg: '公告不存在' });
    const { title, content, active } = normalizeNoticeInput({
      title: req.body?.title ?? row.title,
      content: req.body?.content ?? row.content,
      active: req.body?.active ?? row.is_active,
    });
    const r = await query(
      `UPDATE notices SET title=$1, content=$2, is_active=$3, updated_at=$4 WHERE id=$5 RETURNING *`,
      [title, content, active, Date.now(), id]
    );
    res.json({ status: 200, data: { notice: { id: r.rows[0].id, title: r.rows[0].title, content: r.rows[0].content, active: !!r.rows[0].is_active, createdAt: r.rows[0].created_at, updatedAt: r.rows[0].updated_at } } });
  } catch (e) { next(e); }
});

router.delete('/:id', auth, requireAdmin, async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    await query('DELETE FROM notices WHERE id=$1', [id]);
    res.json({ status: 200, msg: '公告已删除' });
  } catch (e) { next(e); }
});

module.exports = router;
