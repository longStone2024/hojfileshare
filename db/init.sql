-- 用户自定义 OJ 存储提供方（上传账号密码、gid 都在这里配置）
CREATE TABLE oj_providers (
  id              SERIAL PRIMARY KEY,
  name            TEXT NOT NULL,
  base_url        TEXT NOT NULL,
  login_path      TEXT NOT NULL DEFAULT '/api/login',
  home_info_path  TEXT NOT NULL DEFAULT '/api/get-user-home-info',
  upload_path     TEXT NOT NULL DEFAULT '/api/file/upload-md-file',
  token_json_path TEXT NOT NULL DEFAULT 'data.token',
  upload_username TEXT,
  upload_password TEXT,
  upload_gid      TEXT,
  sort_order      INTEGER NOT NULL DEFAULT 0,
  enabled         BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE users (
  id                    SERIAL PRIMARY KEY,
  username              TEXT UNIQUE NOT NULL,
  password_hash         TEXT,
  role                 TEXT NOT NULL DEFAULT 'user',           -- 'user' / 'admin' / 'root'
  quota_bytes           BIGINT NOT NULL DEFAULT 1073741824,
  used_bytes            BIGINT NOT NULL DEFAULT 0,
  oj_provider_id        INTEGER REFERENCES oj_providers(id) ON DELETE SET NULL,
  oj_username           TEXT,
  storage_provider_ids  INTEGER[] DEFAULT NULL,
  created_at            BIGINT NOT NULL,
  UNIQUE (oj_provider_id, oj_username)
);

CREATE TABLE sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL
);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);

CREATE TABLE login_challenges (
  uuid           TEXT PRIMARY KEY,
  oj_provider_id INTEGER NOT NULL REFERENCES oj_providers(id) ON DELETE CASCADE,
  oj_username    TEXT NOT NULL,
  created_at     BIGINT NOT NULL,
  expires_at     BIGINT NOT NULL
);
CREATE INDEX idx_challenges_expires ON login_challenges(expires_at);

CREATE TABLE files (
  id                  SERIAL PRIMARY KEY,
  user_id             INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  parent_id           INTEGER NOT NULL DEFAULT 0,
  deleted_parent_id   INTEGER,
  name                TEXT NOT NULL,
  is_dir              BOOLEAN NOT NULL DEFAULT FALSE,
  size                BIGINT NOT NULL DEFAULT 0,
  storage_url         TEXT,
  storage_provider_id INTEGER REFERENCES oj_providers(id) ON DELETE SET NULL,
  mime_type           TEXT,
  deleted_at          BIGINT,
  delete_expires_at   BIGINT,
  created_at          BIGINT NOT NULL,
  updated_at          BIGINT NOT NULL,
  UNIQUE (user_id, parent_id, name)
);
CREATE INDEX idx_files_parent ON files(user_id, parent_id);

CREATE TABLE shares (
  id             SERIAL PRIMARY KEY,
  code           TEXT UNIQUE NOT NULL,
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  file_id        INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  password_hash  TEXT,
  expires_at     BIGINT,
  max_downloads  INTEGER,
  download_count INTEGER NOT NULL DEFAULT 0,
  created_at     BIGINT NOT NULL
);
CREATE INDEX idx_shares_user ON shares(user_id);

CREATE TABLE site_settings (
  id               SERIAL PRIMARY KEY,
  site_name        TEXT NOT NULL DEFAULT '云盘',
  site_description TEXT DEFAULT '',
  site_footer      TEXT DEFAULT '',
  updated_at       BIGINT NOT NULL DEFAULT 0
);

CREATE TABLE notices (
  id         SERIAL PRIMARY KEY,
  title      TEXT NOT NULL,
  content    TEXT NOT NULL,
  is_active  BOOLEAN NOT NULL DEFAULT TRUE,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);