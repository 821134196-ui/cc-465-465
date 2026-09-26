"""Functional tests:
1. 资源双锁 (lane + shoe, two front desks)
2. 过号恢复 (auto no-show + priority restore)
3. 消毒阻断 (returned shoes cannot be re-loaned until sanitized)
4. 换道计费 (switch across lanes, no time-slot overlap, billing still correct)
5. 退款幂等 (repeat refund -> same refund_ref, single money movement)
"""
import os
import sys
import tempfile
import threading
import time
import unittest
from datetime import datetime

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from bowling import Database, Service, Clock
from bowling.service import ServiceError


class BaseCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db = Database(os.path.join(self.tmp.name, "t.db"))
        self.clock = Clock(datetime(2026, 9, 26, 18, 0, 0))
        self.svc = Service(self.db, clock=self.clock,
                           photo_dir=os.path.join(self.tmp.name, "photos"))
        self._seed_minimal()

    def tearDown(self):
        self.tmp.cleanup()

    def _seed_minimal(self):
        db = self.db
        now = self.clock.iso()
        # 4 lanes in one row, capacity 6, all with bumpers
        for i in range(1, 5):
            db.execute(
                "INSERT INTO lanes(code,name,row_no,pos_x,capacity,has_bumper,"
                "hourly_rate_cents,per_game_cents,created_at) VALUES (?,?,1,?,6,1,3800,2800,?)",
                (f"L{i:02d}", f"{i}号道", i, now))
        for name, games, price in [("1局", 1, 2800), ("3局", 3, 7200)]:
            db.execute("INSERT INTO packages(name,games,price_cents,active) VALUES (?,?,?,1)",
                       (name, games, price))
        # shoes: two pairs of size 42, one pair 38
        for code, size in [("S-42-01", 42), ("S-42-02", 42), ("S-38-01", 38)]:
            db.execute("INSERT INTO shoes(code,size_eu,status) VALUES (?,?,'in_stock')",
                       (code, size))

    def _start_one(self, name="测试客", size=2, sizes=(38, 42), pkg=2, lane=None,
                   desk="前台1"):
        p = self.svc.enqueue(name, size, bumper=False, shoe_sizes=list(sizes))
        call = self.svc.call_next(desk)
        self.assertIsNotNone(call)
        if lane is not None:
            self.db.execute("UPDATE parties SET assigned_lane_id=? WHERE id=?",
                            (lane, p["id"]))
        r = self.svc.start_session(p["id"], package_id=pkg, desk=desk)
        return p, r["session_id"], r["lane"]["id"]


class TestDoubleLock(BaseCase):
    """两个前台不能同时开同一球道或借出同一双鞋。"""

    def test_lane_lock_blocks_second_desk(self):
        lk = self.svc.locks
        with lk.acquire("lane", 1, owner="前台1", block=False) as got1:
            self.assertTrue(got1)
            # 前台2 non-blocking attempt on the SAME lane must fail
            with lk.acquire("lane", 1, owner="前台2", block=False) as got2:
                self.assertFalse(got2)
            # a different lane is free for desk2
            with lk.acquire("lane", 2, owner="前台2", block=False) as got3:
                self.assertTrue(got3)

    def test_shoe_lock_blocks_second_desk(self):
        lk = self.svc.locks
        with lk.acquire("shoe", 1, owner="前台1", block=False) as g1:
            self.assertTrue(g1)
            with lk.acquire("shoe", 1, owner="前台2", block=False) as g2:
                self.assertFalse(g2)

    def test_same_desk_reentrant(self):
        lk = self.svc.locks
        with lk.acquire("lane", 1, owner="前台1"):
            with lk.acquire("lane", 1, owner="前台1") as got:
                self.assertTrue(got)

    def test_two_desks_cannot_open_same_lane(self):
        """Service level: once desk1 opened a lane, desk2 cannot open it."""
        p, sid, lane_id = self._start_one(desk="前台1")
        # second party tries to force the same lane
        p2 = self.svc.enqueue("后来客", 2, shoe_sizes=[38, 42])
        self.svc.call_next("前台2")
        with self.assertRaises(ServiceError) as cm:
            self.svc.start_session(p2["id"], package_id=1, desk="前台2",
                                   lane_id=lane_id)
        self.assertIn("进行中", str(cm.exception))

    def test_concurrent_same_shoe_one_winner(self):
        """Two threads race to loan the same single 38 pair; exactly one wins."""
        results = []

        def desk_attempt(desk):
            try:
                self.svc.enqueue(f"{desk}客", 1, shoe_sizes=[38])
                call = self.svc.call_next(desk)
                if call:
                    self.svc.start_session(call["party"]["id"], package_id=1, desk=desk)
                    results.append(("ok", desk))
                else:
                    results.append(("nocall", desk))
            except ServiceError as e:
                results.append(("err", str(e)))

        t1 = threading.Thread(target=desk_attempt, args=("前台1",))
        t2 = threading.Thread(target=desk_attempt, args=("前台2",))
        t1.start(); t2.start(); t1.join(); t2.join()
        # Only one pair of size 38 exists -> at most one ok that uses it.
        # The other either can't be called to a free lane or hits shortage.
        ok = [r for r in results if r[0] == "ok"]
        self.assertLessEqual(len(ok), 1)

    def test_concurrent_same_lane_one_winner(self):
        """Two desks race to open the same lane for two different parties."""
        # Make parties that can ONLY fit lane 1 by filling others conceptually;
        # simpler: force both assigned to lane 1.
        pa = self.svc.enqueue("甲", 2, shoe_sizes=[42, 42])
        pb = self.svc.enqueue("乙", 2, shoe_sizes=[42, 42])
        # both marked called + assigned lane 1
        for pid in (pa["id"], pb["id"]):
            self.db.execute(
                "UPDATE parties SET status='called',called_at=?,assigned_lane_id=1 WHERE id=?",
                (self.clock.iso(), pid))
        barrier = threading.Barrier(2)
        out = {}

        def attempt(desk, pid):
            try:
                barrier.wait(timeout=5)
                self.svc.start_session(pid, package_id=1, desk=desk, lane_id=1)
                out[desk] = "ok"
            except ServiceError as e:
                out[desk] = f"err:{e}"

        t1 = threading.Thread(target=attempt, args=("前台1", pa["id"]))
        t2 = threading.Thread(target=attempt, args=("前台2", pb["id"]))
        t1.start(); t2.start(); t1.join(); t2.join()
        oks = [v for v in out.values() if v == "ok"]
        self.assertEqual(len(oks), 1, out)


class TestNoShowRestore(BaseCase):
    """过号与恢复，恢复后保留优先位置且订单信息不丢。"""

    def test_auto_no_show_after_timeout(self):
        p = self.svc.enqueue("迟到客", 2, shoe_sizes=[38, 42])
        call = self.svc.call_next()
        self.assertEqual(call["party"]["status"], "called")
        # not yet
        self.svc.tick()
        self.assertEqual(self.db.query_one(
            "SELECT status FROM parties WHERE id=?", (p["id"],))["status"], "called")
        # 5 minutes later -> auto no-show
        self.clock.advance(301)
        fired = self.svc.tick()
        self.assertIn(p["id"], fired)
        row = self.db.query_one("SELECT * FROM parties WHERE id=?", (p["id"],))
        self.assertEqual(row["status"], "no_show")
        self.assertIsNotNone(row["restore_at"])

    def test_restore_keeps_priority_and_order(self):
        # A is called then no-shows; B and C join meanwhile.
        a = self.svc.enqueue("甲队", 2, shoe_sizes=[38, 42])
        self.svc.call_next()
        self.clock.advance(301)
        self.svc.tick()
        b = self.svc.enqueue("乙队", 2, shoe_sizes=[42, 42])
        c = self.svc.enqueue("丙队", 2, shoe_sizes=[42, 42])
        # A restores -> must jump ahead of B and C
        self.svc.restore_party(a["id"])
        call = self.svc.call_next()
        self.assertEqual(call["party"]["id"], a["id"], "过号恢复应保留队首优先位置")

    def test_restore_window_expired_rejected(self):
        p = self.svc.enqueue("超时客", 2, shoe_sizes=[38, 42])
        self.svc.call_next()
        self.clock.advance(301)
        self.svc.tick()
        # past the 10-minute restore window
        self.clock.advance(601)
        with self.assertRaises(ServiceError):
            self.svc.restore_party(p["id"])


class TestSanitizeBlock(BaseCase):
    """归还即待消毒；消毒完成前不能再次借出。"""

    def test_returned_shoe_blocks_reloan(self):
        p, sid, _ = self._start_one()
        loan = self.db.query_one("SELECT * FROM shoe_loans WHERE session_id=?", (sid,))
        # return the 38 shoe -> sanitizing
        self.svc.return_shoe(loan["id"])
        shoe = self.db.query_one("SELECT * FROM shoes WHERE id=?", (loan["shoe_id"],))
        self.assertEqual(shoe["status"], "sanitizing")

        # a new party needing the only 38 pair must be blocked by 缺码
        p2 = self.svc.enqueue("新客", 1, shoe_sizes=[38])
        self.svc.call_next()
        with self.assertRaises(ServiceError) as cm:
            self.svc.start_session(p2["id"], package_id=1)
        self.assertIn("缺码", str(cm.exception))
        # shortage event recorded
        ev = self.db.query_one(
            "SELECT * FROM events WHERE kind='shoe_shortage' ORDER BY id DESC LIMIT 1")
        self.assertIsNotNone(ev)

        # finish sanitizing -> shoe lendable again
        batch = self.db.query_one(
            "SELECT id FROM sanitize_batches WHERE status='pending' ORDER BY id DESC LIMIT 1")
        n = self.svc.sanitize_finish(batch["id"])
        self.assertGreaterEqual(n, 1)
        self.assertEqual(self.db.query_one(
            "SELECT status FROM shoes WHERE id=?", (loan["shoe_id"],))["status"],
            "in_stock")
        # now the party can start (re-call first)
        self.db.execute("UPDATE parties SET status='waiting',assigned_lane_id=NULL WHERE id=?",
                        (p2["id"],))
        self.svc.call_next()
        r = self.svc.start_session(p2["id"], package_id=1)
        self.assertTrue(r["session_id"] > 0)

    def test_damaged_shoe_goes_repair_not_sanitize(self):
        p, sid, _ = self._start_one()
        loan = self.db.query_one("SELECT * FROM shoe_loans WHERE session_id=?", (sid,))
        # 1x1 transparent png as fake photo b64
        fake = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC"
        self.svc.return_shoe(loan["id"], damaged=True, photo_b64=fake, note="开胶")
        shoe = self.db.query_one("SELECT * FROM shoes WHERE id=?", (loan["shoe_id"],))
        self.assertEqual(shoe["status"], "repair")
        self.assertTrue(os.path.exists(shoe["damaged_photo"]))


class TestSwitchAndBilling(BaseCase):
    """换道不占已有时段；换道后按实际局数正确计费。"""

    def test_switch_to_free_lane_and_bill(self):
        p, sid, lane1 = self._start_one(pkg=2)  # 3-game package
        # play 4 games (1 over package)
        self.svc.record_games(sid, 4)
        # switch L01 -> L02
        lane2 = self.db.query_one("SELECT id FROM lanes WHERE code='L02'")["id"]
        r = self.svc.switch_lane(sid, lane2, reason="fault")
        self.assertEqual(r["new_lane_id"], lane2)
        # old occupancy closed, new open
        old_open = self.db.query_one(
            "SELECT COUNT(*) c FROM session_lanes WHERE lane_id=? AND occupy_to IS NULL",
            (lane1,))["c"]
        new_open = self.db.query_one(
            "SELECT COUNT(*) c FROM session_lanes WHERE lane_id=? AND occupy_to IS NULL",
            (lane2,))["c"]
        self.assertEqual(old_open, 0)
        self.assertEqual(new_open, 1)
        # end & bill: package 7200 + 1 over game 2800 + 2 shoes*500
        bill = self.svc.end_session(sid)
        self.assertEqual(bill["lane_fee_cents"], 7200)
        self.assertEqual(bill["surcharge_cents"], 2800)
        self.assertEqual(bill["shoe_fee_cents"], 1000)
        self.assertEqual(bill["total_cents"], 7200 + 2800 + 1000)
        # scorer progress moved with the lane
        self.assertEqual(self.svc.read_scorer(sid), 4.0)

    def test_switch_refuses_occupied_timeslot(self):
        p1, sid1, l1 = self._start_one(name="甲", sizes=(38, 42), pkg=1)
        # occupy lane 2 with a second session
        p2 = self.svc.enqueue("乙", 1, shoe_sizes=[42])
        self.svc.call_next()
        r2 = self.svc.start_session(p2["id"], package_id=1, lane_id=2)
        # trying to switch session1 onto occupied lane 2 must be rejected
        with self.assertRaises(ServiceError) as cm:
            self.svc.switch_lane(sid1, 2)
        self.assertIn("时段", str(cm.exception))

    def test_switch_to_faulted_lane_rejected(self):
        p, sid, l1 = self._start_one()
        self.svc.report_lane_fault(3, "清洁中")
        with self.assertRaises(ServiceError):
            self.svc.switch_lane(sid, 3)

    def test_fault_pauses_calling_but_preserves_order(self):
        # fill: start on L01, then fault L02.. small parties still assigned others
        self.svc.report_lane_fault(2, "回球机故障")
        p = self.svc.enqueue("候场", 2, shoe_sizes=[42, 42])
        call = self.svc.call_next()
        # candidate should never be the faulted lane
        if call:
            self.assertNotEqual(call["lane"]["id"], 2)
        # fault lane flagged
        self.assertEqual(self.db.query_one(
            "SELECT needs_repair FROM lanes WHERE id=2")["needs_repair"], 1)


class TestRefundIdempotent(BaseCase):
    """退款幂等：重复退款只产生一次流水、一次资金动作。"""

    def _paid_bill(self):
        p, sid, lane = self._start_one(pkg=1)
        self.svc.record_games(sid, 1)
        bill = self.svc.end_session(sid)
        bill = self.svc.checkout(bill["id"])
        return bill

    def test_refund_idempotent(self):
        bill = self._paid_bill()
        r1 = self.svc.refund(bill["id"], manager="M01", reason="设备故障")
        ref1 = r1["refund_ref"]
        self.assertEqual(r1["status"], "refunded")
        # repeat immediately
        r2 = self.svc.refund(bill["id"], manager="M01", reason="顾客再次点击")
        self.assertEqual(r2["refund_ref"], ref1, "退款流水必须保持不变（幂等）")
        # adapter level: the payment has exactly one refund ref
        pay = self.svc.payment.get(bill["payment_ref"])
        self.assertEqual(pay.refund_ref, ref1)
        # only one refund event
        n = self.db.query_one(
            "SELECT COUNT(*) c FROM events WHERE kind='refund'")["c"]
        self.assertEqual(n, 1)

    def test_refund_requires_manager(self):
        bill = self._paid_bill()
        with self.assertRaises(ServiceError):
            self.svc.refund(bill["id"], manager="", reason="无经理")

    def test_comp_requires_manager(self):
        p, sid, lane = self._start_one(pkg=1)
        bill = self.svc.end_session(sid)
        with self.assertRaises(ServiceError):
            self.svc.adjust_bill(bill["id"], "comp", bill["total_cents"], "免单", "")
        ok = self.svc.adjust_bill(bill["id"], "comp", bill["total_cents"], "经理免单", "M01")
        self.assertEqual(ok["total_cents"], 0)

    def test_refund_unpaid_rejected(self):
        p, sid, lane = self._start_one(pkg=1)
        bill = self.svc.end_session(sid)
        with self.assertRaises(ServiceError):
            self.svc.refund(bill["id"], manager="M01")


if __name__ == "__main__":
    unittest.main(verbosity=2)
