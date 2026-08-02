"""Process-wide app state: the currently open library and its DB handle."""

from __future__ import annotations

from fastapi import HTTPException

from viberoom.catalog.db import CatalogDB
from viberoom.config import Library

_library: Library | None = None
_db: CatalogDB | None = None


def open_library(lib: Library) -> None:
    global _library, _db
    if _db is not None:
        _db.close()
    _library = lib
    _db = CatalogDB(lib.db_path)


def library_or_none() -> Library | None:
    return _library


def require_library() -> Library:
    if _library is None:
        raise HTTPException(409, "No library open. POST /api/v1/library with {\"path\": ...} first.")
    return _library


def db() -> CatalogDB:
    if _db is None:
        raise HTTPException(409, "No library open.")
    return _db
