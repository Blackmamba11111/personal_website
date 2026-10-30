-- 客户巡检台账 · D1 表结构与初始数据（幂等，可重复执行）
CREATE TABLE IF NOT EXISTS users (
  username    TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  role        TEXT NOT NULL DEFAULT 'user',
  status      TEXT NOT NULL DEFAULT 'active',
  note        TEXT NOT NULL DEFAULT '',
  salt        TEXT NOT NULL,
  hash        TEXT NOT NULL,
  must_change INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  last_login  TEXT NOT NULL DEFAULT '',
  -- 账号来源：local = 本地口令；radius/tacacs/ldap = 由对应认证服务器校验
  source      TEXT NOT NULL DEFAULT 'local',
  -- 数据权限：rw = 读写；ro = 只读
  perm        TEXT NOT NULL DEFAULT 'rw',
  -- 远程账号绑定的认证服务器 id（auth_servers.id），本地账号为空
  server_id   TEXT NOT NULL DEFAULT '',
  -- 共享数据集：指向数据归属者的用户名（空 = 自己拥有），一层引用
  share_from  TEXT NOT NULL DEFAULT '',
  -- 登录超时（分钟）：会话滑动过期，默认 30，范围 5~43200
  session_mins INTEGER NOT NULL DEFAULT 30
);

-- 远程认证服务器（RADIUS / TACACS+ / LDAP）
-- cfg 为 JSON：secret / timeout / nasId / plain / bindPattern / baseDn / userAttr / tls / verifyTls
CREATE TABLE IF NOT EXISTS auth_servers (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  type       TEXT NOT NULL,
  host       TEXT NOT NULL,
  port       INTEGER NOT NULL DEFAULT 0,
  enabled    INTEGER NOT NULL DEFAULT 1,
  cfg        TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS ledgers (
  username   TEXT PRIMARY KEY,
  data       TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  username   TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(username);
CREATE INDEX IF NOT EXISTS idx_sessions_exp  ON sessions(expires_at);

-- 巡检附件：文件内容以 base64 存 data 列（D1 单行上限 2MB，故单文件上限 1MB）
CREATE TABLE IF NOT EXISTS attachments (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  mime       TEXT NOT NULL,
  size       INTEGER NOT NULL,
  owner      TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  data       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_attachments_owner ON attachments(owner);

-- 台账变更日志：按数据归属存（共享数据集共用一份历史），每数据集最多保留 2000 条
CREATE TABLE IF NOT EXISTS ledger_logs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  username   TEXT NOT NULL,
  actor      TEXT NOT NULL,
  kind       TEXT NOT NULL,
  action     TEXT NOT NULL,
  target     TEXT NOT NULL DEFAULT '',
  detail     TEXT NOT NULL DEFAULT '',
  at         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ledger_logs_owner ON ledger_logs(username, at);

-- 首页照片：全站单行（id 恒为 1），base64 存 data（D1 单行上限 2MB → 图片上限 1.4MB）
CREATE TABLE IF NOT EXISTS home_photo (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  data       TEXT NOT NULL,
  mime       TEXT NOT NULL,
  size       INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);

-- 初始超级管理员：口令为既有默认值，标记必须首次登录后立即修改（must_change=1）
-- 已存在则不覆盖，保证改密后重复执行不会回退
INSERT OR IGNORE INTO users (username, name, role, status, note, salt, hash, must_change, created_at, last_login)
VALUES ('admin', '超级管理员', 'admin', 'active', '系统初始超级管理员', 'Sa64bc60c760738d3', '0951988844fabe13ab97e7b6c9f0f1edcd10f68efaf9a42dba7cfd6086768237', 1, '2026-10-14T08:46:23.603Z', '');
