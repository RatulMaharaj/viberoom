"""Stacks and duplicate detection.

Stacks group related frames (bursts, RAW+JPEG pairs) under a leader image;
the DB stores stack_id = leader's image id on every member. Duplicates are
found with a perceptual dHash over thumbnails, so re-exports and resizes of
the same shot cluster together."""

from __future__ import annotations

import io
from pathlib import Path

import numpy as np
from PIL import Image

from viberoom.catalog.db import CatalogDB
from viberoom.config import Library


def auto_stack(db: CatalogDB, gap_seconds: float = 2.0, raw_jpeg: bool = True) -> dict:
    """Assign stack_ids: same-stem RAW+JPEG pairs always stack; frames whose
    EXIF capture times are within gap_seconds chain into burst stacks."""
    rows = db.query(
        "SELECT id, rel_path, filename, ext, is_raw, taken_at FROM images ORDER BY taken_at, rel_path"
    )
    parent: dict[str, str] = {r["id"]: r["id"] for r in rows}

    def union(a: str, b: str) -> None:
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[rb] = ra

    def find(x: str) -> str:
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    if raw_jpeg:
        by_stem: dict[str, list] = {}
        for r in rows:
            stem = str(Path(r["rel_path"]).with_suffix("")).lower()
            by_stem.setdefault(stem, []).append(r)
        for group in by_stem.values():
            if len(group) > 1 and any(g["is_raw"] for g in group):
                for g in group[1:]:
                    union(group[0]["id"], g["id"])

    def ts(row) -> float | None:
        from datetime import datetime

        if not row["taken_at"]:
            return None
        try:
            return datetime.fromisoformat(str(row["taken_at"])).timestamp()
        except ValueError:
            return None

    timed = [(r, t) for r in rows if (t := ts(r)) is not None]
    timed.sort(key=lambda rt: rt[1])
    for (a, ta), (b, tb) in zip(timed, timed[1:]):
        if tb - ta <= gap_seconds:
            union(a["id"], b["id"])

    # write results: leader = first member by (taken_at, rel_path) ordering
    groups: dict[str, list[str]] = {}
    for r in rows:
        groups.setdefault(find(r["id"]), []).append(r["id"])
    db.execute("UPDATE images SET stack_id = NULL")
    stacks = []
    for members in groups.values():
        if len(members) < 2:
            continue
        leader = members[0]
        for iid in members:
            db.execute("UPDATE images SET stack_id=? WHERE id=?", (leader, iid))
        stacks.append({"leader": leader, "members": members})
    return {"stacks": len(stacks), "stacked_images": sum(len(s["members"]) for s in stacks),
            "groups": stacks}


def set_stack(db: CatalogDB, image_ids: list[str]) -> dict:
    """Manually stack images; the first id becomes the leader."""
    leader = image_ids[0]
    for iid in image_ids:
        db.execute("UPDATE images SET stack_id=? WHERE id=?", (leader, iid))
    return {"leader": leader, "members": image_ids}


def unstack(db: CatalogDB, stack_id: str) -> int:
    cur = db.execute("UPDATE images SET stack_id=NULL WHERE stack_id=?", (stack_id,))
    return cur.rowcount


def dhash_bits(thumb_jpeg: bytes) -> str:
    """64-bit difference hash of a thumbnail, hex-encoded."""
    with Image.open(io.BytesIO(thumb_jpeg)) as im:
        g = np.asarray(im.convert("L").resize((9, 8), Image.LANCZOS), dtype=np.int16)
    bits = (g[:, 1:] > g[:, :-1]).flatten()
    return f"{int(''.join('1' if b else '0' for b in bits), 2):016x}"


def _hamming(a: str, b: str) -> int:
    return bin(int(a, 16) ^ int(b, 16)).count("1")


def find_duplicates(db: CatalogDB, library: Library, threshold: int = 5) -> dict:
    """Group visually near-identical images (dHash hamming <= threshold).
    Hashes are computed from cached thumbnails and stored in the DB."""
    from viberoom.engine.decode import extract_thumbnail

    rows = db.query("SELECT id, rel_path, dhash, mtime FROM images")
    hashes: list[tuple[str, str]] = []
    for r in rows:
        h = r["dhash"]
        if not h:
            try:
                h = dhash_bits(extract_thumbnail(library.root / r["rel_path"]))
            except Exception:
                continue
            db.execute("UPDATE images SET dhash=? WHERE id=?", (h, r["id"]))
        hashes.append((r["id"], h))

    parent = {iid: iid for iid, _ in hashes}

    def find(x: str) -> str:
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    for i, (id_a, ha) in enumerate(hashes):
        for id_b, hb in hashes[i + 1:]:
            if _hamming(ha, hb) <= threshold:
                parent[find(id_b)] = find(id_a)

    groups: dict[str, list[str]] = {}
    for iid, _ in hashes:
        groups.setdefault(find(iid), []).append(iid)
    dupes = [sorted(g) for g in groups.values() if len(g) > 1]
    return {"groups": sorted(dupes), "images_affected": sum(len(g) for g in dupes)}
