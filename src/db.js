'use strict';
// SQLite 连接与表结构。使用 Node 内置 node:sqlite（同步驱动），
// 配合 BEGIN IMMEDIATE 事务与条件 UPDATE 实现资源双锁。
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS desks (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS packages (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  games INTEGER NOT NULL,
  price_cents INTEGER NOT NULL          -- 每人每套餐价格（分）
);

CREATE TABLE IF NOT EXISTS lanes (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  position INTEGER NOT NULL,            -- 并列顺序（平面图从左到右）
  bumper_capable INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'idle'   -- idle | occupied | fault | maintenance
);

CREATE TABLE IF NOT EXISTS shoes (
  id INTEGER PRIMARY KEY,
  shoe_no TEXT NOT NULL UNIQUE,
  size INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'available'
  -- available | rented | pending_disinfection | disinfecting | damaged | retired
);

CREATE TABLE IF NOT EXISTS balls (
  id INTEGER PRIMARY KEY,
  ball_no TEXT NOT NULL UNIQUE,
  weight INTEGER NOT NULL,              -- 磅
  status TEXT NOT NULL DEFAULT 'available'  -- available | in_use | maintenance
);

CREATE TABLE IF NOT EXISTS queue_groups (
  id INTEGER PRIMARY KEY,
  group_no TEXT NOT NULL UNIQUE,        -- 候场号，如 A001
  customer_name TEXT NOT NULL,
  phone TEXT NOT NULL DEFAULT '',
  party_size INTEGER NOT NULL,
  need_bumper INTEGER NOT NULL DEFAULT 0,
  package_id INTEGER NOT NULL REFERENCES packages(id),
  status TEXT NOT NULL DEFAULT 'waiting',
  -- waiting | called | playing | finished | missed | cancelled
  priority INTEGER NOT NULL DEFAULT 0,  -- 过号恢复后 +1，优先再叫
  miss_count INTEGER NOT NULL DEFAULT 0,
  desk_id INTEGER,
  created_at TEXT NOT NULL,
  called_at TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY,
  lane_id INTEGER NOT NULL REFERENCES lanes(id),
  group_id INTEGER NOT NULL REFERENCES queue_groups(id),
  package_id INTEGER NOT NULL REFERENCES packages(id),
  desk_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',  -- active | finished
  players INTEGER NOT NULL,
  planned_games INTEGER NOT NULL,
  actual_games INTEGER NOT NULL DEFAULT 0,
  extra_games INTEGER NOT NULL DEFAULT 0,  -- 超局
  bumper_used INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  amount_cents INTEGER NOT NULL DEFAULT 0, -- 结束时按实际局数算出的场费
  note TEXT NOT NULL DEFAULT ''
);

-- 球道时段：换道不得占用已有时段的判定依据
CREATE TABLE IF NOT EXISTS lane_slots (
  id INTEGER PRIMARY KEY,
  lane_id INTEGER NOT NULL REFERENCES lanes(id),
  session_id INTEGER NOT NULL REFERENCES sessions(id),
  started_at TEXT NOT NULL,
  ended_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_slots_lane ON lane_slots(lane_id, ended_at);

CREATE TABLE IF NOT EXISTS session_shoes (
  id INTEGER PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES sessions(id),
  shoe_id INTEGER NOT NULL REFERENCES shoes(id),
  desk_id INTEGER NOT NULL,
  rented_at TEXT NOT NULL,
  returned_at TEXT,
  damaged INTEGER NOT NULL DEFAULT 0,
  damage_note TEXT NOT NULL DEFAULT '',
  photo_path TEXT NOT NULL DEFAULT ''    -- 损坏照片，存本地目录
);
CREATE INDEX IF NOT EXISTS idx_ss_shoe ON session_shoes(shoe_id);

CREATE TABLE IF NOT EXISTS session_balls (
  id INTEGER PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES sessions(id),
  ball_id INTEGER NOT NULL REFERENCES balls(id),
  rented_at TEXT NOT NULL,
  returned_at TEXT
);

CREATE TABLE IF NOT EXISTS lane_changes (
  id INTEGER PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES sessions(id),
  from_lane_id INTEGER NOT NULL,
  to_lane_id INTEGER NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  desk_id INTEGER NOT NULL,
  changed_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS faults (
  id INTEGER PRIMARY KEY,
  lane_id INTEGER NOT NULL REFERENCES lanes(id),
  type TEXT NOT NULL,                   -- pin_jam | ball_return | scorer_down | other
  status TEXT NOT NULL DEFAULT 'open',  -- open | resolved
  note TEXT NOT NULL DEFAULT '',
  started_at TEXT NOT NULL,
  resolved_at TEXT
);

CREATE TABLE IF NOT EXISTS disinfection_batches (
  id INTEGER PRIMARY KEY,
  operator TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running', -- running | done
  started_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS disinfection_items (
  id INTEGER PRIMARY KEY,
  batch_id INTEGER NOT NULL REFERENCES disinfection_batches(id),
  shoe_id INTEGER NOT NULL REFERENCES shoes(id)
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  type TEXT NOT NULL,
  ref_type TEXT NOT NULL DEFAULT '',
  ref_id INTEGER NOT NULL DEFAULT 0,
  payload TEXT NOT NULL DEFAULT '{}',
  desk_id INTEGER,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_time ON events(created_at);

CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES sessions(id),
  amount_cents INTEGER NOT NULL,
  method TEXT NOT NULL DEFAULT 'cash',
  status TEXT NOT NULL DEFAULT 'paid',
  -- paid | pending_review | rejected | refunded
  idempotency_key TEXT NOT NULL UNIQUE,  -- 结账幂等键
  txn_id TEXT NOT NULL DEFAULT '',
  paid_at TEXT,
  refund_key TEXT UNIQUE,                -- 退款幂等键
  refund_id TEXT NOT NULL DEFAULT '',
  refunded_at TEXT,
  refund_amount_cents INTEGER
);

CREATE TABLE IF NOT EXISTS reviews (
  id INTEGER PRIMARY KEY,
  payment_id INTEGER NOT NULL REFERENCES payments(id),
  kind TEXT NOT NULL,                   -- comp 赔付 | free 免单
  amount_cents INTEGER NOT NULL DEFAULT 0,
  reason TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending', -- pending | approved | rejected
  requested_by INTEGER,
  reviewed_by TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  reviewed_at TEXT
);
`;

function openDb(dbPath) {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = new DatabaseSync(dbPath);
  db.exec(SCHEMA);
  return db;
}

module.exports = { openDb };
