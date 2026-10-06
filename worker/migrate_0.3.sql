-- ModCraft 已有数据库升级到 v0.3（每条独立执行，重复执行会报 duplicate column 可忽略）
ALTER TABLE users ADD COLUMN plan_expires_at INTEGER;
ALTER TABLE users ADD COLUMN extra_credits INTEGER NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS orders (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  kind       TEXT NOT NULL DEFAULT 'plan',
  plan       TEXT,
  amount     INTEGER NOT NULL DEFAULT 0,
  status     TEXT NOT NULL DEFAULT 'pending',
  note       TEXT,
  created_at INTEGER NOT NULL,
  paid_at    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
