-- 方块梦工厂 · D1 数据库结构
-- 用法: npx wrangler d1 execute blockdream --file worker/schema.sql --remote

CREATE TABLE IF NOT EXISTS users (
  id          TEXT PRIMARY KEY,             -- u_xxxxxxxx
  email       TEXT NOT NULL UNIQUE,
  pass_hash   TEXT NOT NULL,                -- PBKDF2-SHA256
  salt        TEXT NOT NULL,
  plan        TEXT NOT NULL DEFAULT 'free', -- free | pro
  verified    INTEGER NOT NULL DEFAULT 0,
  tokens_used INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL              -- epoch ms
);

CREATE TABLE IF NOT EXISTS tasks (
  id            TEXT PRIMARY KEY,           -- t_xxxxxxxx
  user_id       TEXT NOT NULL,
  idea          TEXT NOT NULL,
  mc_version    TEXT NOT NULL DEFAULT '1.20.1',
  loader        TEXT NOT NULL DEFAULT 'fabric',
  spec_json     TEXT,                       -- AI 生成的规格
  status        TEXT NOT NULL DEFAULT 'drafted',  -- drafted | building | done | error
  gh_run_id     TEXT,
  artifact_id   TEXT,
  jar_name      TEXT,
  error         TEXT,
  tokens_used   INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tasks_user ON tasks(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);

CREATE TABLE IF NOT EXISTS verify_codes (
  email      TEXT NOT NULL,
  code       TEXT NOT NULL,
  kind       TEXT NOT NULL DEFAULT 'verify',
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (email, kind)
);
