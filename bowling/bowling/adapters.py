"""Mock adapters for external hardware/payment systems.

- ScorerAdapter: talks to the lane scorer (计分器). Can report an outage and
  returns frame/game progress.
- PaymentAdapter: returns payment status; refund is idempotent on payment_ref.
"""
from __future__ import annotations

import threading
import uuid
from dataclasses import dataclass, field


class ScorerError(RuntimeError):
    pass


class ScorerAdapter:
    """In-memory mock of lane scoring consoles."""

    def __init__(self):
        self._lock = threading.Lock()
        # lane_code -> {"games": float, "online": bool}
        self._state: dict[str, dict] = {}
        # lanes currently in outage
        self._outage: set[str] = set()

    def register(self, lane_code: str, planned_games: int) -> None:
        with self._lock:
            self._state[lane_code] = {"games": 0.0, "online": True, "planned": planned_games}

    def move(self, old_code: str, new_code: str) -> None:
        with self._lock:
            if old_code in self._state:
                self._state[new_code] = self._state.pop(old_code)
                self._state[new_code]["online"] = new_code not in self._outage

    def push_score(self, lane_code: str, games: float) -> None:
        with self._lock:
            if lane_code in self._outage:
                raise ScorerError(f"scorer outage on lane {lane_code}")
            st = self._state.setdefault(lane_code, {"games": 0.0, "online": True, "planned": 0})
            st["games"] = games

    def read_games(self, lane_code: str) -> float:
        with self._lock:
            if lane_code in self._outage:
                raise ScorerError(f"scorer outage on lane {lane_code}")
            return float(self._state.get(lane_code, {}).get("games", 0.0))

    # -- outage simulation (计分器中断) --
    def break_outage(self, lane_code: str) -> None:
        with self._lock:
            self._outage.add(lane_code)
            if lane_code in self._state:
                self._state[lane_code]["online"] = False

    def fix_outage(self, lane_code: str, recovered_games: float) -> None:
        with self._lock:
            self._outage.discard(lane_code)
            if lane_code in self._state:
                self._state[lane_code]["online"] = True
                self._state[lane_code]["games"] = recovered_games

    def is_outage(self, lane_code: str) -> bool:
        with self._lock:
            return lane_code in self._outage


@dataclass
class Payment:
    ref: str
    amount_cents: int
    status: str                  # paid / failed
    refund_ref: str | None = None
    refund_status: str | None = None  # refunded


class PaymentAdapter:
    """Mock payment gateway. Charges and refunds are persisted in memory and
    refund is idempotent: refunding the same payment_ref twice yields the same
    refund_ref and does not move money twice."""

    def __init__(self):
        self._lock = threading.RLock()
        self._payments: dict[str, Payment] = {}

    def charge(self, amount_cents: int, *, tag: str = "") -> Payment:
        with self._lock:
            ref = "PAY-" + uuid.uuid4().hex[:10].upper()
            # Demo gateway: negative or zero amount is not chargeable.
            status = "paid" if amount_cents > 0 else "failed"
            p = Payment(ref=ref, amount_cents=amount_cents, status=status)
            self._payments[ref] = p
            return p

    def get(self, ref: str) -> Payment | None:
        with self._lock:
            return self._payments.get(ref)

    def refund(self, ref: str) -> Payment:
        """Idempotent refund. Returns the (possibly already) refunded payment."""
        with self._lock:
            p = self._payments.get(ref)
            if p is None:
                raise KeyError(f"unknown payment {ref}")
            if p.refund_ref is None:
                p.refund_ref = "RFN-" + uuid.uuid4().hex[:10].upper()
                p.refund_status = "refunded"
            return p
