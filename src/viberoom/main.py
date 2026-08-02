"""FastAPI app: the REST API is the single source of truth for the web UI
and the MCP server alike."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Annotated, Literal

from fastapi import FastAPI, HTTPException, Query, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, ValidationError

from viberoom import state
from viberoom.catalog.scanner import scan
from viberoom.config import Library, load_last_library, save_last_library
from viberoom.engine.cache import render_preview
from viberoom.engine.decode import extract_thumbnail
from viberoom.export import export_jpeg
from viberoom.recipe.schema import Recipe
from viberoom.recipe.sidecar import Flag, load_sidecar, save_sidecar

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
def rescan() -> dict:
    lib = state.require_library()
    return scan(lib, state.db())


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
    ext: str | None = None,
    has_edits: bool | None = None,
    sort: Literal["filename", "mtime", "rating"] = "filename",
    order: Literal["asc", "desc"] = "asc",
    limit: Annotated[int, Query(ge=1, le=1000)] = 200,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> dict:
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


# ---------- rating / flag ----------

class RatingIn(BaseModel):
    rating: int = Field(ge=0, le=5)


class FlagIn(BaseModel):
    flag: Flag = None


def _update_sidecar(image_id: str, **updates) -> dict:
    path = _image_path(image_id)
    sc = load_sidecar(path)
    sc = sc.model_copy(update=updates)
    save_sidecar(path, sc)
    state.db().execute(
        "UPDATE images SET rating=?, flag=?, has_edits=?, sidecar_mtime=? WHERE id=?",
        (sc.rating, sc.flag, int(sc.recipe != Recipe()),
         path.with_name(path.name + ".vibe.json").stat().st_mtime, image_id),
    )
    return {"id": image_id, "rating": sc.rating, "flag": sc.flag}


@api.put("/images/{image_id}/rating")
def set_rating(image_id: str, body: RatingIn) -> dict:
    return _update_sidecar(image_id, rating=body.rating)


@api.put("/images/{image_id}/flag")
def set_flag(image_id: str, body: FlagIn) -> dict:
    return _update_sidecar(image_id, flag=body.flag)


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


def _deep_merge(base: dict, patch: dict) -> dict:
    out = dict(base)
    for k, v in patch.items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = _deep_merge(out[k], v)
        else:
            out[k] = v
    return out


@api.patch("/images/{image_id}/recipe")
def patch_recipe(image_id: str, patch: dict) -> dict:
    path = _image_path(image_id)
    current = load_sidecar(path).recipe.model_dump(mode="json")
    try:
        merged = Recipe.model_validate(_deep_merge(current, patch))
    except ValidationError as e:
        raise HTTPException(422, e.errors(include_url=False))
    _update_sidecar(image_id, recipe=merged)
    return merged.model_dump(mode="json")


@api.delete("/images/{image_id}/recipe")
def reset_recipe(image_id: str) -> dict:
    _update_sidecar(image_id, recipe=Recipe())
    return Recipe().model_dump(mode="json")


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
def preview(image_id: str, size: Annotated[int, Query(ge=256, le=4096)] = 1600) -> Response:
    lib = state.require_library()
    path = _image_path(image_id)
    recipe = load_sidecar(path).recipe
    data = render_preview(path, recipe, size, lib.cache_dir)
    return Response(content=data, media_type="image/jpeg")


# ---------- export ----------

class ExportIn(BaseModel):
    quality: int = Field(default=90, ge=1, le=100)
    max_dimension: int | None = Field(default=None, ge=64, le=20000)
    path: str | None = None


@api.post("/images/{image_id}/export")
def export_image(image_id: str, body: ExportIn) -> dict:
    lib = state.require_library()
    src = _image_path(image_id)
    recipe = load_sidecar(src).recipe
    out = Path(body.path).expanduser() if body.path else lib.exports_dir / (src.stem + ".jpg")
    result = export_jpeg(src, recipe, out, quality=body.quality, max_dimension=body.max_dimension)
    return {"id": image_id, "path": str(result), "quality": body.quality}


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
