"""Process clock and resource locks.

Two front desks must never open the same lane or loan the same pair of shoes
concurrently. Locks are in-process (threading) keyed by resource id, and every
state-changing service action additionally takes a global service lock so the
check-then-act sequences are atomic. The SQLite layer adds a write lock as
defense in depth.
"""
from __future__ import annotations

import threading
from contextlib import contextmanager
from datetime import datetime, timedelta
from typing import Iterator


class Clock:
    """Monotonic-ish wall clock; can be frozen/advanced in tests."""

    def __init__(self, start: datetime | None = None):
        self._lock = threading.Lock()
        self._frozen: datetime | None = start
        self._real_base = datetime.now()
        self._fake_base = start

    def now(self) -> datetime:
        with self._lock:
            if self._frozen is not None:
                return self._frozen
            return datetime.now()

    def freeze(self, dt: datetime) -> None:
        with self._lock:
            self._frozen = dt

    def advance(self, seconds: float) -> None:
        with self._lock:
            if self._frozen is None:
                self._frozen = datetime.now()
            self._frozen += timedelta(seconds=seconds)

    def iso(self) -> str:
        return self.now().replace(microsecond=0).isoformat()


class _OwnedLock:
    """Reentrant lock keyed by an *owner tag* (e.g. 前台1/前台2), not by thread.

    The same owner can re-enter; a genuinely different owner blocks/is rejected
    even when it happens to run on the same thread. This lets us model two front
    desks contending for one lane or one pair of shoes.
    """

    def __init__(self):
        self._cond = threading.Condition(threading.Lock())
        self._owner = None
        self._count = 0

    def try_acquire(self, owner: str, blocking: bool) -> bool:
        with self._cond:
            if self._owner is None or self._owner == owner:
                self._owner = owner
                self._count += 1
                return True
            if not blocking:
                return False
            while self._owner is not None and self._owner != owner:
                self._cond.wait()
            self._owner = owner
            self._count += 1
            return True

    def release(self, owner: str) -> None:
        with self._cond:
            if self._owner != owner:
                raise RuntimeError(f"lock not held by owner {owner}")
            self._count -= 1
            if self._count == 0:
                self._owner = None
                self._cond.notify_all()


class ResourceLocks:
    """Per-resource reentrant locks (lanes, shoes)."""

    def __init__(self):
        self._guard = threading.Lock()
        self._locks: dict[str, _OwnedLock] = {}
        # Holds owner tokens to surface double-lock attempts / held state.
        self._held: set[str] = set()
        self._held_guard = threading.Lock()

    def _key(self, kind: str, rid) -> str:
        return f"{kind}:{rid}"

    def get(self, kind: str, rid) -> _OwnedLock:
        key = self._key(kind, rid)
        with self._guard:
            lk = self._locks.get(key)
            if lk is None:
                lk = _OwnedLock()
                self._locks[key] = lk
            return lk

    @contextmanager
    def acquire(self, kind: str, rid, owner: str = "desk", *, block: bool = True) -> Iterator[bool]:
        """Acquire a resource lock. Yields True if acquired.

        A *genuine* second owner (different tag) is a conflict: with block=False
        the context yields False immediately; with block=True it waits.
        """
        key = self._key(kind, rid)
        token = f"{key}@{owner}"
        with self._held_guard:
            reentrant = token in self._held
        lk = self.get(kind, rid)
        acquired = lk.try_acquire(owner, blocking=block)
        if acquired and not reentrant:
            with self._held_guard:
                self._held.add(token)
        try:
            yield acquired
        finally:
            if acquired:
                lk.release(owner)
                if not reentrant:
                    with self._held_guard:
                        self._held.discard(token)

    def is_locked(self, kind: str, rid, owner: str | None = None) -> bool:
        key = self._key(kind, rid)
        with self._held_guard:
            if owner is not None:
                return f"{key}@{owner}" in self._held
            return any(t.startswith(key + "@") for t in self._held)

    def held_resources(self) -> list[str]:
        with self._held_guard:
            return sorted(self._held)
