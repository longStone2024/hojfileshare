const { Pool, types } = require('pg');
const bcrypt = require('bcryptjs');
const config = require('./config');

// BIGINT 自动转 number（2^53 以内安全）
types.setTypeParser(20, (v) => (v === null ? null : Number(v)));

if (!config.databaseUrl) {
  console.error('[fatal] 未设置 DATABASE_URL');
  process.exit(1);
}

const pool = new Pool({
  connectionString: config.databaseUrl,
  max: 10,
  idleTimeoutMillis: 30000,
});

pool.on('error', (e) => console.error('[pg pool]', e));

async function waitForDb(attempts = 30, delay = 2000) {
  for (let i = 1; i <= attempts; i++) {
    try {
      await pool.query('SELECT 1');
      console.log('[db] connected');
      return;
    } catch (e) {
      console.log(`[db] waiting (${i}/${attempts}) ${e.code || e.message}`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw new Error('db unreachable');
}

const query = (text, params) => pool.query(text, params);
async function one(text, params) { return (await pool.query(text, params)).rows[0] || null; }
async function many(text, params) { return (await pool.query(text, params)).rows; }
async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await fn(client);
    await client.query('COMMIT');
    return r;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

async function init() {

  await query(`CREATE TABLE IF NOT EXISTS site_settings (
    id SERIAL PRIMARY KEY,
    site_name TEXT NOT NULL DEFAULT '云盘',
    site_description TEXT DEFAULT '',
    site_footer TEXT DEFAULT '',
    updated_at BIGINT NOT NULL DEFAULT 0
  )`);
  await query(`CREATE TABLE IF NOT EXISTS notices (
    id SERIAL PRIMARY KEY,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL
  )`);
  await query(`ALTER TABLE login_challenges ADD COLUMN IF NOT EXISTS desired_username TEXT`);
  await query(`ALTER TABLE oj_providers ADD COLUMN IF NOT EXISTS sort_order INTEGER NOT NULL DEFAULT 0`);
  await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS storage_provider_ids INTEGER[]`);
  await query(`ALTER TABLE files ADD COLUMN IF NOT EXISTS storage_provider_id INTEGER`);
  await query(`ALTER TABLE files ADD COLUMN IF NOT EXISTS mime_type TEXT`);
  await query(`ALTER TABLE files ADD COLUMN IF NOT EXISTS deleted_parent_id INTEGER`);
  await query(`ALTER TABLE files ADD COLUMN IF NOT EXISTS deleted_at BIGINT`);
  await query(`ALTER TABLE files ADD COLUMN IF NOT EXISTS delete_expires_at BIGINT`);
  await query(`UPDATE oj_providers SET sort_order = id WHERE sort_order IS NULL OR sort_order = 0`);
  await query(`UPDATE users SET storage_provider_ids = ARRAY[oj_provider_id]
    WHERE oj_provider_id IS NOT NULL AND storage_provider_ids IS NULL`);
  const existing = await one('SELECT id FROM users WHERE username=$1', ['root']);
  if (!existing) {
    const hash = bcrypt.hashSync(config.rootPassword, 10);
    await query(
      `INSERT INTO users (username,password_hash,role,quota_bytes,used_bytes,created_at)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      ['root', hash, 'root', 10 * 1024 * 1024 * 1024, 0, Date.now()]
    );
    console.log(`[init] 已创建 root，密码：${config.rootPassword}`);
  }
  // 定期清理
  setInterval(() => {
    const now = Date.now();
    pool.query('DELETE FROM sessions WHERE expires_at < $1', [now]).catch(() => {});
    pool.query('DELETE FROM login_challenges WHERE expires_at < $1', [now]).catch(() => {});
  }, 10 * 60 * 1000).unref();
}

module.exports = { pool, query, one, many, tx, waitForDb, init };