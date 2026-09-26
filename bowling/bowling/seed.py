"""Demo seed data: lanes, packages, shoes (size matrix), balls, and a few
waiting/active parties. Customers and money are all demo data."""
from __future__ import annotations

import json

from .locks import Clock

CUSTOMERS = [
    ("张磊", "13800000001"), ("李娜", "13800000002"), ("王强", "13800000003"),
    ("赵敏", "13800000004"), ("陈杰", "13800000005"), ("刘洋", "13800000006"),
    ("孙丽", "13800000007"), ("周涛", "13800000008"), ("吴芳", "13800000009"),
    ("郑斌", "13800000010"),
]

SHOE_SIZES = [34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45]


def seed(svc, *, active_sessions: bool = True):
    db = svc.db
    now = svc.clock.iso()

    if db.query_one("SELECT COUNT(*) c FROM lanes")["c"] == 0:
        # Two parallel rows of lanes (并列关系). Front row 8 lanes, back row 8.
        lanes = []
        layout = [
            (1, 8, 6, 3800, 2800),   # row,count,capacity,hourly,per_game
            (2, 8, 8, 4200, 3200),
        ]
        idx = 1
        for row_no, count, cap, hourly, game in layout:
            for x in range(1, count + 1):
                code = f"L{idx:02d}"
                db.execute(
                    "INSERT INTO lanes(code,name,row_no,pos_x,capacity,has_bumper,"
                    "hourly_rate_cents,per_game_cents,created_at)"
                    " VALUES (?,?,?,?,?,1,?,?,?)",
                    (code, f"{idx}号道", row_no, x, cap, hourly, game, now))
                idx += 1
        # a couple of bumper-less lanes for realism
        db.execute("UPDATE lanes SET has_bumper=0 WHERE code IN ('L15','L16')")

    if db.query_one("SELECT COUNT(*) c FROM packages")["c"] == 0:
        for name, games, price in [
            ("欢乐1局", 1, 2800), ("畅享2局", 2, 5200),
            ("尽兴3局", 3, 7200), ("团体5局", 5, 11000),
        ]:
            db.execute("INSERT INTO packages(name,games,price_cents,active) VALUES (?,?,?,1)",
                       (name, games, price))

    if db.query_one("SELECT COUNT(*) c FROM shoes")["c"] == 0:
        # size matrix: 3 pairs per size (one of some sizes will be tight on purpose)
        for size in SHOE_SIZES:
            for n in range(1, 4):
                code = f"S-{size}-{n:02d}"
                db.execute(
                    "INSERT INTO shoes(code,size_eu,status) VALUES (?,?,'in_stock')",
                    (code, size))
        # make 45 scarce: only one pair
        db.execute("DELETE FROM shoes WHERE code IN ('S-45-02','S-45-03')")

    if db.query_one("SELECT COUNT(*) c FROM balls")["c"] == 0:
        for i, w in enumerate([6, 8, 9, 10, 11, 12, 13, 14, 15, 16], start=1):
            db.execute("INSERT INTO balls(code,weight_lb,status) VALUES (?,?,'ok')",
                       (f"B-{w:02d}-{i:02d}", w))

    if db.query_one("SELECT COUNT(*) c FROM parties")["c"] == 0:
        # A few already-playing sessions
        if active_sessions:
            _seed_active(svc)
        # Waiting queue demo (varied sizes / bumper needs)
        demo_waiting = [
            (2, 0, [37, 42]),
            (4, 1, [35, 36, 41, 43]),
            (6, 1, [38, 39, 40, 42, 43, 44]),
            (3, 0, [36, 38, 44]),
            (5, 0, [37, 40, 41, 42, 45]),
            (2, 1, [35, 39]),
            (7, 0, [38, 39, 40, 41, 42, 43, 44]),
        ]
        for i, (size, bumper, sizes) in enumerate(demo_waiting):
            name, phone = CUSTOMERS[i % len(CUSTOMERS)]
            n = db.query_one("SELECT COUNT(*) c FROM parties")["c"] + 1
            gno = f"A{n:03d}"
            db.execute(
                "INSERT INTO parties(group_no,customer_name,phone,size,bumper,"
                "shoe_sizes,status,enqueued_at,eta_seconds)"
                " VALUES (?,?,?,?,?,?,'waiting',?,?)",
                (gno, name, phone, size, bumper, json.dumps(sizes),
                 svc.clock.iso(), (i + 1) * 720))
        svc._recompute_eta()


def _seed_active(svc):
    """Start two live sessions so the floor map shows occupied lanes."""
    db = svc.db
    # directly construct sessions on L02 and L10 to control timing
    p1 = svc.enqueue("林青(进行中)", 4, bumper=True, shoe_sizes=[37, 38, 42, 43])
    call = svc.call_next()
    # force onto L02
    lane = db.query_one("SELECT * FROM lanes WHERE code='L02'")
    db.execute("UPDATE parties SET assigned_lane_id=? WHERE id=?", (lane["id"], p1["id"]))
    svc.start_session(p1["id"], package_id=2)

    p2 = svc.enqueue("高翔(进行中)", 3, bumper=False, shoe_sizes=[40, 42, 44])
    svc.call_next()
    lane2 = db.query_one("SELECT * FROM lanes WHERE code='L10'")
    db.execute("UPDATE parties SET assigned_lane_id=? WHERE id=?", (lane2["id"], p2["id"]))
    svc.start_session(p2["id"], package_id=3)
    # these two parties leave the waiting queue; the demo waiting list follows
