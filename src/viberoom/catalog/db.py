"""SQLite index over the library. Disposable — sidecars are the source of
truth; the DB only exists for fast list/filter and can be rebuilt by a scan."""

from __future__ import annotations

import sqlite3
import threading
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
    "ALTER TABLE images ADD COLUMN dhash TEXT",
    "CREATE INDEX IF NOT EXISTS idx_images_stack ON images(stack_id)",
]


class CatalogDB:
    def __init__(self, path: Path):
        self._conn = sqlite3.connect(path, check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._conn.executescript(_SCHEMA)
        for stmt in _MIGRATIONS:
            try:
                self._conn.execute(stmt)
            except sqlite3.OperationalError:
                pass  # column already exists
        self._conn.commit()
        self._lock = threading.Lock()

    def execute(self, sql: str, params: tuple = ()) -> sqlite3.Cursor:
        with self._lock:
            cur = self._conn.execute(sql, params)
            self._conn.commit()
            return cur

    def query(self, sql: str, params: tuple = ()) -> list[sqlite3.Row]:
        with self._lock:
            return self._conn.execute(sql, params).fetchall()

    def close(self) -> None:
        self._conn.close()
