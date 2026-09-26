"""Local HTTP server + JSON API for the bowling alley system.

Run:  python app.py
Then open http://localhost:8000
"""
from __future__ import annotations

import json
import os
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse
from collections import defaultdict

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from bowling import Database, Service, Clock, Scheduler
from bowling import seed as seed_mod
from bowling.service import ServiceError

BASE = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.join(BASE, "web")
DATA = os.path.join(BASE, "data")
DB_PATH = os.path.join(DATA, "bowling.db")
PHOTO_DIR = os.path.join(DATA, "photos")

clock = Clock()
db = Database(DB_PATH)
svc = Service(db, clock=clock, photo_dir=PHOTO_DIR)
seed_mod.seed(svc)
scheduler = Scheduler(svc, interval_seconds=10)


# ---------------------------------------------------------------- state view
def full_state():
    # lanes with current occupancy
    lanes = []
    for l in db.query("SELECT * FROM lanes ORDER BY row_no,pos_x"):
        d = dict(l)
        sid = svc._active_session_on_lane(l["id"])
        d["active_session_id"] = sid
        if sid:
            s = db.query_one("SELECT * FROM sessions WHERE id=?", (sid,))
            p = db.query_one("SELECT group_no,customer_name,size,bumper FROM parties WHERE id=?",
                             (s["party_id"],))
            d["party"] = dict(p) if p else None
        else:
            d["party"] = None
        lanes.append(d)

    parties = []
    for p in db.query(
            "SELECT * FROM parties WHERE status IN ('waiting','called','no_show') "
            "ORDER BY CASE status WHEN 'called' THEN 0 WHEN 'waiting' THEN 1 ELSE 2 END,"
            "enqueued_at,id"):
        d = dict(p)
        d["shoe_sizes"] = json.loads(d["shoe_sizes"])
        parties.append(d)

    sessions = []
    for s in db.query(
            "SELECT s.*,pa.group_no,pa.customer_name,l.code lane_code "
            "FROM sessions s JOIN parties pa ON pa.id=s.party_id "
            "JOIN lanes l ON l.id=s.lane_id WHERE s.status='playing' ORDER BY s.id"):
        d = dict(s)
        loans = db.query(
            "SELECT sl.id,sh.code,sh.size_eu,sl.status FROM shoe_loans sl "
            "JOIN shoes sh ON sh.id=sl.shoe_id WHERE sl.session_id=?", (s["id"],))
        d["loans"] = [dict(x) for x in loans]
        import datetime as _dt
        if s["id"] in svc.session_seconds:
            d["elapsed"] = int(svc.session_seconds[s["id"]])
        else:
            d["elapsed"] = int((clock.now() - _dt.datetime.fromisoformat(
                s["started_at"])).total_seconds())
        sessions.append(d)

    # shoe size matrix
    matrix = defaultdict(lambda: {"total": 0, "in_stock": 0, "on_loan": 0,
                                  "sanitizing": 0, "repair": 0, "items": []})
    for sh in db.query("SELECT * FROM shoes ORDER BY size_eu,code"):
        m = matrix[sh["size_eu"]]
        m["total"] += 1
        key = {"on_loan": "on_loan", "sanitizing": "sanitizing",
               "repair": "repair"}.get(sh["status"], "in_stock")
        m[key] += 1
        m["items"].append({"id": sh["id"], "code": sh["code"],
                           "status": sh["status"]})
    shoe_matrix = [{"size": k, **v} for k, v in sorted(matrix.items())]

    batches = []
    for b in db.query("SELECT * FROM sanitize_batches ORDER BY id DESC LIMIT 10"):
        d = dict(b)
        d["items"] = [dict(x) for x in db.query(
            "SELECT sl.id,sh.code,sh.size_eu,sl.status FROM shoe_loans sl "
            "JOIN shoes sh ON sh.id=sl.shoe_id WHERE sl.sanitize_batch_id=? "
            "ORDER BY sh.size_eu", (b["id"],))]
        batches.append(d)

    bills = [dict(x) for x in db.query(
        "SELECT b.*,pa.group_no,pa.customer_name,l.code lane_code FROM bills b "
        "JOIN parties pa ON pa.id=b.party_id "
        "JOIN sessions s ON s.id=b.session_id JOIN lanes l ON l.id=s.lane_id "
        "ORDER BY b.id DESC LIMIT 20")]
    for bill in bills:
        bill["adjustments"] = [dict(a) for a in db.query(
            "SELECT * FROM adjustments WHERE bill_id=? ORDER BY id", (bill["id"],))]

    packages = [dict(x) for x in db.query("SELECT * FROM packages WHERE active=1")]
    balls = [dict(x) for x in db.query("SELECT * FROM balls ORDER BY weight_lb")]

    events = [dict(x) for x in db.query(
        "SELECT * FROM events ORDER BY id DESC LIMIT 30")]

    open_faults = [dict(x) for x in db.query(
        "SELECT f.*,l.code lane_code FROM faults f LEFT JOIN lanes l ON l.id=f.lane_id "
        "WHERE f.resolved_at IS NULL ORDER BY f.id DESC")]

    return {
        "now": clock.iso(),
        "lanes": lanes,
        "parties": parties,
        "sessions": sessions,
        "shoe_matrix": shoe_matrix,
        "batches": batches,
        "bills": bills,
        "packages": packages,
        "balls": balls,
        "events": events,
        "open_faults": open_faults,
        "locked": svc.locks.held_resources(),
    }


# ---------------------------------------------------------------- HTTP handler
class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False, default=str).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _err(self, msg, code=400):
        self._send({"error": str(msg)}, code)

    def _body(self):
        n = int(self.headers.get("Content-Length", 0))
        if not n:
            return {}
        return json.loads(self.rfile.read(n).decode())

    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/api/state":
            return self._send(full_state())
        if path == "/" or path == "/index.html":
            return self._static("index.html", "text/html; charset=utf-8")
        static_map = {"/app.js": ("app.js", "application/javascript; charset=utf-8"),
                      "/styles.css": ("styles.css", "text/css; charset=utf-8")}
        if path in static_map:
            return self._static(*static_map[path])
        return self._err("not found", 404)

    def _static(self, name, ctype):
        fp = os.path.join(WEB, name)
        if not os.path.exists(fp):
            return self._err("not found", 404)
        with open(fp, "rb") as f:
            body = f.read()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        path = urlparse(self.path).path.rstrip("/")
        body = self._body()
        desk = body.get("desk", "前台1")
        try:
            res = self._route(path, body, desk)
            self._send({"ok": True, "data": res, "state": full_state()})
        except ServiceError as e:
            self._err(e, 409)
        except Exception as e:  # noqa
            import traceback; traceback.print_exc()
            self._err(f"服务器错误: {e}", 500)

    def _route(self, path, b, desk):
        s = svc
        # queue
        if path == "/api/enqueue":
            return dict(s.enqueue(b["customer_name"], int(b["size"]),
                                  bool(b.get("bumper")), b.get("shoe_sizes"),
                                  b.get("phone", ""), b.get("note", "")))
        if path == "/api/call":
            r = s.call_next(desk)
            return r or {"message": "暂无可叫号组（无匹配空闲球道）"}
        if m := self._match(path, "/api/parties/{}/noshow"):
            return dict(s.mark_no_show(int(m[0])))
        if m := self._match(path, "/api/parties/{}/restore"):
            return dict(s.restore_party(int(m[0])))
        if m := self._match(path, "/api/parties/{}/add"):
            return dict(s.add_person(int(m[0]), int(b["add"]), b.get("shoe_sizes")))
        # sessions
        if path == "/api/sessions/start":
            return s.start_session(int(b["party_id"]), b.get("package_id"), desk,
                                   b.get("lane_id"))
        if m := self._match(path, "/api/sessions/{}/games"):
            return s.record_games(int(m[0]), float(b["games"]))
        if m := self._match(path, "/api/sessions/{}/outage"):
            s.scorer_outage(int(m[0])); return {"outage": True}
        if m := self._match(path, "/api/sessions/{}/recover"):
            return s.scorer_recover(int(m[0]), float(b["games"]))
        if m := self._match(path, "/api/sessions/{}/ball-stuck"):
            return s.ball_stuck(int(m[0]), b.get("ball_id"), b.get("note", ""))
        if m := self._match(path, "/api/sessions/{}/switch"):
            return s.switch_lane(int(m[0]), int(b["lane_id"]), desk,
                                 b.get("reason", "fault"))
        if m := self._match(path, "/api/sessions/{}/end"):
            return s.end_session(int(m[0]))
        # faults / lanes
        if m := self._match(path, "/api/lanes/{}/fault"):
            return dict(s.report_lane_fault(int(m[0]), b["reason"], desk))
        if m := self._match(path, "/api/lanes/{}/repair"):
            return dict(s.repair_done(int(m[0])))
        if m := self._match(path, "/api/faults/{}/free"):
            return s.ball_freed(int(m[0]))
        # shoes
        if m := self._match(path, "/api/loans/{}/return"):
            return {"shoe_id": s.return_shoe(int(m[0]), bool(b.get("damaged")),
                                             b.get("photo"), b.get("note", ""))}
        if m := self._match(path, "/api/batches/{}/finish"):
            return {"count": s.sanitize_finish(int(m[0]), b.get("operator", "值班员"))}
        # billing
        if m := self._match(path, "/api/bills/{}/adjust"):
            return s.adjust_bill(int(m[0]), b["kind"], int(b["amount"]),
                                 b.get("reason", ""), b.get("manager", ""))
        if m := self._match(path, "/api/bills/{}/pay"):
            return s.checkout(int(m[0]), desk)
        if m := self._match(path, "/api/bills/{}/refund"):
            return s.refund(int(m[0]), b.get("manager", ""), b.get("reason", ""))
        if path == "/api/tick":
            return {"no_show": s.tick()}
        if path.startswith("/api/demo/"):
            from bowling import scenarios
            name = path.rsplit("/", 1)[-1]
            fn = getattr(scenarios, name, None)
            if not fn:
                raise ServiceError("未知样例")
            return fn(s)
        raise ServiceError(f"未知接口 {path}")

    @staticmethod
    def _match(path, tmpl):
        parts = path.strip("/").split("/")
        tp = tmpl.strip("/").split("/")
        if len(parts) != len(tp):
            return None
        out = []
        for a, t in zip(parts, tp):
            if t == "{}":
                if not a.isdigit():
                    return None
                out.append(a)
            elif a != t:
                return None
        return out


def main():
    os.makedirs(PHOTO_DIR, exist_ok=True)
    scheduler.start()
    port = int(os.environ.get("PORT", "8000"))
    httpd = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    print(f"保龄球馆系统已启动: http://localhost:{port}")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        scheduler.stop()


if __name__ == "__main__":
    main()
