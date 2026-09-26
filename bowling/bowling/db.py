"""SQLite connection helpers and schema for the bowling alley system."""
from __future__ import annotations

import sqlite3
import threading
from pathlib import Path

SCHEMA = """
PRAGMA journal_mode=WAL;

CREATE TABLE IF NOT EXISTS lanes (
    id INTEGER PRIMARY KEY,
    code TEXT NOT NULL UNIQUE,          -- 球道编号 如 L01
    name TEXT NOT NULL,
    row_no INTEGER NOT NULL DEFAULT 1, -- 并列排，平面图用
    pos_x INTEGER NOT NULL,            -- 同排内位置
    capacity INTEGER NOT NULL,         -- 球道容量(人)
    has_bumper INTEGER NOT NULL DEFAULT 1, -- 是否配有护栏
    hourly_rate_cents INTEGER NOT NULL,
    per_game_cents INTEGER NOT NULL,
    needs_repair INTEGER NOT NULL DEFAULT 0,
    repair_reason TEXT,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS parties (
    id INTEGER PRIMARY KEY,
    group_no TEXT NOT NULL UNIQUE,      -- 候场号 A001
    customer_name TEXT NOT NULL,       -- 演示顾客
    phone TEXT,
    size INTEGER NOT NULL,             -- 人数
    bumper INTEGER NOT NULL DEFAULT 0, -- 护栏需求
    shoe_sizes TEXT NOT NULL,          -- JSON 所需尺码列表
    status TEXT NOT NULL,              -- waiting/called/no_show/seated/finished/cancelled
    enqueued_at TEXT NOT NULL,
    called_at TEXT,
    no_show_at TEXT,
    restore_at TEXT,                   -- 过号恢复时间（本进程时钟）
    assigned_lane_id INTEGER,          -- 叫号时候选球道
    seated_at TEXT,
    finished_at TEXT,
    eta_seconds INTEGER NOT NULL DEFAULT 0,
    note TEXT
);

CREATE TABLE IF NOT EXISTS packages (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,               -- 局数套餐
    games INTEGER NOT NULL,
    price_cents INTEGER NOT NULL,
    active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS shoes (
    id INTEGER PRIMARY KEY,
    code TEXT NOT NULL UNIQUE,         -- 球鞋编号 S-38-01
    size_eu INTEGER NOT NULL,          -- 尺码
    status TEXT NOT NULL,             -- in_stock/on_loan/sanitizing/repair/retired
    current_party_id INTEGER,
    loaned_at TEXT,
    damaged_photo TEXT,
    note TEXT
);
CREATE INDEX IF NOT EXISTS idx_shoes_size_status ON shoes(size_eu, status);

CREATE TABLE IF NOT EXISTS balls (
    id INTEGER PRIMARY KEY,
    code TEXT NOT NULL UNIQUE,
    weight_lb INTEGER NOT NULL,        -- 保龄球重量(磅)
    status TEXT NOT NULL DEFAULT 'ok' -- ok/stuck/repair
);

CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY,
    party_id INTEGER NOT NULL,
    lane_id INTEGER NOT NULL,
    package_id INTEGER,
    started_at TEXT NOT NULL,         -- 开局时间
    ended_at TEXT,
    planned_games INTEGER NOT NULL,
    actual_games REAL NOT NULL DEFAULT 0,
    hourly_rate_cents INTEGER NOT NULL,
    per_game_cents INTEGER NOT NULL,
    status TEXT NOT NULL,             -- playing/ended
    timed_out INTEGER NOT NULL DEFAULT 0, -- 计分器中断
    FOREIGN KEY(party_id) REFERENCES parties(id),
    FOREIGN KEY(lane_id) REFERENCES lanes(id)
);
CREATE INDEX IF NOT EXISTS idx_sessions_lane ON sessions(lane_id, started_at, ended_at);

-- 一个场次可能因换道占用多条球道（按时间段，互不重叠）
CREATE TABLE IF NOT EXISTS session_lanes (
    id INTEGER PRIMARY KEY,
    session_id INTEGER NOT NULL,
    lane_id INTEGER NOT NULL,
    occupy_from TEXT NOT NULL,
    occupy_to TEXT,                   -- NULL 表示当前占用
    reason TEXT NOT NULL,             -- start/switch/fault
    moved_by TEXT,
    FOREIGN KEY(session_id) REFERENCES sessions(id),
    FOREIGN KEY(lane_id) REFERENCES lanes(id)
);
CREATE INDEX IF NOT EXISTS idx_sl_lane_time ON session_lanes(lane_id, occupy_from, occupy_to);

CREATE TABLE IF NOT EXISTS shoe_loans (
    id INTEGER PRIMARY KEY,
    session_id INTEGER,
    party_id INTEGER NOT NULL,
    shoe_id INTEGER NOT NULL,
    loaned_at TEXT NOT NULL,
    returned_at TEXT,
    sanitize_batch_id INTEGER,
    status TEXT NOT NULL,            -- loaned/returned/sanitized/damaged_lost
    FOREIGN KEY(shoe_id) REFERENCES shoes(id)
);

CREATE TABLE IF NOT EXISTS sanitize_batches (
    id INTEGER PRIMARY KEY,
    created_at TEXT NOT NULL,
    finished_at TEXT,
    operator TEXT NOT NULL,
    status TEXT NOT NULL,           -- pending/done
    note TEXT
);

CREATE TABLE IF NOT EXISTS faults (
    id INTEGER PRIMARY KEY,
    lane_id INTEGER,
    session_id INTEGER,
    kind TEXT NOT NULL,             -- lane_fault/ball_stuck/scorer_outage
    description TEXT NOT NULL,
    reported_at TEXT NOT NULL,
    resolved_at TEXT,
    photo_path TEXT,
    FOREIGN KEY(lane_id) REFERENCES lanes(id)
);

-- 异常事件：过号/临时加人/球鞋缺码/卡球/计分器中断/换道/超局/鞋件损坏
CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY,
    kind TEXT NOT NULL,
    party_id INTEGER,
    session_id INTEGER,
    lane_id INTEGER,
    detail TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS bills (
    id INTEGER PRIMARY KEY,
    session_id INTEGER NOT NULL UNIQUE,
    party_id INTEGER NOT NULL,
    lane_fee_cents INTEGER NOT NULL DEFAULT 0,
    shoe_fee_cents INTEGER NOT NULL DEFAULT 0,
    surcharge_cents INTEGER NOT NULL DEFAULT 0, -- 超局/损坏等
    discount_cents INTEGER NOT NULL DEFAULT 0,  -- 免单/优惠
    compensation_cents INTEGER NOT NULL DEFAULT 0, -- 故障赔付
    total_cents INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL,           -- draft/paid/refunding/refunded
    created_at TEXT NOT NULL,
    paid_at TEXT,
    payment_ref TEXT,
    refund_ref TEXT,
    refunded_at TEXT,
    reviewer TEXT,                  -- 值班经理复核
    reviewed_at TEXT,
    review_note TEXT
);

CREATE TABLE IF NOT EXISTS adjustments (
    id INTEGER PRIMARY KEY,
    bill_id INTEGER NOT NULL,
    kind TEXT NOT NULL,             -- comp(免单)/compensation(赔付)/surcharge/damage
    amount_cents INTEGER NOT NULL,
    reason TEXT NOT NULL,
    reviewer TEXT NOT NULL,        -- 值班经理
    created_at TEXT NOT NULL,
    FOREIGN KEY(bill_id) REFERENCES bills(id)
);
"""


class Database:
    """Thin sqlite wrapper; one connection per thread with a process-wide write lock."""

    def __init__(self, path: str | Path):
        self.path = str(path)
        self.write_lock = threading.RLock()
        self._tls = threading.local()
        self.init()

    def conn(self) -> sqlite3.Connection:
        c = getattr(self._tls, "conn", None)
        if c is None:
            c = sqlite3.connect(self.path, check_same_thread=False, timeout=30)
            c.row_factory = sqlite3.Row
            c.execute("PRAGMA foreign_keys=ON")
            self._tls.conn = c
        return c

    def init(self) -> None:
        with self.write_lock:
            self.conn().executescript(SCHEMA)
            self.conn().commit()

    def query(self, sql: str, params=()):
        return self.conn().execute(sql, params).fetchall()

    def query_one(self, sql: str, params=()):
        return self.conn().execute(sql, params).fetchone()

    def execute(self, sql: str, params=()):
        with self.write_lock:
            cur = self.conn().execute(sql, params)
            self.conn().commit()
            return cur

    def commit(self):
        with self.write_lock:
            self.conn().commit()
