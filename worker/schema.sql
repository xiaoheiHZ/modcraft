-- ModCraft · 方块梦工厂 · D1 数据库结构（v0.3）
-- 全新建库：npx wrangler d1 execute modcraft --file worker/schema.sql --remote
-- 已有库升级：npx wrangler d1 execute modcraft --file worker/migrate_0.3.sql --remote

CREATE TABLE IF NOT EXISTS users (
  id              TEXT PRIMARY KEY,             -- u_xxxxxxxx
  email           TEXT NOT NULL UNIQUE,
  pass_hash       TEXT NOT NULL,                -- PBKDF2-SHA256
  salt            TEXT NOT NULL,
  plan            TEXT NOT NULL DEFAULT 'free', -- free | plus35 | pro89 | max159
  plan_expires_at INTEGER,                      -- 套餐到期时间（毫秒；null=永久/免费）
  extra_credits   INTEGER NOT NULL DEFAULT 0,   -- 单次购买加油包个数
  verified        INTEGER NOT NULL DEFAULT 0,
  tokens_used     INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL              -- epoch ms
);

CREATE TABLE IF NOT EXISTS tasks (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL,
  idea          TEXT NOT NULL,
  mc_version    TEXT NOT NULL DEFAULT '1.20.1',
  loader        TEXT NOT NULL DEFAULT 'fabric',
  spec_json     TEXT,
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

CREATE TABLE IF NOT EXISTS orders (
  id         TEXT PRIMARY KEY,              -- o_xxxxxxxx
  user_id    TEXT NOT NULL,
  kind       TEXT NOT NULL DEFAULT 'plan',  -- plan | credit
  plan       TEXT,                          -- plus35 | pro89 | max159（kind=plan 时）
  amount     INTEGER NOT NULL DEFAULT 0,    -- 金额（元）
  status     TEXT NOT NULL DEFAULT 'pending', -- pending | paid | cancelled
  note       TEXT,
  created_at INTEGER NOT NULL,
  paid_at    INTEGER
);

CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
