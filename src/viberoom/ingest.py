"""Import workflow: copy/move photos from a source folder (memory card,
download dir) into the library, with rename templates, content-hash dedupe,
optional backup, and metadata/preset applied on import.

Rename templates may contain '/' to create subfolders. Placeholders:
  {name}  original filename without extension
  {ext}   original extension including the dot (lowercased)
  {date}  capture date YYYY-MM-DD (EXIF DateTimeOriginal, else file mtime)
  {time}  capture time HHMMSS
  {seq}   1-based sequence number within this import (zero-padded to 4)
"""

from __future__ import annotations

import hashlib
import shutil
from datetime import datetime
from pathlib import Path

from viberoom.catalog.db import CatalogDB
from viberoom.config import IMAGE_EXTENSIONS, Library
from viberoom.recipe.sidecar import SIDECAR_SUFFIX, load_sidecar, save_sidecar


def _sha1(path: Path) -> str:
    h = hashlib.sha1()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _capture_datetime(path: Path) -> datetime:
    from viberoom.catalog.metadata import read_metadata

    _, _, exif = read_metadata(path)
    raw = exif.get("DateTimeOriginal")
    if raw:
        for fmt in ("%Y:%m:%d %H:%M:%S", "%Y-%m-%d %H:%M:%S"):
            try:
                return datetime.strptime(str(raw)[:19], fmt)
            except ValueError:
                continue
    return datetime.fromtimestamp(path.stat().st_mtime)


def _render_name(template: str, src: Path, seq: int) -> str:
    needs_date = "{date}" in template or "{time}" in template
    dt = _capture_datetime(src) if needs_date else None
    rel = template.format(
        name=src.stem,
        ext=src.suffix.lower(),
        date=dt.strftime("%Y-%m-%d") if dt else "",
        time=dt.strftime("%H%M%S") if dt else "",
        seq=f"{seq:04d}",
    )
    rel = rel.lstrip("/")
    if ".." in Path(rel).parts:
        raise ValueError("rename template must not contain '..'")
    return rel


def _unique_dest(dest: Path) -> Path:
    if not dest.exists():
        return dest
    for i in range(1, 1000):
        cand = dest.with_stem(f"{dest.stem}-{i}")
        if not cand.exists():
            return cand
    raise FileExistsError(dest)


def import_files(
    source: Path,
    library: Library,
    db: CatalogDB,
    *,
    move: bool = False,
    rename: str = "{name}{ext}",
    backup_dir: Path | None = None,
    dedupe: bool = True,
    rating: int | None = None,
    keywords: list[str] | None = None,
    recipe_patch: dict | None = None,
) -> dict:
    """Import all images under `source` into the library root. Returns
    counts and the list of imported relative paths."""
    if not source.is_dir():
        raise NotADirectoryError(f"Not a directory: {source}")

    # size -> rows index for cheap dedupe candidate lookup
    by_size: dict[int, list[str]] = {}
    if dedupe:
        for row in db.query("SELECT rel_path, filesize FROM images"):
            by_size.setdefault(row["filesize"], []).append(row["rel_path"])
    hash_cache: dict[str, str] = {}

    def existing_hash(rel: str) -> str | None:
        if rel not in hash_cache:
            p = library.root / rel
            if not p.is_file():
                return None
            hash_cache[rel] = _sha1(p)
        return hash_cache[rel]

    sources = sorted(
        p for p in source.rglob("*")
        if p.is_file() and p.suffix.lower() in IMAGE_EXTENSIONS
        and not p.name.endswith(SIDECAR_SUFFIX)
    )

    imported: list[str] = []
    skipped_dupes = 0
    errors: list[dict] = []
    seq = 0
    for src in sources:
        try:
            size = src.stat().st_size
            if dedupe and size in by_size:
                src_hash = _sha1(src)
                if any(existing_hash(rel) == src_hash for rel in by_size[size]):
                    skipped_dupes += 1
                    continue
            seq += 1
            rel = _render_name(rename, src, seq)
            dest = _unique_dest(library.root / rel)
            dest.parent.mkdir(parents=True, exist_ok=True)

            if backup_dir is not None:
                backup_dir.mkdir(parents=True, exist_ok=True)
                shutil.copy2(src, _unique_dest(backup_dir / src.name))

            # bring an existing sidecar along so prior edits survive the import
            src_sidecar = src.with_name(src.name + SIDECAR_SUFFIX)
            if move:
                shutil.move(str(src), dest)
                if src_sidecar.exists():
                    shutil.move(str(src_sidecar), dest.with_name(dest.name + SIDECAR_SUFFIX))
            else:
                shutil.copy2(src, dest)
                if src_sidecar.exists():
                    shutil.copy2(src_sidecar, dest.with_name(dest.name + SIDECAR_SUFFIX))

            if rating is not None or keywords or recipe_patch:
                sc = load_sidecar(dest)
                if rating is not None:
                    sc.rating = rating
                if keywords:
                    have = {k.lower() for k in sc.keywords}
                    sc.keywords += [k for k in keywords if k.lower() not in have]
                if recipe_patch:
                    from viberoom.recipe.merge import deep_merge
                    from viberoom.recipe.schema import Recipe

                    sc.recipe = Recipe.model_validate(
                        deep_merge(sc.recipe.model_dump(mode="json"), recipe_patch)
                    )
                save_sidecar(dest, sc)

            rel_final = str(dest.relative_to(library.root))
            imported.append(rel_final)
            by_size.setdefault(dest.stat().st_size, []).append(rel_final)
        except (OSError, ValueError) as e:
            errors.append({"file": str(src), "error": str(e)})

    return {
        "imported": len(imported),
        "skipped_duplicates": skipped_dupes,
        "errors": errors,
        "files": imported,
    }
