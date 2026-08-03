"""Folder scanner: discovers images, reads EXIF, syncs sidecars into the DB."""

from __future__ import annotations

import hashlib
import json
import os
import re
from pathlib import Path

from viberoom.catalog.db import CatalogDB
from viberoom.catalog.metadata import read_metadata
from viberoom.config import IMAGE_EXTENSIONS, Library, is_raw
from viberoom.recipe.schema import Recipe
from viberoom.recipe.sidecar import SIDECAR_SUFFIX, load_sidecar, sidecar_path

def image_id(rel_path: str) -> str:
    return hashlib.sha1(rel_path.encode()).hexdigest()[:16]


def _num(v: str | None) -> float | None:
    if v is None:
        return None
    try:
        return float(str(v).split("/")[0]) if "/" in str(v) else float(v)
    except ValueError:
        return None


def _parse_gps(exif: dict) -> tuple[float | None, float | None]:
    """GPS decimal degrees from either exiftool numeric values or
    exifread-style '[d, m, s]' rational strings with N/S/E/W refs."""

    def one(value, ref) -> float | None:
        if value is None:
            return None
        try:
            deg = float(value)
        except (TypeError, ValueError):
            parts = re.findall(r"[\d/.]+", str(value))
            if not parts:
                return None
            def frac(s: str) -> float:
                if "/" in s:
                    a, b = s.split("/")
                    return float(a) / (float(b) or 1)
                return float(s)
            try:
                nums = [frac(p) for p in parts[:3]]
            except (ValueError, ZeroDivisionError):
                return None
            deg = nums[0] + (nums[1] if len(nums) > 1 else 0) / 60 + (
                nums[2] if len(nums) > 2 else 0
            ) / 3600
        if ref and str(ref).strip().upper()[:1] in ("S", "W"):
            deg = -deg
        return deg

    lat = one(exif.get("GPSLatitude"), exif.get("GPSLatitudeRef"))
    lon = one(exif.get("GPSLongitude"), exif.get("GPSLongitudeRef"))
    if lat is not None and abs(lat) <= 90 and lon is not None and abs(lon) <= 180:
        return lat, lon
    return None, None


def summarize_exif(exif: dict) -> dict:
    """Derive the filterable summary columns from a raw EXIF dict."""
    make, model = exif.get("Make", "").strip(), exif.get("Model", "").strip()
    camera = model if model.startswith(make.split(" ")[0]) and make else " ".join(
        p for p in (make, model) if p
    )
    iso = _num(exif.get("ISO"))
    focal = _num(exif.get("FocalLength"))
    taken = exif.get("DateTimeOriginal")
    if taken:
        # EXIF "YYYY:MM:DD HH:MM:SS" -> sortable ISO-ish "YYYY-MM-DD HH:MM:SS"
        parts = str(taken).split(" ", 1)
        date = parts[0].replace(":", "-")
        taken = date + (" " + parts[1] if len(parts) > 1 else "")
    lat, lon = _parse_gps(exif)
    return {
        "camera": camera or None,
        "lens": exif.get("LensModel") or None,
        "iso": int(iso) if iso else None,
        "focal_length": focal,
        "taken_at": taken,
        "gps_lat": lat,
        "gps_lon": lon,
    }


def scan(library: Library, db: CatalogDB, full: bool = False) -> dict:
    """Walk the library, upsert changed files, sync sidecars, prune deleted.
    full=True re-reads metadata for every file even if unchanged."""
    seen: set[str] = set()
    added = updated = 0

    walk_roots = library.all_roots()
    for walk_root in walk_roots:
      for dirpath, dirnames, filenames in os.walk(walk_root):
        dirnames[:] = [d for d in dirnames if not d.startswith(".") and d != "exports"]
        for name in filenames:
            p = Path(dirpath) / name
            if p.suffix.lower() not in IMAGE_EXTENSIONS or name.endswith(SIDECAR_SUFFIX):
                continue
            # primary-root files are stored relative; extra roots absolute
            rel = str(p.relative_to(library.root)) if walk_root == library.root else str(p)
            seen.add(rel)
            iid = image_id(rel)
            stat = p.stat()
            sc_path = sidecar_path(p)
            sc_mtime = sc_path.stat().st_mtime if sc_path.exists() else None

            row = db.query("SELECT mtime, sidecar_mtime FROM images WHERE id=?", (iid,))
            if not full and row and row[0]["mtime"] == stat.st_mtime and row[0]["sidecar_mtime"] == sc_mtime:
                continue

            sc = load_sidecar(p)
            if not sc_path.exists():
                # no vibe sidecar yet: seed organize fields from a foreign
                # .xmp (Lightroom, Capture One, ...) if one sits next to it
                from viberoom.xmp import find_xmp, read_xmp

                xmp_file = find_xmp(p)
                if xmp_file is not None:
                    xd = read_xmp(xmp_file)
                    sc = sc.model_copy(update={
                        k: xd[k] for k in ("rating", "label", "keywords") if k in xd
                    })
            width, height, exif = read_metadata(p)
            summary = summarize_exif(exif)
            db.execute(
                """INSERT INTO images (id, rel_path, filename, ext, is_raw, filesize,
                       mtime, width, height, exif_json, rating, flag, label, keywords_json,
                       has_edits, sidecar_mtime, camera, lens, iso, focal_length, taken_at,
                       gps_lat, gps_lon)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                   ON CONFLICT(id) DO UPDATE SET filesize=excluded.filesize,
                       mtime=excluded.mtime, width=excluded.width, height=excluded.height,
                       exif_json=excluded.exif_json, rating=excluded.rating,
                       flag=excluded.flag, label=excluded.label,
                       keywords_json=excluded.keywords_json, has_edits=excluded.has_edits,
                       sidecar_mtime=excluded.sidecar_mtime, camera=excluded.camera,
                       lens=excluded.lens, iso=excluded.iso,
                       focal_length=excluded.focal_length, taken_at=excluded.taken_at,
                       gps_lat=excluded.gps_lat, gps_lon=excluded.gps_lon""",
                (
                    iid, rel, name, p.suffix.lower(), int(is_raw(p)), stat.st_size,
                    stat.st_mtime, width, height, json.dumps(exif), sc.rating, sc.flag,
                    sc.label, json.dumps(sc.keywords), int(sc.recipe != Recipe()), sc_mtime,
                    summary["camera"], summary["lens"], summary["iso"],
                    summary["focal_length"], summary["taken_at"],
                    summary["gps_lat"], summary["gps_lon"],
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
