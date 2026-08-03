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
    stacks = []
    assignments: list[tuple[str, str]] = []
    for members in groups.values():
        if len(members) < 2:
            continue
        leader = members[0]
        assignments += [(leader, iid) for iid in members]
        stacks.append({"leader": leader, "members": members})
    # the clear plus every member in one commit, not one per member
    with db.transaction() as tx:
        tx.execute("UPDATE images SET stack_id = NULL")
        tx.executemany("UPDATE images SET stack_id=? WHERE id=?", assignments)
    return {"stacks": len(stacks), "stacked_images": sum(len(s["members"]) for s in stacks),
            "groups": stacks}


def set_stack(db: CatalogDB, image_ids: list[str]) -> dict:
    """Manually stack images; the first id becomes the leader."""
    leader = image_ids[0]
    with db.transaction() as tx:
        tx.executemany(
            "UPDATE images SET stack_id=? WHERE id=?", [(leader, i) for i in image_ids]
        )
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


_POPCOUNT = np.array([bin(i).count("1") for i in range(256)], dtype=np.uint8)


def _popcount64(x: np.ndarray) -> np.ndarray:
    """Set bits per uint64, via a byte lookup table (numpy has no popcount)."""
    return _POPCOUNT[x.view(np.uint8).reshape(*x.shape, 8)].sum(axis=-1)


def _band_buckets(vals: np.ndarray, threshold: int) -> list[np.ndarray]:
    """Candidate groups that must contain every pair within `threshold` bits.

    Pigeonhole: split the 64 bits into 8 byte-wide bands; a pair differing in
    at most `threshold` bits can disturb at most that many bands, so with
    threshold < 8 the pair agrees exactly on some band and lands in a shared
    bucket. Past that the guarantee is gone and we fall back to one bucket
    holding everything (still vectorized, just O(n^2) comparisons)."""
    if threshold >= 8:
        return [np.arange(len(vals))]
    byte_view = vals.view(np.uint8).reshape(len(vals), 8)
    buckets = []
    for band in range(8):
        col = byte_view[:, band]
        order = np.argsort(col, kind="stable")
        starts = np.flatnonzero(np.diff(col[order])) + 1
        buckets += [b for b in np.split(order, starts) if len(b) > 1]
    return buckets


def _cluster_hashes(hashes: list[tuple[str, str]], threshold: int) -> list[list[str]]:
    """Connected components of the "dHash within `threshold` bits" graph.

    Same result as comparing every pair, without the ~n^2/2 Python hex parses:
    each hash is parsed to a uint64 once and the comparisons run in numpy over
    LSH candidate buckets."""
    ids = [iid for iid, _ in hashes]
    n = len(ids)
    if n < 2:
        return []
    vals = np.array([int(h, 16) for _, h in hashes], dtype=np.uint64)

    parent = list(range(n))

    def find(x: int) -> int:
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    for bucket in _band_buckets(vals, threshold):
        bvals = vals[bucket]
        # rows in slices so a pathological bucket cannot blow up memory
        for start in range(0, len(bucket), 256):
            rows = bucket[start:start + 256]
            dist = _popcount64(vals[rows][:, None] ^ bvals[None, :])
            # upper triangle only: each unordered pair needs one union
            hit_r, hit_c = np.nonzero(
                (dist <= threshold) & (rows[:, None] < bucket[None, :])
            )
            for a, b in zip(rows[hit_r], bucket[hit_c]):
                ra, rb = find(int(a)), find(int(b))
                if ra != rb:
                    parent[rb] = ra

    groups: dict[int, list[str]] = {}
    for i in range(n):
        groups.setdefault(find(i), []).append(ids[i])
    return sorted(sorted(g) for g in groups.values() if len(g) > 1)


def find_duplicates(db: CatalogDB, library: Library, threshold: int = 5) -> dict:
    """Group visually near-identical images (dHash hamming <= threshold).
    Hashes are computed from cached thumbnails and stored in the DB."""
    from viberoom.engine.decode import extract_thumbnail

    rows = db.query("SELECT id, rel_path, dhash, mtime FROM images")
    hashes: list[tuple[str, str]] = []
    fresh: list[tuple[str, str]] = []
    for r in rows:
        h = r["dhash"]
        if not h:
            try:
                h = dhash_bits(extract_thumbnail(library.root / r["rel_path"]))
            except Exception:
                continue
            fresh.append((h, r["id"]))
        hashes.append((r["id"], h))
    if fresh:
        # one commit for the whole backfill instead of one per thumbnail
        with db.transaction() as tx:
            tx.executemany("UPDATE images SET dhash=? WHERE id=?", fresh)

    dupes = _cluster_hashes(hashes, threshold)
    return {"groups": dupes, "images_affected": sum(len(g) for g in dupes)}
