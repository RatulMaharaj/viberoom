"""Folder scanner: discovers images, reads EXIF, syncs sidecars into the DB."""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path

from PIL import ExifTags, Image

from viberoom.catalog.db import CatalogDB
from viberoom.config import IMAGE_EXTENSIONS, Library, is_raw
from viberoom.recipe.schema import Recipe
from viberoom.recipe.sidecar import SIDECAR_SUFFIX, load_sidecar, sidecar_path

_EXIF_KEEP = {
    "Make", "Model", "LensModel", "DateTimeOriginal", "ExposureTime",
    "FNumber", "ISOSpeedRatings", "PhotographicSensitivity", "FocalLength",
}


def image_id(rel_path: str) -> str:
    return hashlib.sha1(rel_path.encode()).hexdigest()[:16]


def _read_exif(path: Path) -> tuple[int | None, int | None, dict]:
    """Best-effort dimensions + basic EXIF via Pillow (works for RAW headers
    on some formats; failures are fine — EXIF is cosmetic metadata here)."""
    try:
        with Image.open(path) as im:
            exif = im.getexif()
            tags = {}
            for tag_id, value in exif.items():
                name = ExifTags.TAGS.get(tag_id)
                if name in _EXIF_KEEP:
                    tags[name] = str(value)
            return im.width, im.height, tags
    except Exception:
        return None, None, {}


def scan(library: Library, db: CatalogDB) -> dict:
    """Walk the library, upsert changed files, sync sidecars, prune deleted."""
    seen: set[str] = set()
    added = updated = 0

    for dirpath, dirnames, filenames in os.walk(library.root):
        dirnames[:] = [d for d in dirnames if not d.startswith(".") and d != "exports"]
        for name in filenames:
            p = Path(dirpath) / name
            if p.suffix.lower() not in IMAGE_EXTENSIONS or name.endswith(SIDECAR_SUFFIX):
                continue
            rel = str(p.relative_to(library.root))
            seen.add(rel)
            iid = image_id(rel)
            stat = p.stat()
            sc_path = sidecar_path(p)
            sc_mtime = sc_path.stat().st_mtime if sc_path.exists() else None

            row = db.query("SELECT mtime, sidecar_mtime FROM images WHERE id=?", (iid,))
            if row and row[0]["mtime"] == stat.st_mtime and row[0]["sidecar_mtime"] == sc_mtime:
                continue

            sc = load_sidecar(p)
            width, height, exif = _read_exif(p)
            db.execute(
                """INSERT INTO images (id, rel_path, filename, ext, is_raw, filesize,
                       mtime, width, height, exif_json, rating, flag, has_edits, sidecar_mtime)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                   ON CONFLICT(id) DO UPDATE SET filesize=excluded.filesize,
                       mtime=excluded.mtime, width=excluded.width, height=excluded.height,
                       exif_json=excluded.exif_json, rating=excluded.rating,
                       flag=excluded.flag, has_edits=excluded.has_edits,
                       sidecar_mtime=excluded.sidecar_mtime""",
                (
                    iid, rel, name, p.suffix.lower(), int(is_raw(p)), stat.st_size,
                    stat.st_mtime, width, height, json.dumps(exif), sc.rating, sc.flag,
                    int(sc.recipe != Recipe()), sc_mtime,
                ),
            )
            if row:
                updated += 1
            else:
                added += 1

    all_rels = {r["rel_path"] for r in db.query("SELECT rel_path FROM images")}
    removed = all_rels - seen
    for rel in removed:
        db.execute("DELETE FROM images WHERE rel_path=?", (rel,))

    return {"total": len(seen), "added": added, "updated": updated, "removed": len(removed)}
