"""Prepared demo scenarios: peak queue, shoe-size shortage, fault + switch.

Customers and money are demo data. Each function is idempotent-ish (safe to run
on the seeded database) and returns a small summary.
"""
from __future__ import annotations


def peak_queue(svc):
    """高峰排队: enqueue a burst of varied parties incl. bumper needs and a
    large group, to exercise ETA and lane-fit allocation."""
    burst = [
        ("高峰-何佳", 2, 0, [36, 41]),
        ("高峰-罗鹏", 5, 1, [34, 37, 39, 42, 44]),
        ("高峰-高雄", 8, 0, [38, 39, 40, 40, 41, 42, 43, 45]),
        ("高峰-林琳", 3, 1, [35, 38, 40]),
        ("高峰-黄磊", 6, 0, [39, 40, 41, 42, 43, 44]),
        ("高峰-许晴", 2, 1, [34, 36]),
        ("高峰-马超", 4, 0, [40, 41, 42, 43]),
        ("高峰-郭静", 7, 1, [36, 37, 38, 40, 41, 42, 45]),
    ]
    ids = []
    for name, size, bumper, sizes in burst:
        p = svc.enqueue(name, size, bumper=bool(bumper), shoe_sizes=sizes)
        ids.append(p["group_no"])
    return {"enqueued": ids, "count": len(ids)}


def _free_lane(svc, party):
    for lane in svc.db.query(
            "SELECT * FROM lanes WHERE needs_repair=0 ORDER BY row_no,pos_x"):
        if (lane["capacity"] >= party["size"]
                and (not party["bumper"] or lane["has_bumper"])
                and svc._active_session_on_lane(lane["id"]) is None):
            return lane
    return None


def _assign_and_start(svc, party, package_id=1):
    lane = _free_lane(svc, party)
    if lane is None:
        return None, None, "无空闲适配球道"
    svc.db.execute(
        "UPDATE parties SET status='called',called_at=?,assigned_lane_id=? WHERE id=?",
        (svc.clock.iso(), lane["id"], party["id"]))
    r = svc.start_session(party["id"], package_id=package_id)
    return r, lane, None


def shoe_shortage(svc):
    """缺码样例: two parties each needing 45 — only one pair of size 45 exists.
    The second start is blocked until shoes return + sanitize."""
    p1 = svc.enqueue("缺码-大脚甲", 1, shoe_sizes=[45])
    r1, lane1, e1 = _assign_and_start(svc, p1)
    p2 = svc.enqueue("缺码-大脚乙", 1, shoe_sizes=[45])
    blocked = None
    try:
        r2, lane2, e2 = _assign_and_start(svc, p2)
        if e2:
            blocked = e2
    except Exception as e:
        blocked = str(e)
    if blocked:
        # 开局失败回滚为候场，保留订单
        svc.db.execute(
            "UPDATE parties SET status='waiting',called_at=NULL,assigned_lane_id=NULL "
            "WHERE id=?", (p2["id"],))
    return {
        "first_party": p1["group_no"],
        "first_lane": lane1["code"] if lane1 else None,
        "first_started": bool(r1),
        "second_party": p2["group_no"],
        "second_blocked_reason": blocked or "已开局（库存异常，请检查45码数量）",
        "hint": "全场仅 1 双 45 码；甲等归还并消毒完成后乙才能开局",
    }


def fault_switch(svc):
    """换道样例: fault the lane of a currently playing session (L02 if active),
    pausing calling while preserving the order; desk then picks a free lane on
    the same row via 换道."""
    # find an active session, prefer L02
    row = svc.db.query_one(
        "SELECT sl.session_id,sl.lane_id,l.code FROM session_lanes sl "
        "JOIN lanes l ON l.id=sl.lane_id WHERE sl.occupy_to IS NULL "
        "ORDER BY (l.code='L02') DESC LIMIT 1")
    if not row:
        return {"message": "当前无进行中场次，请先开局再运行换道样例"}
    lane = svc.report_lane_fault(row["lane_id"], "换道样例：回球机异响")
    return {
        "session_id": row["session_id"], "faulted_lane": lane["code"],
        "hint": f"{lane['code']} 已暂停叫号；在场次行点「换道」，同一水平排选空闲道",
    }
