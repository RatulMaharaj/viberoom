"""SQLite index over the library. Disposable — sidecars are the source of
truth; the DB only exists for fast list/filter and can be rebuilt by a scan."""

from __future__ import annotations

import sqlite3
import threading
from contextlib import contextmanager
from pathlib import Path

_SCHEMA = """
CREATE TABLE IF NOT EXISTS images (
    id TEXT PRIMARY KEY,           -- stable hash of relative path
    rel_path TEXT NOT NULL UNIQUE,
    filename TEXT NOT NULL,
    ext TEXT NOT NULL,
    is_raw INTEGER NOT NULL,
    filesize INTEGER NOT NULL,
    mtime REAL NOT NULL,
    width INTEGER,
    height INTEGER,
    exif_json TEXT DEFAULT '{}',
    rating INTEGER NOT NULL DEFAULT 0,
    flag TEXT,
    has_edits INTEGER NOT NULL DEFAULT 0,
    sidecar_mtime REAL
);
CREATE INDEX IF NOT EXISTS idx_images_rating ON images(rating);
CREATE INDEX IF NOT EXISTS idx_images_flag ON images(flag);
"""

# columns added after v1; applied idempotently so old catalog.db files upgrade
# in place (the DB is disposable anyway — a full rescan rebuilds everything)
_MIGRATIONS = [
    "ALTER TABLE images ADD COLUMN label TEXT",
    "ALTER TABLE images ADD COLUMN keywords_json TEXT NOT NULL DEFAULT '[]'",
    "ALTER TABLE images ADD COLUMN camera TEXT",
    "ALTER TABLE images ADD COLUMN lens TEXT",
    "ALTER TABLE images ADD COLUMN iso INTEGER",
    "ALTER TABLE images ADD COLUMN focal_length REAL",
    "ALTER TABLE images ADD COLUMN taken_at TEXT",
    "CREATE INDEX IF NOT EXISTS idx_images_label ON images(label)",
    "CREATE INDEX IF NOT EXISTS idx_images_taken_at ON images(taken_at)",
    "ALTER TABLE images ADD COLUMN stack_id TEXT",
    "ALTER TABLE images ADD COLUMN gps_lat REAL",
    "ALTER TABLE images ADD COLUMN gps_lon REAL",
    "ALTER TABLE images ADD COLUMN faces_json TEXT",
    "ALTER TABLE images ADD COLUMN dhash TEXT",
    # aperture/shutter are denormalized purely so the grid caption can be built
    # without shipping every row's full EXIF blob
    "ALTER TABLE images ADD COLUMN aperture REAL",
    "ALTER TABLE images ADD COLUMN shutter REAL",
    "CREATE INDEX IF NOT EXISTS idx_images_stack ON images(stack_id)",
    # These four can never seek — the filters are LIKE '%x%' and a json_each
    # scan. They pay off as *covering* indexes: without them SQLite reads every
    # row, and rows are fat because exif_json lives inline (a 50k-image catalog
    # is ~260 MB). Scanning a narrow index instead took the keyword filter from
    # 43 ms to 2 ms and camera/lens from 42 ms to 2 ms.
    "CREATE INDEX IF NOT EXISTS idx_images_camera ON images(camera)",
    "CREATE INDEX IF NOT EXISTS idx_images_lens ON images(lens)",
    "CREATE INDEX IF NOT EXISTS idx_images_filename ON images(filename)",
    "CREATE INDEX IF NOT EXISTS idx_images_keywords ON images(keywords_json)",
]


class CatalogDB:
    """One sqlite connection per thread.

    Every API handler is a plain `def`, so FastAPI runs them on its worker
    threadpool; a single shared connection behind a global lock serialized the
    whole API. WAL lets those threads read concurrently alongside one writer,
    so each thread gets its own connection and there is no lock at all.
    """

    def __init__(self, path: Path):
        self._path = path
        self._local = threading.local()
        self._conns: list[sqlite3.Connection] = []
        self._conns_lock = threading.Lock()
        conn = self._conn()
        conn.executescript(_SCHEMA)
        for stmt in _MIGRATIONS:
            try:
                conn.execute(stmt)
            except sqlite3.OperationalError:
                pass  # column already exists
        conn.commit()

    def _conn(self) -> sqlite3.Connection:
        conn = getattr(self._local, "conn", None)
        if conn is None:
            # check_same_thread stays off so close() can run from any thread
            conn = sqlite3.connect(self._path, check_same_thread=False)
            conn.row_factory = sqlite3.Row
            # WAL: concurrent readers + one writer, and the -wal/-shm files land
            # next to the DB. synchronous=NORMAL drops the per-commit fsync; a
            # crash can lose the last transactions, which is fine for a catalog
            # that sidecars can rebuild.
            conn.execute("PRAGMA journal_mode=WAL")
            conn.execute("PRAGMA synchronous=NORMAL")
            # a writer briefly blocks other writers; wait rather than raise
            conn.execute("PRAGMA busy_timeout=5000")
            self._local.conn = conn
            with self._conns_lock:
                self._conns.append(conn)
        return conn

    def execute(self, sql: str, params: tuple = ()) -> sqlite3.Cursor:
        """Run one statement. Autocommits unless inside transaction() — the
        returned cursor is only valid on the calling thread (rowcount etc.)."""
        conn = self._conn()
        cur = conn.execute(sql, params)
        if not getattr(self._local, "in_txn", False):
            conn.commit()
        return cur

    def query(self, sql: str, params: tuple = ()) -> list[sqlite3.Row]:
        return self._conn().execute(sql, params).fetchall()

    @contextmanager
    def transaction(self):
        """Batch many writes into one commit — the difference between one fsync
        per statement and one per batch on scans and bulk edits."""
        conn = self._conn()
        if getattr(self._local, "in_txn", False):
            yield self  # nested: the outermost block owns the commit
            return
        self._local.in_txn = True
        try:
            yield self
        except BaseException:
            conn.rollback()
            raise
        finally:
            self._local.in_txn = False
        conn.commit()

    def close(self) -> None:
        with self._conns_lock:
            conns, self._conns = self._conns, []
        for conn in conns:
            conn.close()
        self._local = threading.local()
