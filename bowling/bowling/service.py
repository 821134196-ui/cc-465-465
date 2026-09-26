"""Domain services: queue, lane assignment, sessions, shoes, sanitizing,
faults/switch, billing and manager review.

All mutating operations take a single process-wide service lock (svc_lock) so
check-then-act sequences are atomic across two front desks. Individual lane and
shoe resource locks are also taken and provide the double-lock test surface.
"""
from __future__ import annotations

import json
import threading
from datetime import timedelta

from .adapters import PaymentAdapter, ScorerAdapter, ScorerError
from .db import Database
from .locks import Clock, ResourceLocks

SHOE_FEE_CENTS = 500          # 每双鞋租金
NO_SHOW_AFTER = 300           # 叫号后 5 分钟未确认算过号
RESTORE_WINDOW = 600          # 过号 10 分钟内可恢复，保留优先位置
OVERDUE_GAMES = True


class ServiceError(RuntimeError):
    """Business rule violation."""


class Service:
    def __init__(self, db: Database, clock: Clock | None = None,
                 scorer: ScorerAdapter | None = None,
                 payment: PaymentAdapter | None = None,
                 photo_dir: str = "data/photos"):
        self.db = db
        self.clock = clock or Clock()
        self.locks = ResourceLocks()
        self.svc_lock = threading.RLock()
        self.scorer = scorer or ScorerAdapter()
        self.payment = payment or PaymentAdapter()
        self.photo_dir = photo_dir
        # in-process metrics: 过号次数 / 场次时长
        self.metrics_lock = threading.Lock()
        self.session_seconds: dict[int, float] = {}

    # ---------------------------------------------------------------- utils
    def _event(self, kind, detail, party_id=None, session_id=None, lane_id=None):
        self.db.execute(
            "INSERT INTO events(kind,party_id,session_id,lane_id,detail,created_at)"
            " VALUES (?,?,?,?,?,?)",
            (kind, party_id, session_id, lane_id, detail, self.clock.iso()),
        )

    def _lane(self, lane_id):
        return self.db.query_one("SELECT * FROM lanes WHERE id=?", (lane_id,))

    def _party(self, party_id):
        return self.db.query_one("SELECT * FROM parties WHERE id=?", (party_id,))

    def _active_session_on_lane(self, lane_id):
        row = self.db.query_one(
            "SELECT sl.session_id FROM session_lanes sl WHERE sl.lane_id=? "
            "AND sl.occupy_to IS NULL", (lane_id,))
        return row["session_id"] if row else None

    # ------------------------------------------------------------ queue ops
    def enqueue(self, customer_name, size, bumper=False, shoe_sizes=None,
                phone="", note=""):
        if size <= 0:
            raise ServiceError("人数必须大于 0")
        shoe_sizes = shoe_sizes or []
        if len(shoe_sizes) != size:
            # 允许只给部分尺码，其余按默认补 42
            shoe_sizes = (shoe_sizes + [42] * size)[:size]
        with self.svc_lock:
            n = self.db.query_one("SELECT COUNT(*) c FROM parties")["c"] + 1
            group_no = f"A{n:03d}"
            cur = self.db.execute(
                "INSERT INTO parties(group_no,customer_name,phone,size,bumper,"
                "shoe_sizes,status,enqueued_at,eta_seconds,note)"
                " VALUES (?,?,?,?,?,?, 'waiting', ?,0,?)",
                (group_no, customer_name, phone, size, 1 if bumper else 0,
                 json.dumps(shoe_sizes), self.clock.iso(), note),
            )
            pid = cur.lastrowid
            self._event("enqueue", f"{customer_name} {size}人 护栏={'是' if bumper else '否'}",
                        party_id=pid)
            self._recompute_eta()
            return self._party(pid)

    def _candidate_lanes(self, size, bumper):
        """Lanes that fit a party: capacity>=size, bumper if required, not in
        repair. Ordered by row/pos for a stable, spatially-sensible choice."""
        sql = ("SELECT * FROM lanes WHERE needs_repair=0 AND capacity>=? ")
        params = [size]
        if bumper:
            sql += "AND has_bumper=1 "
        sql += "ORDER BY row_no,pos_x"
        return self.db.query(sql, tuple(params))

    def call_next(self, desk="前台1"):
        """叫号: pick the longest-waiting party that fits an available lane."""
        with self.svc_lock:
            parties = self.db.query(
                "SELECT * FROM parties WHERE status='waiting' ORDER BY enqueued_at,id")
            for p in parties:
                lanes = self._candidate_lanes(p["size"], bool(p["bumper"]))
                free = [l for l in lanes if self._active_session_on_lane(l["id"]) is None]
                if not free:
                    continue
                lane = free[0]
                self.db.execute(
                    "UPDATE parties SET status='called',called_at=?,assigned_lane_id=? "
                    "WHERE id=?", (self.clock.iso(), lane["id"], p["id"]))
                self._event("call", f"叫号 {p['group_no']} -> {lane['code']}",
                            party_id=p["id"], lane_id=lane["id"])
                self._recompute_eta()
                return {"party": dict(self._party(p["id"])), "lane": dict(lane)}
            return None

    def mark_no_show(self, party_id, reason="超时未确认"):
        """过号: party called but did not confirm in time."""
        with self.svc_lock:
            p = self._party(party_id)
            if not p or p["status"] != "called":
                raise ServiceError("该组不在已叫号状态")
            # release the candidate lane reservation (it was never locked)
            self.db.execute(
                "UPDATE parties SET status='no_show',no_show_at=?,restore_at=?,"
                "assigned_lane_id=NULL WHERE id=?",
                (self.clock.iso(),
                 (self.clock.now() + timedelta(seconds=RESTORE_WINDOW)).replace(microsecond=0).isoformat(),
                 party_id))
            self._event("no_show", f"过号: {reason}", party_id=party_id)
            self._recompute_eta()
            return self._party(party_id)

    def restore_party(self, party_id):
        """过号恢复: within the window, jump back to the front of the line."""
        with self.svc_lock:
            p = self._party(party_id)
            if not p or p["status"] != "no_show":
                raise ServiceError("该组不是过号状态")
            if p["restore_at"] and self.clock.now().isoformat() > p["restore_at"]:
                raise ServiceError("已超过过号恢复时限")
            # 保留受影响订单优先位置：恢复原入队时间，自然排到新到顾客之前
            self.db.execute(
                "UPDATE parties SET status='waiting',no_show_at=NULL,restore_at=NULL,"
                "assigned_lane_id=NULL WHERE id=?", (party_id,))
            self._event("restore", "过号恢复，保留优先位置", party_id=party_id)
            self._recompute_eta()
            return self._party(party_id)

    def add_person(self, party_id, add_size, shoe_sizes=None):
        """临时加人: only while waiting/called; re-check lane capacity."""
        with self.svc_lock:
            p = self._party(party_id)
            if not p or p["status"] not in ("waiting", "called"):
                raise ServiceError("仅候场/已叫号组可临时加人")
            sizes = json.loads(p["shoe_sizes"]) + (shoe_sizes or [42] * add_size)
            new_size = p["size"] + add_size
            self.db.execute("UPDATE parties SET size=?,shoe_sizes=? WHERE id=?",
                            (new_size, json.dumps(sizes[:new_size]), party_id))
            # candidate lane may no longer fit -> clear assignment, recompute
            self.db.execute("UPDATE parties SET assigned_lane_id=NULL WHERE id=?", (party_id,))
            self._event("add_person", f"临时加人 +{add_size}，现 {new_size} 人",
                        party_id=party_id)
            self._recompute_eta()
            return self._party(party_id)

    def _recompute_eta(self):
        """预计等待: position * avg active session remaining (demo 12 min)."""
        waiting = self.db.query(
            "SELECT * FROM parties WHERE status='waiting' ORDER BY enqueued_at,id")
        per = 720
        for i, p in enumerate(waiting):
            self.db.execute("UPDATE parties SET eta_seconds=? WHERE id=?",
                            ((i + 1) * per, p["id"]))

    # ----------------------------------------------------------- start game
    def start_session(self, party_id, package_id=None, desk="前台1",
                      lane_id=None):
        """开局: lock lane + lock every borrowed shoe atomically."""
        with self.svc_lock:
            p = self._party(party_id)
            if not p:
                raise ServiceError("候场组不存在")
            if p["status"] not in ("called", "waiting"):
                raise ServiceError(f"组状态 {p['status']} 不能开局")
            target = lane_id or p["assigned_lane_id"]
            if not target:
                cands = self._candidate_lanes(p["size"], bool(p["bumper"]))
                free = [l for l in cands if self._active_session_on_lane(l["id"]) is None]
                if not free:
                    raise ServiceError("没有可分配的空闲球道")
                target = free[0]["id"]
            lane = self._lane(target)
            if lane["needs_repair"]:
                raise ServiceError(f"球道 {lane['code']} 故障中，暂停叫号")
            if lane["capacity"] < p["size"]:
                raise ServiceError(f"球道容量不足（{lane['capacity']} < {p['size']}）")
            if p["bumper"] and not lane["has_bumper"]:
                raise ServiceError("该球道无护栏，无法接待")

            # ---- resource lock #1: the lane (two desks cannot both open it)
            with self.locks.acquire("lane", target, owner=desk, block=False) as got_lane:
                if not got_lane:
                    raise ServiceError(f"球道 {lane['code']} 正被另一前台开启，请刷新")
                if self._active_session_on_lane(target) is not None:
                    raise ServiceError(f"球道 {lane['code']} 已在进行中")

                sizes = json.loads(p["shoe_sizes"])
                pkg = None
                if package_id:
                    pkg = self.db.query_one("SELECT * FROM packages WHERE id=? AND active=1",
                                            (package_id,))
                planned = pkg["games"] if pkg else 1

                # pick available shoes per required size
                chosen, shortage = self._pick_shoes(sizes, desk)
                if shortage:
                    self._event("shoe_shortage",
                                f"球鞋缺码: 缺 {', '.join(str(s) for s in shortage)}",
                                party_id=party_id)
                    raise ServiceError(
                        f"球鞋缺码，缺少尺码: {', '.join(str(s) for s in shortage)}")

                now = self.clock.iso()
                cur = self.db.execute(
                    "INSERT INTO sessions(party_id,lane_id,package_id,started_at,"
                    "planned_games,hourly_rate_cents,per_game_cents,status)"
                    " VALUES (?,?,?,?,?, ?,?, 'playing')",
                    (party_id, target, package_id, now, planned,
                     lane["hourly_rate_cents"], lane["per_game_cents"]))
                sid = cur.lastrowid
                self.db.execute(
                    "INSERT INTO session_lanes(session_id,lane_id,occupy_from,reason,moved_by)"
                    " VALUES (?,?,?, 'start',?)", (sid, target, now, desk))

                for shoe_id in chosen:
                    self.db.execute(
                        "INSERT INTO shoe_loans(session_id,party_id,shoe_id,loaned_at,status)"
                        " VALUES (?,?,?,?,'loaned')", (sid, party_id, shoe_id, now))
                    self.db.execute(
                        "UPDATE shoes SET status='on_loan',current_party_id=?,"
                        "loaned_at=? WHERE id=?", (party_id, now, shoe_id))

                self.db.execute(
                    "UPDATE parties SET status='seated',seated_at=?,assigned_lane_id=? "
                    "WHERE id=?", (now, target, party_id))
                self.scorer.register(lane["code"], planned)
                self._event("start",
                            f"开局 {lane['code']} 套餐{planned}局 借鞋{len(chosen)}双",
                            party_id=party_id, session_id=sid, lane_id=target)
                self._recompute_eta()
                return {"session_id": sid, "lane": dict(lane),
                        "shoes": chosen}

    def _pick_shoes(self, sizes, desk):
        """For each required size pick an in-stock shoe, taking its lock.
        Returns (chosen_ids, missing_sizes). All-or-nothing: on shortage or a
        contended lock every lock taken here is released on unwind."""
        needed: dict[int, int] = {}
        for s in sizes:
            needed[s] = needed.get(s, 0) + 1
        chosen = []
        missing = []
        cms = []
        try:
            for size, count in sorted(needed.items()):
                rows = self.db.query(
                    "SELECT * FROM shoes WHERE size_eu=? AND status='in_stock' "
                    "ORDER BY code LIMIT ?", (size, count))
                if len(rows) < count:
                    missing.extend([size] * (count - len(rows)))
                    continue
                for r in rows:
                    cm = self.locks.acquire("shoe", r["id"], owner=desk, block=False)
                    got = cm.__enter__()
                    cms.append(cm)
                    if not got:
                        # another desk grabbing the same pair at the same instant
                        raise ServiceError(f"球鞋 {r['code']} 正被另一前台借出")
                    # re-check status under the lock
                    cur = self.db.query_one("SELECT status FROM shoes WHERE id=?",
                                            (r["id"],))
                    if cur["status"] != "in_stock":
                        raise ServiceError(f"球鞋 {r['code']} 已不可借")
                    chosen.append(r["id"])
            if missing:
                return [], missing
            return chosen, []
        finally:
            for cm in reversed(cms):
                cm.__exit__(None, None, None)

    # ---------------------------------------------------------- in session
    def record_games(self, session_id, games):
        """Push actual games from the scorer; flag over-package games."""
        with self.svc_lock:
            s = self.db.query_one("SELECT * FROM sessions WHERE id=?", (session_id,))
            if not s or s["status"] != "playing":
                raise ServiceError("场次不在进行中")
            lane = self._lane(s["lane_id"])
            try:
                self.scorer.push_score(lane["code"], float(games))
            except ScorerError:
                raise ServiceError("计分器中断，无法读取局数")
            self.db.execute("UPDATE sessions SET actual_games=? WHERE id=?",
                            (float(games), session_id))
            if games > s["planned_games"]:
                self._event("over_game",
                            f"超局: 实际{games} > 套餐{s['planned_games']}",
                            session_id=session_id, lane_id=s["lane_id"])
            return True

    def read_scorer(self, session_id):
        """Read current games from the (mock) scorer console."""
        s = self.db.query_one("SELECT * FROM sessions WHERE id=?", (session_id,))
        lane = self._lane(s["lane_id"])
        try:
            return self.scorer.read_games(lane["code"])
        except ScorerError:
            raise ServiceError("计分器中断")

    def scorer_outage(self, session_id):
        """计分器中断事件 (hardware)."""
        with self.svc_lock:
            s = self.db.query_one("SELECT * FROM sessions WHERE id=?", (session_id,))
            lane = self._lane(s["lane_id"])
            self.scorer.break_outage(lane["code"])
            self.db.execute("UPDATE sessions SET timed_out=1 WHERE id=?", (session_id,))
            self.db.execute(
                "INSERT INTO faults(lane_id,session_id,kind,description,reported_at)"
                " VALUES (?,?, 'scorer_outage','计分器中断',?)",
                (s["lane_id"], session_id, self.clock.iso()))
            self._event("scorer_outage", "计分器中断", session_id=session_id,
                        lane_id=s["lane_id"])

    def scorer_recover(self, session_id, recovered_games):
        with self.svc_lock:
            s = self.db.query_one("SELECT * FROM sessions WHERE id=?", (session_id,))
            lane = self._lane(s["lane_id"])
            self.scorer.fix_outage(lane["code"], float(recovered_games))
            self.db.execute("UPDATE sessions SET timed_out=0,actual_games=? WHERE id=?",
                            (float(recovered_games), session_id))
            self.db.execute(
                "UPDATE faults SET resolved_at=? WHERE session_id=? AND kind='scorer_outage'"
                " AND resolved_at IS NULL", (self.clock.iso(), session_id))
            self._event("scorer_recover", f"计分器恢复，局数 {recovered_games}",
                        session_id=session_id, lane_id=s["lane_id"])

    def ball_stuck(self, session_id, ball_id=None, note=""):
        """卡球记录。"""
        with self.svc_lock:
            s = self.db.query_one("SELECT * FROM sessions WHERE id=?", (session_id,))
            if ball_id:
                self.db.execute("UPDATE balls SET status='stuck' WHERE id=?", (ball_id,))
            self.db.execute(
                "INSERT INTO faults(lane_id,session_id,kind,description,reported_at)"
                " VALUES (?,?, 'ball_stuck',?,?)",
                (s["lane_id"], session_id, note or "卡球", self.clock.iso()))
            self._event("ball_stuck", note or "卡球", session_id=session_id,
                        lane_id=s["lane_id"])

    def ball_freed(self, fault_id):
        f = self.db.query_one("SELECT * FROM faults WHERE id=?", (fault_id,))
        with self.svc_lock:
            self.db.execute("UPDATE faults SET resolved_at=? WHERE id=?",
                            (self.clock.iso(), fault_id))
            self.db.execute("UPDATE balls SET status='ok' WHERE status='stuck'")
            self._event("ball_freed", "卡球排除", session_id=f["session_id"],
                        lane_id=f["lane_id"])

    # ------------------------------------------------------------- faults
    def report_lane_fault(self, lane_id, reason, desk="前台1"):
        """设备故障: lane pauses calling; active session is preserved for switch."""
        with self.svc_lock:
            self.db.execute(
                "UPDATE lanes SET needs_repair=1,repair_reason=? WHERE id=?",
                (reason, lane_id))
            self.db.execute(
                "INSERT INTO faults(lane_id,kind,description,reported_at)"
                " VALUES (?, 'lane_fault',?,?)",
                (lane_id, reason, self.clock.iso()))
            self._event("lane_fault", f"球道故障: {reason}，暂停叫号", lane_id=lane_id)
            return self._lane(lane_id)

    def repair_done(self, lane_id):
        with self.svc_lock:
            self.db.execute(
                "UPDATE lanes SET needs_repair=0,repair_reason=NULL WHERE id=?", (lane_id,))
            self.db.execute(
                "UPDATE faults SET resolved_at=? WHERE lane_id=? AND kind='lane_fault'"
                " AND resolved_at IS NULL", (self.clock.iso(), lane_id))
            self._event("repair_done", "故障修复，恢复叫号", lane_id=lane_id)

    def switch_lane(self, session_id, new_lane_id, desk="前台1", reason="fault"):
        """换道: target must not be occupied for any overlapping time slot.

        换道不得占用已有时段 — verify no open occupancy and no interval overlap
        on the target lane. Old lane occupancy is closed at the switch moment.
        """
        with self.svc_lock:
            s = self.db.query_one("SELECT * FROM sessions WHERE id=?", (session_id,))
            if not s or s["status"] != "playing":
                raise ServiceError("场次不在进行中，无法换道")
            new_lane = self._lane(new_lane_id)
            if new_lane["needs_repair"]:
                raise ServiceError(f"目标球道 {new_lane['code']} 故障中")
            if new_lane["capacity"] < self._party(s["party_id"])["size"]:
                raise ServiceError("目标球道容量不足")
            now = self.clock.now()

            with self.locks.acquire("lane", new_lane_id, owner=desk, block=False) as got:
                if not got:
                    raise ServiceError("目标球道正被占用，请改选其他球道")
                # 已有时段冲突: any occupancy row overlapping [now, ...)
                overlap = self.db.query(
                    "SELECT * FROM session_lanes WHERE lane_id=? AND "
                    "(occupy_to IS NULL OR occupy_to > ?)",
                    (new_lane_id, now.replace(microsecond=0).isoformat()))
                overlap = [o for o in overlap if o["session_id"] != session_id]
                if overlap:
                    raise ServiceError(
                        f"目标球道 {new_lane['code']} 已有时段占用，换道不得重叠")

                old_lane_id = s["lane_id"]
                now_iso = self.clock.iso()
                self.db.execute(
                    "UPDATE session_lanes SET occupy_to=? WHERE session_id=? "
                    "AND occupy_to IS NULL", (now_iso, session_id))
                self.db.execute(
                    "INSERT INTO session_lanes(session_id,lane_id,occupy_from,reason,moved_by)"
                    " VALUES (?,?,?,?,?)",
                    (session_id, new_lane_id, now_iso,
                     "fault" if reason == "fault" else "switch", desk))
                self.db.execute("UPDATE sessions SET lane_id=? WHERE id=?",
                                (new_lane_id, session_id))
                # move scorer progress to the new console
                self.scorer.move(self._lane(old_lane_id)["code"], new_lane["code"])
                self._event("switch",
                            f"换道 {self._lane(old_lane_id)['code']} -> {new_lane['code']}"
                            f"（{reason}）",
                            session_id=session_id, lane_id=new_lane_id)
                return {"old_lane_id": old_lane_id, "new_lane_id": new_lane_id}

    # --------------------------------------------------------- shoes / sanitize
    def return_shoe(self, loan_id, damaged=False, photo_b64=None, note=""):
        """球鞋归还即进入待消毒 (or repair if damaged)."""
        with self.svc_lock:
            loan = self.db.query_one("SELECT * FROM shoe_loans WHERE id=?", (loan_id,))
            if not loan or loan["status"] != "loaned":
                raise ServiceError("该球鞋不在借出状态")
            now = self.clock.iso()
            photo_path = None
            if photo_b64:
                photo_path = self._save_photo(loan["shoe_id"], photo_b64)
            if damaged:
                self.db.execute(
                    "UPDATE shoe_loans SET status='damaged_lost',returned_at=? WHERE id=?",
                    (now, loan_id))
                self.db.execute(
                    "UPDATE shoes SET status='repair',damaged_photo=?,note=? WHERE id=?",
                    (photo_path, note, loan["shoe_id"]))
                self._event("shoe_damage", f"鞋件损坏: {note} (照片 {photo_path})",
                            party_id=loan["party_id"], session_id=loan["session_id"])
            else:
                self.db.execute(
                    "UPDATE shoe_loans SET status='returned',returned_at=? WHERE id=?",
                    (now, loan_id))
                # 归还即进入待消毒：归入一个待处理批次
                batch = self.db.query_one(
                    "SELECT * FROM sanitize_batches WHERE status='pending' "
                    "ORDER BY id DESC LIMIT 1")
                if not batch:
                    cur = self.db.execute(
                        "INSERT INTO sanitize_batches(created_at,operator,status,note)"
                        " VALUES (?,'系统','pending','自动归集')", (now,))
                    batch_id = cur.lastrowid
                else:
                    batch_id = batch["id"]
                self.db.execute(
                    "UPDATE shoes SET status='sanitizing',current_party_id=NULL,"
                    "loaned_at=NULL WHERE id=?", (loan["shoe_id"],))
                self.db.execute("UPDATE shoe_loans SET sanitize_batch_id=? WHERE id=?",
                                (batch_id, loan_id))
            return loan["shoe_id"]

    def _save_photo(self, shoe_id, b64data):
        import base64, os
        os.makedirs(self.photo_dir, exist_ok=True)
        name = f"shoe_{shoe_id}_{self.clock.now().strftime('%Y%m%d%H%M%S')}.jpg"
        path = os.path.join(self.photo_dir, name)
        raw = b64data.split(",", 1)[-1]
        with open(path, "wb") as f:
            f.write(base64.b64decode(raw))
        return path

    def sanitize_finish(self, batch_id, operator="值班员"):
        """消毒完成，鞋才可再次借出。"""
        with self.svc_lock:
            b = self.db.query_one("SELECT * FROM sanitize_batches WHERE id=?", (batch_id,))
            if not b or b["status"] != "pending":
                raise ServiceError("批次不存在或已完成")
            now = self.clock.iso()
            loans = self.db.query(
                "SELECT * FROM shoe_loans WHERE sanitize_batch_id=? AND status='returned'",
                (batch_id,))
            for ln in loans:
                self.db.execute("UPDATE shoes SET status='in_stock' WHERE id=? "
                                "AND status='sanitizing'", (ln["shoe_id"],))
                self.db.execute("UPDATE shoe_loans SET status='sanitized' WHERE id=?",
                                (ln["id"],))
            self.db.execute(
                "UPDATE sanitize_batches SET status='done',finished_at=?,operator=? WHERE id=?",
                (now, operator, batch_id))
            self._event("sanitize", f"消毒批次 {batch_id} 完成 {len(loans)} 双")
            return len(loans)

    # ------------------------------------------------------------- billing
    def end_session(self, session_id):
        """结束并生成 draft 账单（按实际局数结算）。"""
        with self.svc_lock:
            s = self.db.query_one("SELECT * FROM sessions WHERE id=?", (session_id,))
            if not s or s["status"] != "playing":
                raise ServiceError("场次已结束或不存在")
            # read scorer games (mock console); outage -> use stored games
            try:
                games = self.scorer.read_games(self._lane(s["lane_id"])["code"])
            except ScorerError:
                games = s["actual_games"]
            games = max(games, float(s["actual_games"]))
            now = self.clock.iso()
            self.db.execute(
                "UPDATE sessions SET status='ended',ended_at=?,actual_games=? WHERE id=?",
                (now, games, session_id))
            # close lane occupancy
            self.db.execute(
                "UPDATE session_lanes SET occupy_to=? WHERE session_id=? AND occupy_to IS NULL",
                (now, session_id))

            shoes_n = self.db.query_one(
                "SELECT COUNT(*) c FROM shoe_loans WHERE session_id=?",
                (session_id,))["c"]
            # 套餐价覆盖计划局数；超出套餐的局数按单局价加收
            base_fee = s["planned_games"] * s["per_game_cents"]
            if s["package_id"]:
                pkg = self.db.query_one("SELECT price_cents FROM packages WHERE id=?",
                                        (s["package_id"],))
                if pkg:
                    base_fee = pkg["price_cents"]
            lane_fee = base_fee
            shoe_fee = shoes_n * SHOE_FEE_CENTS
            surcharge = 0
            if games > s["planned_games"]:
                surcharge = int(round((games - s["planned_games"]) * s["per_game_cents"]))
            total = lane_fee + shoe_fee + surcharge
            cur = self.db.execute(
                "INSERT INTO bills(session_id,party_id,lane_fee_cents,shoe_fee_cents,"
                "surcharge_cents,total_cents,status,created_at)"
                " VALUES (?,?,?,?,?,?,'draft',?)",
                (session_id, s["party_id"], lane_fee, shoe_fee, surcharge, total, now))
            bill_id = cur.lastrowid
            self.db.execute("UPDATE parties SET status='finished',finished_at=? WHERE id=?",
                            (now, s["party_id"]))
            # session duration metric
            from datetime import datetime
            started = datetime.fromisoformat(s["started_at"])
            with self.metrics_lock:
                self.session_seconds[session_id] = (
                    self.clock.now() - started).total_seconds()
            self._event("end", f"结束 实际{games}局 账单{total/100:.2f}元",
                        session_id=session_id, party_id=s["party_id"])
            return self.get_bill(bill_id)

    def adjust_bill(self, bill_id, kind, amount_cents, reason, manager):
        """赔付/免单/损坏加收 — 必须值班经理复核。"""
        if not manager:
            raise ServiceError("赔付和免单必须由值班经理复核")
        with self.svc_lock:
            b = self.db.query_one("SELECT * FROM bills WHERE id=?", (bill_id,))
            if not b:
                raise ServiceError("账单不存在")
            if kind not in ("comp", "compensation", "surcharge", "damage"):
                raise ServiceError("未知调整类型")
            self.db.execute(
                "INSERT INTO adjustments(bill_id,kind,amount_cents,reason,reviewer,created_at)"
                " VALUES (?,?,?,?,?,?)",
                (bill_id, kind, amount_cents, reason, manager, self.clock.iso()))
            self.db.execute(
                "UPDATE bills SET reviewer=?,reviewed_at=?,review_note=? WHERE id=?",
                (manager, self.clock.iso(), reason, bill_id))
            self._recalc_bill(bill_id)
            return self.get_bill(bill_id)

    def _recalc_bill(self, bill_id):
        b = self.db.query_one("SELECT * FROM bills WHERE id=?", (bill_id,))
        adj = self.db.query("SELECT kind,amount_cents FROM adjustments WHERE bill_id=?",
                            (bill_id,))
        comp = sum(a["amount_cents"] for a in adj if a["kind"] == "comp")
        compensation = sum(a["amount_cents"] for a in adj if a["kind"] == "compensation")
        extra = sum(a["amount_cents"] for a in adj if a["kind"] in ("surcharge", "damage"))
        base = b["lane_fee_cents"] + b["shoe_fee_cents"] + b["surcharge_cents"] + extra
        total = max(0, base - comp - compensation)
        self.db.execute(
            "UPDATE bills SET discount_cents=?,compensation_cents=?,total_cents=? WHERE id=?",
            (comp, compensation, total, bill_id))

    def checkout(self, bill_id, desk="前台1"):
        """付款（mock gateway）。"""
        with self.svc_lock:
            b = self.db.query_one("SELECT * FROM bills WHERE id=?", (bill_id,))
            if not b:
                raise ServiceError("账单不存在")
            if b["status"] in ("paid", "refunding", "refunded"):
                return self.get_bill(bill_id)
            pay = self.payment.charge(b["total_cents"], tag=f"bill-{bill_id}")
            if pay.status != "paid":
                raise ServiceError("付款失败（金额异常）")
            self.db.execute(
                "UPDATE bills SET status='paid',paid_at=?,payment_ref=? WHERE id=?",
                (self.clock.iso(), pay.ref, bill_id))
            self._event("pay", f"付款 {pay.ref} {b['total_cents']/100:.2f}元",
                        party_id=b["party_id"])
            return self.get_bill(bill_id)

    def refund(self, bill_id, manager, reason=""):
        """退款 — 幂等：同一账单多次退款只产生一次退款流水。"""
        if not manager:
            raise ServiceError("退款必须由值班经理复核")
        with self.svc_lock:
            b = self.db.query_one("SELECT * FROM bills WHERE id=?", (bill_id,))
            if not b:
                raise ServiceError("账单不存在")
            if b["status"] == "refunded":
                # 幂等返回已有退款
                return self.get_bill(bill_id)
            if not b["payment_ref"]:
                raise ServiceError("账单未付款，无法退款")
            pay = self.payment.refund(b["payment_ref"])  # adapter 层幂等
            self.db.execute(
                "UPDATE bills SET status='refunded',refund_ref=?,refunded_at=?,"
                "reviewer=?,review_note=? WHERE id=?",
                (pay.refund_ref, self.clock.iso(), manager, reason or b["review_note"],
                 bill_id))
            self.db.execute(
                "INSERT INTO adjustments(bill_id,kind,amount_cents,reason,reviewer,created_at)"
                " VALUES (?, 'compensation',0,?,?,?)",
                (bill_id, f"退款 {pay.refund_ref} {reason}", manager, self.clock.iso()))
            self._event("refund", f"退款 {pay.refund_ref}（{reason}）",
                        party_id=b["party_id"])
            return self.get_bill(bill_id)

    def get_bill(self, bill_id):
        b = self.db.query_one("SELECT * FROM bills WHERE id=?", (bill_id,))
        adjs = self.db.query("SELECT * FROM adjustments WHERE bill_id=? ORDER BY id",
                             (bill_id,))
        d = dict(b)
        d["adjustments"] = [dict(a) for a in adjs]
        return d

    # --------------------------------------------------------- background tick
    def tick(self):
        """In-process periodic task: auto no-show + duration bookkeeping.
        Called by a scheduler thread and directly in tests."""
        fired = []
        with self.svc_lock:
            now = self.clock.now()
            called = self.db.query("SELECT * FROM parties WHERE status='called'")
            for p in called:
                if p["called_at"]:
                    called_at = _parse(p["called_at"])
                    if (now - called_at).total_seconds() >= NO_SHOW_AFTER:
                        # auto no-show, preserving restore window
                        self.db.execute(
                            "UPDATE parties SET status='no_show',no_show_at=?,"
                            "restore_at=?,assigned_lane_id=NULL WHERE id=?",
                            (self.clock.iso(),
                             (now + timedelta(seconds=RESTORE_WINDOW))
                             .replace(microsecond=0).isoformat(), p["id"]))
                        self._event("no_show", "超时未确认，系统自动过号",
                                    party_id=p["id"])
                        fired.append(p["id"])
            self._recompute_eta()
        return fired


def _parse(s):
    from datetime import datetime
    return datetime.fromisoformat(s)
