"""FastAPI app: the REST API is the single source of truth for the web UI
and the MCP server alike."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Annotated, Literal

from fastapi import FastAPI, HTTPException, Query, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, ValidationError

from viberoom import presets as preset_store
from viberoom import state
from viberoom.catalog.scanner import scan
from viberoom.config import Library, load_last_library, save_last_library
from viberoom.engine.cache import render_preview
from viberoom.engine.decode import extract_thumbnail
from viberoom.export import ExportFormat, default_extension, export_image as export_file
from viberoom.recipe.merge import deep_merge
from viberoom.recipe.schema import Crop, Recipe
from viberoom.recipe.sidecar import (
    Flag,
    Label,
    Sidecar,
    load_sidecar,
    push_history,
    save_sidecar,
)

app = FastAPI(title="viberoom", version="0.1.0")
api = FastAPI(title="viberoom API")
app.mount("/api/v1", api)


@app.on_event("startup")
def _restore_library() -> None:
    lib = load_last_library()
    if lib is not None:
        state.open_library(lib)
        scan(lib, state.db())


# ---------- library ----------

class LibraryIn(BaseModel):
    path: str


@api.post("/library")
def set_library(body: LibraryIn) -> dict:
    try:
        lib = Library(Path(body.path))
    except NotADirectoryError as e:
        raise HTTPException(400, str(e))
    state.open_library(lib)
    save_last_library(lib.root)
    result = scan(lib, state.db())
    return {"library": str(lib.root), **result}


@api.get("/library")
def get_library() -> dict:
    lib = state.library_or_none()
    return {"library": str(lib.root) if lib else None}


@api.post("/library/scan")
def rescan(full: bool = False) -> dict:
    lib = state.require_library()
    return scan(lib, state.db(), full=full)


# ---------- session: what the user is currently looking at ----------

_current_image: str | None = None


class CurrentIn(BaseModel):
    image_id: str | None


@api.put("/session/current")
def set_current(body: CurrentIn) -> dict:
    """The web UI reports the currently selected/open image here so agents
    can act on \"the image I'm looking at\"."""
    global _current_image
    _current_image = body.image_id
    return {"image_id": _current_image}


@api.get("/session/current")
def get_current() -> dict:
    if _current_image is None:
        return {"image_id": None, "image": None}
    rows = state.db().query("SELECT * FROM images WHERE id=?", (_current_image,))
    return {
        "image_id": _current_image,
        "image": _row_to_dict(rows[0]) if rows else None,
    }


# ---------- change events: push sidecar edits to the UI live ----------

@api.get("/events")
async def events():
    """SSE stream of image ids whose sidecars changed on disk (agent edits,
    manual edits). The UI listens and refreshes affected views."""
    from sse_starlette.sse import EventSourceResponse
    from watchfiles import awatch

    from viberoom.catalog.scanner import image_id as make_id
    from viberoom.recipe.sidecar import SIDECAR_SUFFIX

    lib = state.require_library()

    async def gen():
        async for changes in awatch(lib.root, recursive=True):
            ids = set()
            for _, p in changes:
                if p.endswith(SIDECAR_SUFFIX):
                    try:
                        rel = str(Path(p).relative_to(lib.root))[: -len(SIDECAR_SUFFIX)]
                    except ValueError:
                        continue
                    iid = make_id(rel)
                    _sync_sidecar_to_db(iid)
                    ids.add(iid)
            if ids:
                yield {"event": "sidecar", "data": json.dumps(sorted(ids))}

    return EventSourceResponse(gen())


def _sync_sidecar_to_db(image_id: str) -> None:
    """Refresh one image's DB row from its sidecar (external edit landed)."""
    lib = state.library_or_none()
    if lib is None:
        return
    rows = state.db().query("SELECT rel_path FROM images WHERE id=?", (image_id,))
    if not rows:
        return
    path = lib.root / rows[0]["rel_path"]
    sc = load_sidecar(path)
    sc_path = path.with_name(path.name + ".vibe.json")
    state.db().execute(
        "UPDATE images SET rating=?, flag=?, label=?, keywords_json=?, has_edits=?,"
        " sidecar_mtime=? WHERE id=?",
        (sc.rating, sc.flag, sc.label, json.dumps(sc.keywords), int(sc.recipe != Recipe()),
         sc_path.stat().st_mtime if sc_path.exists() else None, image_id),
    )


# ---------- filesystem browser (for the folder picker UI) ----------

@api.get("/fs")
def browse_fs(path: str | None = None) -> dict:
    """List subdirectories of a path so the UI can offer a folder picker.
    With no path, returns sensible roots: home and mounted volumes."""
    if path is None:
        roots = [str(Path.home())]
        volumes = Path("/Volumes")
        if volumes.is_dir():
            roots += sorted(
                str(v) for v in volumes.iterdir() if v.is_dir() and not v.name.startswith(".")
            )
        return {"path": None, "parent": None, "dirs": roots}

    p = Path(path).expanduser()
    if not p.is_dir():
        raise HTTPException(400, f"Not a directory: {p}")
    try:
        dirs = sorted(
            str(c) for c in p.iterdir() if c.is_dir() and not c.name.startswith(".")
        )
    except PermissionError:
        raise HTTPException(403, f"Permission denied: {p}")
    parent = None if p == p.parent else str(p.parent)
    return {"path": str(p), "parent": parent, "dirs": dirs}


# ---------- images ----------

def _row_to_dict(row) -> dict:
    d = dict(row)
    d["exif"] = json.loads(d.pop("exif_json"))
    d["keywords"] = json.loads(d.pop("keywords_json") or "[]")
    d["is_raw"] = bool(d["is_raw"])
    d["has_edits"] = bool(d["has_edits"])
    return d


def _image_path(image_id: str) -> Path:
    lib = state.require_library()
    rows = state.db().query("SELECT rel_path FROM images WHERE id=?", (image_id,))
    if not rows:
        raise HTTPException(404, f"unknown image id {image_id}")
    return lib.root / rows[0]["rel_path"]


@api.get("/images")
def list_images(
    rating_gte: Annotated[int | None, Query(ge=0, le=5)] = None,
    flag: Literal["pick", "reject", "none"] | None = None,
    label: Literal["red", "yellow", "green", "blue", "purple", "none"] | None = None,
    keyword: str | None = None,
    camera: str | None = None,
    lens: str | None = None,
    iso_gte: Annotated[int | None, Query(ge=0)] = None,
    iso_lte: Annotated[int | None, Query(ge=0)] = None,
    taken_after: str | None = None,
    taken_before: str | None = None,
    q: str | None = None,
    ext: str | None = None,
    has_edits: bool | None = None,
    sort: Literal["filename", "mtime", "rating", "taken_at"] = "filename",
    order: Literal["asc", "desc"] = "asc",
    limit: Annotated[int, Query(ge=1, le=1000)] = 200,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> dict:
    """List/filter images. Substring filters: camera, lens, q (filename).
    keyword matches exactly, case-insensitive. taken_after/taken_before
    compare against EXIF capture time as 'YYYY-MM-DD' or 'YYYY-MM-DD HH:MM:SS'."""
    state.require_library()
    where, params = [], []
    if rating_gte is not None:
        where.append("rating >= ?")
        params.append(rating_gte)
    if flag == "none":
        where.append("flag IS NULL")
    elif flag:
        where.append("flag = ?")
        params.append(flag)
    if label == "none":
        where.append("label IS NULL")
    elif label:
        where.append("label = ?")
        params.append(label)
    if keyword:
        # keywords_json is a JSON array of strings; match one, case-insensitive
        where.append(
            "EXISTS (SELECT 1 FROM json_each(images.keywords_json) WHERE lower(json_each.value) = ?)"
        )
        params.append(keyword.lower())
    if camera:
        where.append("camera LIKE ?")
        params.append(f"%{camera}%")
    if lens:
        where.append("lens LIKE ?")
        params.append(f"%{lens}%")
    if iso_gte is not None:
        where.append("iso >= ?")
        params.append(iso_gte)
    if iso_lte is not None:
        where.append("iso <= ?")
        params.append(iso_lte)
    if taken_after:
        where.append("taken_at >= ?")
        params.append(taken_after)
    if taken_before:
        # a bare date means "through the end of that day"
        where.append("taken_at <= ?")
        params.append(taken_before + (" 23:59:59" if len(taken_before) == 10 else ""))
    if q:
        where.append("filename LIKE ?")
        params.append(f"%{q}%")
    if ext:
        where.append("ext = ?")
        params.append(ext.lower() if ext.startswith(".") else f".{ext.lower()}")
    if has_edits is not None:
        where.append("has_edits = ?")
        params.append(int(has_edits))
    clause = ("WHERE " + " AND ".join(where)) if where else ""
    total = state.db().query(f"SELECT COUNT(*) AS n FROM images {clause}", tuple(params))[0]["n"]
    rows = state.db().query(
        f"SELECT * FROM images {clause} ORDER BY {sort} {order.upper()} LIMIT ? OFFSET ?",
        tuple(params) + (limit, offset),
    )
    return {"total": total, "images": [_row_to_dict(r) for r in rows]}


@api.get("/exts")
def list_exts() -> dict:
    """Distinct file extensions present in the library (for filter UIs)."""
    state.require_library()
    rows = state.db().query("SELECT DISTINCT ext FROM images ORDER BY ext")
    return {"exts": [r["ext"] for r in rows]}


@api.get("/images/{image_id}")
def get_image(image_id: str) -> dict:
    _image_path(image_id)  # 404 check
    rows = state.db().query("SELECT * FROM images WHERE id=?", (image_id,))
    return _row_to_dict(rows[0])


# ---------- rating / flag / label / keywords ----------

class RatingIn(BaseModel):
    rating: int = Field(ge=0, le=5)


class FlagIn(BaseModel):
    flag: Flag = None


class LabelIn(BaseModel):
    label: Label = None


class KeywordsIn(BaseModel):
    keywords: list[str]


class KeywordsPatchIn(BaseModel):
    add: list[str] = Field(default_factory=list)
    remove: list[str] = Field(default_factory=list)


def _now() -> str:
    from datetime import datetime

    return datetime.now().astimezone().isoformat(timespec="seconds")


def _update_sidecar(image_id: str, **updates) -> dict:
    path = _image_path(image_id)
    sc = load_sidecar(path)
    if "recipe" in updates and updates["recipe"] != sc.recipe:
        push_history(sc, _now())
    sc = sc.model_copy(update=updates)
    save_sidecar(path, sc)
    state.db().execute(
        "UPDATE images SET rating=?, flag=?, label=?, keywords_json=?, has_edits=?,"
        " sidecar_mtime=? WHERE id=?",
        (sc.rating, sc.flag, sc.label, json.dumps(sc.keywords), int(sc.recipe != Recipe()),
         path.with_name(path.name + ".vibe.json").stat().st_mtime, image_id),
    )
    return {
        "id": image_id, "rating": sc.rating, "flag": sc.flag,
        "label": sc.label, "keywords": sc.keywords,
    }


def _merge_keywords(current: list[str], add: list[str], remove: list[str]) -> list[str]:
    out = [k for k in current if k.lower() not in {r.lower() for r in remove}]
    have = {k.lower() for k in out}
    for k in add:
        k = k.strip()
        if k and k.lower() not in have:
            out.append(k)
            have.add(k.lower())
    return out


@api.put("/images/{image_id}/rating")
def set_rating(image_id: str, body: RatingIn) -> dict:
    return _update_sidecar(image_id, rating=body.rating)


@api.put("/images/{image_id}/flag")
def set_flag(image_id: str, body: FlagIn) -> dict:
    return _update_sidecar(image_id, flag=body.flag)


@api.put("/images/{image_id}/label")
def set_label(image_id: str, body: LabelIn) -> dict:
    return _update_sidecar(image_id, label=body.label)


@api.put("/images/{image_id}/keywords")
def set_keywords(image_id: str, body: KeywordsIn) -> dict:
    return _update_sidecar(image_id, keywords=_merge_keywords([], body.keywords, []))


@api.patch("/images/{image_id}/keywords")
def patch_keywords(image_id: str, body: KeywordsPatchIn) -> dict:
    current = load_sidecar(_image_path(image_id)).keywords
    return _update_sidecar(image_id, keywords=_merge_keywords(current, body.add, body.remove))


@api.get("/keywords")
def list_keywords() -> dict:
    """All distinct keywords in the library with usage counts."""
    state.require_library()
    rows = state.db().query(
        "SELECT json_each.value AS kw, COUNT(*) AS n FROM images,"
        " json_each(images.keywords_json) GROUP BY lower(kw) ORDER BY n DESC, kw"
    )
    return {"keywords": [{"keyword": r["kw"], "count": r["n"]} for r in rows]}


# ---------- recipe ----------

@api.get("/recipe/schema")
def recipe_schema() -> dict:
    return Recipe.model_json_schema()


@api.get("/images/{image_id}/recipe")
def get_recipe(image_id: str) -> dict:
    return load_sidecar(_image_path(image_id)).recipe.model_dump(mode="json")


@api.put("/images/{image_id}/recipe")
def put_recipe(image_id: str, recipe: Recipe) -> dict:
    _update_sidecar(image_id, recipe=recipe)
    return recipe.model_dump(mode="json")


def _patch_one_recipe(image_id: str, patch: dict) -> Recipe:
    path = _image_path(image_id)
    current = load_sidecar(path).recipe.model_dump(mode="json")
    try:
        merged = Recipe.model_validate(deep_merge(current, patch))
    except ValidationError as e:
        raise HTTPException(422, e.errors(include_url=False))
    _update_sidecar(image_id, recipe=merged)
    return merged


@api.patch("/images/{image_id}/recipe")
def patch_recipe(image_id: str, patch: dict) -> dict:
    return _patch_one_recipe(image_id, patch).model_dump(mode="json")


@api.delete("/images/{image_id}/recipe")
def reset_recipe(image_id: str) -> dict:
    _update_sidecar(image_id, recipe=Recipe())
    return Recipe().model_dump(mode="json")


class AutoIn(BaseModel):
    white_balance: bool = True


@api.post("/images/{image_id}/auto")
def auto_adjust(image_id: str, body: AutoIn | None = None) -> dict:
    """Computational auto: analyze the image and set WB/tone/vibrance.
    Preserves any existing detail/geometry settings."""
    from viberoom.engine.auto import compute_auto_recipe
    from viberoom.engine.cache import _decode_cache

    path = _image_path(image_id)
    linear = _decode_cache.get(path, half_size=True)
    auto = compute_auto_recipe(linear, white_balance=body.white_balance if body else True)
    current = load_sidecar(path).recipe
    # auto owns WB + basic tone + vibrance; everything else is preserved
    auto.detail = current.detail
    auto.geometry = current.geometry
    auto.effects = current.effects
    auto.masks = current.masks
    auto.color.hsl = current.color.hsl
    auto.color.grading = current.color.grading
    auto.tone.toneCurve = current.tone.toneCurve
    auto.tone.texture = current.tone.texture
    auto.tone.clarity = current.tone.clarity
    auto.tone.dehaze = current.tone.dehaze
    _update_sidecar(image_id, recipe=auto)
    return auto.model_dump(mode="json")


# ---------- history / snapshots / variants ----------

import re as _re

_VERSION_NAME_RE = _re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9 _\-]{0,63}$")


def _check_version_name(name: str) -> str:
    if not _VERSION_NAME_RE.match(name):
        raise HTTPException(422, "names are 1-64 chars: letters, digits, spaces, '-', '_'")
    return name


def _sidecar(image_id: str) -> tuple[Path, Sidecar]:
    path = _image_path(image_id)
    return path, load_sidecar(path)


@api.get("/images/{image_id}/history")
def get_history(image_id: str) -> dict:
    """Edit history (oldest first) plus snapshot and variant names."""
    _, sc = _sidecar(image_id)
    return {
        "entries": [{"index": i, "at": e.at} for i, e in enumerate(sc.history)],
        "snapshots": sorted(sc.snapshots),
        "variants": sorted(sc.variants),
    }


@api.get("/images/{image_id}/history/{index}")
def get_history_entry(image_id: str, index: int) -> dict:
    _, sc = _sidecar(image_id)
    if not (0 <= index < len(sc.history)):
        raise HTTPException(404, f"no history entry {index}")
    e = sc.history[index]
    return {"index": index, "at": e.at, "recipe": e.recipe.model_dump(mode="json")}


@api.post("/images/{image_id}/history/{index}/restore")
def restore_history(image_id: str, index: int) -> dict:
    """Make a history entry the current recipe (the replaced recipe is
    itself pushed to history, so restores are always undoable)."""
    _, sc = _sidecar(image_id)
    if not (0 <= index < len(sc.history)):
        raise HTTPException(404, f"no history entry {index}")
    restored = sc.history[index].recipe
    _update_sidecar(image_id, recipe=restored)
    return restored.model_dump(mode="json")


@api.put("/images/{image_id}/snapshots/{name}")
def save_snapshot(image_id: str, name: str) -> dict:
    _check_version_name(name)
    _, sc = _sidecar(image_id)
    _update_sidecar(image_id, snapshots={**sc.snapshots, name: sc.recipe})
    return {"id": image_id, "snapshot": name}


@api.post("/images/{image_id}/snapshots/{name}/restore")
def restore_snapshot(image_id: str, name: str) -> dict:
    _, sc = _sidecar(image_id)
    if name not in sc.snapshots:
        raise HTTPException(404, f"no snapshot named {name!r}")
    _update_sidecar(image_id, recipe=sc.snapshots[name])
    return sc.snapshots[name].model_dump(mode="json")


@api.delete("/images/{image_id}/snapshots/{name}")
def delete_snapshot(image_id: str, name: str) -> dict:
    _, sc = _sidecar(image_id)
    if name not in sc.snapshots:
        raise HTTPException(404, f"no snapshot named {name!r}")
    snaps = dict(sc.snapshots)
    del snaps[name]
    _update_sidecar(image_id, snapshots=snaps)
    return {"deleted": name}


class VariantIn(BaseModel):
    recipe: dict | None = Field(
        default=None, description="Recipe for the variant; omit to copy the current recipe."
    )


@api.put("/images/{image_id}/variants/{name}")
def save_variant(image_id: str, name: str, body: VariantIn | None = None) -> dict:
    """Create/update a virtual copy: an independent recipe renderable and
    exportable alongside the main one."""
    _check_version_name(name)
    _, sc = _sidecar(image_id)
    if body and body.recipe is not None:
        try:
            recipe = Recipe.model_validate(body.recipe)
        except ValidationError as e:
            raise HTTPException(422, e.errors(include_url=False))
    else:
        recipe = sc.recipe
    _update_sidecar(image_id, variants={**sc.variants, name: recipe})
    return {"id": image_id, "variant": name, "recipe": recipe.model_dump(mode="json")}


@api.delete("/images/{image_id}/variants/{name}")
def delete_variant(image_id: str, name: str) -> dict:
    _, sc = _sidecar(image_id)
    if name not in sc.variants:
        raise HTTPException(404, f"no variant named {name!r}")
    variants = dict(sc.variants)
    del variants[name]
    _update_sidecar(image_id, variants=variants)
    return {"deleted": name}


@api.post("/images/{image_id}/variants/{name}/promote")
def promote_variant(image_id: str, name: str) -> dict:
    """Make a variant the main recipe (the old main recipe goes to history;
    the variant entry is kept)."""
    _, sc = _sidecar(image_id)
    if name not in sc.variants:
        raise HTTPException(404, f"no variant named {name!r}")
    _update_sidecar(image_id, recipe=sc.variants[name])
    return sc.variants[name].model_dump(mode="json")


def _recipe_for_variant(sc: Sidecar, variant: str | None) -> Recipe:
    if variant is None:
        return sc.recipe
    if variant not in sc.variants:
        raise HTTPException(404, f"no variant named {variant!r}")
    return sc.variants[variant]


# ---------- previews ----------

@api.get("/images/{image_id}/thumbnail")
def thumbnail(image_id: str) -> Response:
    lib = state.require_library()
    path = _image_path(image_id)
    key = f"thumb-{image_id}-{path.stat().st_mtime}"
    cached = lib.cache_dir / f"{key}.jpg"
    if cached.exists():
        data = cached.read_bytes()
    else:
        data = extract_thumbnail(path)
        cached.write_bytes(data)
    return Response(content=data, media_type="image/jpeg")


@api.get("/images/{image_id}/preview")
def preview(
    image_id: str,
    size: Annotated[int, Query(ge=256, le=4096)] = 1600,
    original: bool = False,
    nocrop: bool = False,
    variant: str | None = None,
) -> Response:
    """Rendered preview with the recipe applied. original=true renders the
    untouched image (before/after); nocrop=true keeps all edits but shows the
    full frame (for the crop tool); variant renders a virtual copy's recipe."""
    lib = state.require_library()
    path = _image_path(image_id)
    recipe = Recipe() if original else _recipe_for_variant(load_sidecar(path), variant)
    if nocrop:
        recipe = recipe.model_copy(deep=True)
        recipe.geometry.crop = Crop()
    data = render_preview(path, recipe, size, lib.cache_dir)
    return Response(content=data, media_type="image/jpeg")


# ---------- export ----------

class ExportIn(BaseModel):
    format: ExportFormat = "jpeg"
    quality: int = Field(default=90, ge=1, le=100, description="JPEG only.")
    bit_depth: Literal[8, 16] = Field(default=8, description="16 is PNG only.")
    max_dimension: int | None = Field(default=None, ge=64, le=20000)
    variant: str | None = Field(default=None, description="Export a virtual copy's recipe.")
    path: str | None = None


def _export_one(image_id: str, body: ExportIn) -> dict:
    lib = state.require_library()
    src = _image_path(image_id)
    if body.bit_depth == 16 and body.format != "png":
        raise HTTPException(422, "bit_depth 16 is only supported for png")
    recipe = _recipe_for_variant(load_sidecar(src), body.variant)
    suffix = f"-{body.variant}" if body.variant else ""
    out = (
        Path(body.path).expanduser()
        if body.path
        else lib.exports_dir / (src.stem + suffix + default_extension(body.format))
    )
    result = export_file(
        src, recipe, out, body.format,
        quality=body.quality, bit_depth=body.bit_depth, max_dimension=body.max_dimension,
    )
    return {"id": image_id, "path": str(result), "format": body.format}


@api.post("/images/{image_id}/export")
def export_image(image_id: str, body: ExportIn) -> dict:
    return _export_one(image_id, body)


# ---------- batch operations ----------

class BatchRecipeIn(BaseModel):
    image_ids: list[str] = Field(min_length=1, max_length=1000)
    patch: dict


class BatchMetaIn(BaseModel):
    image_ids: list[str] = Field(min_length=1, max_length=1000)
    rating: int | None = Field(default=None, ge=0, le=5)
    flag: Literal["pick", "reject", "clear"] | None = None
    label: Literal["red", "yellow", "green", "blue", "purple", "clear"] | None = None
    add_keywords: list[str] = Field(default_factory=list)
    remove_keywords: list[str] = Field(default_factory=list)


class BatchExportIn(ExportIn):
    image_ids: list[str] = Field(min_length=1, max_length=1000)
    path: None = None  # batch always writes to the exports dir


def _batch(image_ids: list[str], fn) -> dict:
    results, errors = [], []
    for iid in image_ids:
        try:
            results.append(fn(iid))
        except HTTPException as e:
            errors.append({"id": iid, "error": e.detail})
    return {"done": len(results), "results": results, "errors": errors}


@api.post("/batch/recipe")
def batch_patch_recipe(body: BatchRecipeIn) -> dict:
    """Apply one recipe merge-patch to many images (sync settings)."""
    return _batch(
        body.image_ids,
        lambda iid: {"id": iid, "recipe": _patch_one_recipe(iid, body.patch).model_dump(mode="json")},
    )


@api.post("/batch/meta")
def batch_set_meta(body: BatchMetaIn) -> dict:
    """Set rating/flag/label and add/remove keywords on many images at once.
    flag/label accept 'clear' to unset."""

    def one(iid: str) -> dict:
        updates: dict = {}
        if body.rating is not None:
            updates["rating"] = body.rating
        if body.flag is not None:
            updates["flag"] = None if body.flag == "clear" else body.flag
        if body.label is not None:
            updates["label"] = None if body.label == "clear" else body.label
        if body.add_keywords or body.remove_keywords:
            current = load_sidecar(_image_path(iid)).keywords
            updates["keywords"] = _merge_keywords(current, body.add_keywords, body.remove_keywords)
        return _update_sidecar(iid, **updates)

    return _batch(body.image_ids, one)


@api.post("/batch/export")
def batch_export(body: BatchExportIn) -> dict:
    single = ExportIn(**body.model_dump(exclude={"image_ids"}))
    return _batch(body.image_ids, lambda iid: _export_one(iid, single))


# ---------- presets ----------

class PresetIn(BaseModel):
    patch: dict = Field(description="A partial recipe (merge-patch), e.g. {'tone': {'contrast': 20}}.")


class PresetApplyIn(BaseModel):
    image_ids: list[str] = Field(min_length=1, max_length=1000)


@api.get("/presets")
def list_presets() -> dict:
    return {"presets": preset_store.list_presets()}


@api.get("/presets/{name}")
def get_preset(name: str) -> dict:
    try:
        return {"name": name, "patch": preset_store.load_preset(name)}
    except KeyError:
        raise HTTPException(404, f"no preset named {name!r}")
    except preset_store.PresetError as e:
        raise HTTPException(422, str(e))


@api.put("/presets/{name}")
def save_preset(name: str, body: PresetIn) -> dict:
    try:
        return preset_store.save_preset(name, body.patch)
    except preset_store.PresetError as e:
        raise HTTPException(422, str(e))


@api.delete("/presets/{name}")
def delete_preset(name: str) -> dict:
    try:
        preset_store.delete_preset(name)
    except KeyError:
        raise HTTPException(404, f"no preset named {name!r}")
    except preset_store.PresetError as e:
        raise HTTPException(422, str(e))
    return {"deleted": name}


@api.post("/presets/{name}/apply")
def apply_preset(name: str, body: PresetApplyIn) -> dict:
    """Merge-patch a saved preset into each image's recipe."""
    try:
        patch = preset_store.load_preset(name)
    except KeyError:
        raise HTTPException(404, f"no preset named {name!r}")
    except preset_store.PresetError as e:
        raise HTTPException(422, str(e))
    return _batch(
        body.image_ids,
        lambda iid: {"id": iid, "recipe": _patch_one_recipe(iid, patch).model_dump(mode="json")},
    )


# serve built frontend if present (dev uses the Vite proxy instead)
_frontend_dist = Path(__file__).resolve().parents[2] / "frontend" / "dist"
if _frontend_dist.is_dir():

    class SPAStaticFiles(StaticFiles):
        """Serve index.html for unknown paths so client-side routes survive reloads."""

        async def get_response(self, path: str, scope):
            from starlette.exceptions import HTTPException as StarletteHTTPException

            try:
                response = await super().get_response(path, scope)
            except StarletteHTTPException as e:
                if e.status_code != 404:
                    raise
                return await super().get_response("index.html", scope)
            if response.status_code == 404:
                response = await super().get_response("index.html", scope)
            return response

    app.mount("/", SPAStaticFiles(directory=_frontend_dist, html=True), name="frontend")


def main() -> None:
    import uvicorn

    import os

    port = int(os.environ.get("VIBEROOM_PORT", "8423"))  # VIBE on a phone keypad
    uvicorn.run("viberoom.main:app", host="127.0.0.1", port=port)
