"""In-process background scheduler: periodically computes no-show expiry and
session durations (via Service.tick)."""
from __future__ import annotations

import threading


class Scheduler:
    def __init__(self, svc, interval_seconds: float = 20.0):
        self.svc = svc
        self.interval = interval_seconds
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def start(self):
        if self._thread and self._thread.is_alive():
            return
        self._thread = threading.Thread(target=self._run, name="scheduler", daemon=True)
        self._thread.start()

    def _run(self):
        while not self._stop.wait(self.interval):
            try:
                self.svc.tick()
            except Exception:  # never let the tick kill the thread
                pass

    def stop(self):
        self._stop.set()
