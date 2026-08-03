"""FastAPI app: the REST API is the single source of truth for the web UI
and the MCP server alike."""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
from contextlib import AsyncExitStack, asynccontextmanager
from pathlib import Path
from typing import Annotated, Literal

from fastapi import (
    FastAPI,
    HTTPException,
    Query,
    Request,
    Response,
    WebSocket,
    WebSocketDisconnect,
)
from fastapi.concurrency import run_in_threadpool
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, ValidationError

from viberoom import agent
from viberoom import mcp_server, permission_mcp
from viberoom import presets as preset_store
from viberoom import state
from viberoom.catalog.scanner import scan
from viberoom.config import Library, load_last_library, save_last_library
from viberoom.engine.cache import preview_cache_key, render_preview
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

# MCP over HTTP, mounted on this same server: agents connect with a URL
# (`claude mcp add --transport http viberoom http://127.0.0.1:8423/mcp`)
# instead of a stdio command with an absolute path to this checkout.
_mcp_app = mcp_server.mcp.streamable_http_app(streamable_http_path="/mcp")
_approve_app = permission_mcp.mcp.streamable_http_app(streamable_http_path="/mcp-approve")


_mcp_stack: AsyncExitStack | None = None
#: Held at module scope only so asyncio does not garbage-collect the running
#: startup rescan out from under itself.
_startup_scan: asyncio.Task | None = None


def _log_startup_scan(task: asyncio.Task) -> None:
    """Surface a failed background rescan instead of letting asyncio swallow it
    into an un-retrieved exception at interpreter shutdown."""
    if not task.cancelled() and task.exception() is not None:
        import traceback

        traceback.print_exception(task.exception())


@asynccontextmanager
async def _lifespan(_: FastAPI):
    global _mcp_stack, _startup_scan
    lib = load_last_library()
    if lib is not None:
        state.open_library(lib)
        # Reopening the last library used to scan it synchronously here, so on
        # a large catalog the server accepted no connections until the whole
        # tree had been walked. The rows from the previous session are already
        # in the DB, so the UI has something to show immediately; the rescan
        # only reconciles what changed while we were away.
        _startup_scan = asyncio.create_task(run_in_threadpool(scan, lib, state.db()))
        _startup_scan.add_done_callback(_log_startup_scan)
    # The MCP session managers are single-use, but tests enter this lifespan
    # once per TestClient — so start them at most once and leave them up for
    # the life of the process.
    if _mcp_stack is None:
        _mcp_stack = AsyncExitStack()
        await _mcp_stack.enter_async_context(
            _mcp_app.router.lifespan_context(_mcp_app)
        )
        await _mcp_stack.enter_async_context(
            _approve_app.router.lifespan_context(_approve_app)
        )
    yield


app = FastAPI(title="viberoom", version="0.1.0", lifespan=_lifespan)
api = FastAPI(title="viberoom API")
app.mount("/api/v1", api)
# Adopt the sub-apps' routes rather than mounting them: a Mount strips its
# prefix, which would make the URLs /mcp/mcp or force a trailing slash.
app.router.routes.extend(_mcp_app.routes)
app.router.routes.extend(_approve_app.routes)


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


class RootIn(BaseModel):
    path: str


@api.get("/library/roots")
def list_roots() -> dict:
    """All folders in the catalog: the primary root plus extra roots."""
    lib = state.require_library()
    return {"primary": str(lib.root), "extra": [str(r) for r in lib.extra_roots()]}


@api.post("/library/roots")
def add_root(body: RootIn) -> dict:
    """Add another folder (any drive) to this library's catalog and scan it."""
    lib = state.require_library()
    try:
        lib.add_root(Path(body.path))
    except NotADirectoryError as e:
        raise HTTPException(400, str(e))
    result = scan(lib, state.db())
    return {"primary": str(lib.root), "extra": [str(r) for r in lib.extra_roots()], **result}


@api.delete("/library/roots")
def remove_root(path: str) -> dict:
    """Remove an extra folder from the catalog (its rows prune on rescan)."""
    lib = state.require_library()
    lib.remove_root(Path(path))
    result = scan(lib, state.db())
    return {"primary": str(lib.root), "extra": [str(r) for r in lib.extra_roots()], **result}


# ---------- import ----------

class ImportIn(BaseModel):
    source: str
    move: bool = False
    rename: str = Field(
        default="{name}{ext}",
        description="Filename template; may contain '/' for subfolders. "
        "Placeholders: {name} {ext} {date} {time} {seq}.",
    )
    backup_dir: str | None = None
    dedupe: bool = True
    rating: int | None = Field(default=None, ge=0, le=5)
    keywords: list[str] = Field(default_factory=list)
    preset: str | None = Field(default=None, description="Develop preset applied on import.")


@api.post("/import")
def import_photos(body: ImportIn) -> dict:
    """Copy/move images from a source folder (memory card, downloads) into
    the library with rename templates, content-hash dedupe, optional backup,
    and rating/keywords/preset applied on import."""
    from viberoom.ingest import import_files

    lib = state.require_library()
    recipe_patch = None
    if body.preset:
        try:
            recipe_patch = preset_store.load_preset(body.preset)
        except KeyError:
            raise HTTPException(404, f"no preset named {body.preset!r}")
    try:
        result = import_files(
            Path(body.source).expanduser(), lib, state.db(),
            move=body.move, rename=body.rename,
            backup_dir=Path(body.backup_dir).expanduser() if body.backup_dir else None,
            dedupe=body.dedupe, rating=body.rating,
            keywords=body.keywords, recipe_patch=recipe_patch,
        )
    except NotADirectoryError as e:
        raise HTTPException(400, str(e))
    scan_result = scan(lib, state.db())
    return {**result, "library_total": scan_result["total"]}


# ---------- tethered capture ----------

class TetherCaptureIn(BaseModel):
    subfolder: str = Field(default="tethered", description="Library subfolder for captures.")
    prefix: str = Field(default="tether", pattern=r"^[a-zA-Z0-9_\-]{1,32}$")
    preset: str | None = Field(default=None, description="Develop preset applied on capture.")
    keywords: list[str] = Field(default_factory=list)


@api.get("/tether")
def tether_status() -> dict:
    """Is a camera connected for tethered capture (via gphoto2)?"""
    from viberoom import tether

    if tether.GPHOTO2 is None:
        return {"available": False, "reason": "gphoto2 not installed"}
    try:
        cam = tether.detect_camera()
    except tether.TetherError as e:
        return {"available": False, "reason": str(e)}
    return {"available": True, **cam}


@api.post("/tether/capture")
def tether_capture(body: TetherCaptureIn | None = None) -> dict:
    """Trigger the shutter, download the frame into the library, scan it,
    and optionally apply a preset/keywords. Returns the new image id."""
    from viberoom import tether

    lib = state.require_library()
    b = body or TetherCaptureIn()
    if ".." in Path(b.subfolder).parts:
        raise HTTPException(422, "subfolder must stay inside the library")
    recipe_patch = None
    if b.preset:
        try:
            recipe_patch = preset_store.load_preset(b.preset)
        except KeyError:
            raise HTTPException(404, f"no preset named {b.preset!r}")
    try:
        path = tether.capture(lib.root / b.subfolder, prefix=b.prefix)
    except tether.TetherError as e:
        raise HTTPException(503, str(e))

    if recipe_patch or b.keywords:
        sc = load_sidecar(path)
        if b.keywords:
            sc.keywords = list(dict.fromkeys(sc.keywords + b.keywords))
        if recipe_patch:
            sc.recipe = Recipe.model_validate(
                deep_merge(sc.recipe.model_dump(mode="json"), recipe_patch)
            )
        save_sidecar(path, sc)
    scan(lib, state.db())
    from viberoom.catalog.scanner import image_id as make_id

    iid = make_id(str(path.relative_to(lib.root)))
    return {"id": iid, "path": str(path)}


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


# ---------- embedded Claude Code session ----------

def _agent_session():
    """The session for the open library, spawning `claude` lazily."""
    lib = state.require_library()
    port = os.environ.get("VIBEROOM_PORT", "8423")
    return agent.session(lib.root, f"http://127.0.0.1:{port}")


@api.get("/agent/status")
def agent_status() -> dict:
    """Whether a local `claude` install was found, and whether a session is up."""
    info = agent.detect()
    sess = agent.current()
    lib = state.library_or_none()
    return {
        **info,
        "running": bool(sess and sess.running),
        "session_id": sess.session_id if sess else None,
        "cwd": str(lib.root) if lib else None,
        "config": dict(sess.config) if sess else dict(agent.DEFAULT_CONFIG),
        "options": {
            "model": agent.MODELS,
            "effort": agent.EFFORTS,
            "permission_mode": agent.PERMISSION_MODES,
        },
    }


class PermissionRequestIn(BaseModel):
    tool_name: str
    input: dict = Field(default_factory=dict)
    tool_use_id: str = ""


@api.post("/agent/permission/request")
async def agent_permission_request(body: PermissionRequestIn) -> dict:
    """Called by the permission MCP server; blocks until the user decides."""
    sess = agent.current()
    if sess is None:
        return {"behavior": "deny", "message": "No agent session is open."}
    return await agent.broker.ask(sess, body.tool_name, body.input)


@api.websocket("/agent/ws")
async def agent_ws(ws: WebSocket) -> None:
    """Bidirectional bridge between the sidebar and the `claude` subprocess."""
    await ws.accept()
    try:
        sess = _agent_session()
    except HTTPException as e:
        await ws.send_json({"type": "error", "message": e.detail})
        await ws.close()
        return

    queue = sess.subscribe()
    for frame in sess.replay():
        await ws.send_json(frame)
    await ws.send_json({"type": "status", "running": sess.running, "cwd": str(sess.cwd)})

    async def push() -> None:
        while True:
            await ws.send_json(await queue.get())

    pusher = asyncio.create_task(push())
    try:
        while True:
            msg = await ws.receive_json()
            kind = msg.get("type")
            if kind == "user":
                text = (msg.get("text") or "").strip()
                if text:
                    await sess.send(_with_context(text, msg.get("image_id")), echo=text)
            elif kind == "permission":
                agent.broker.resolve(msg.get("id", ""), bool(msg.get("allow")))
            elif kind == "config":
                await sess.configure(msg.get("config") or {})
            elif kind == "reset":
                await sess.stop()
    except WebSocketDisconnect:
        pass
    finally:
        pusher.cancel()
        sess.unsubscribe(queue)


def _with_context(text: str, image_id: str | None) -> str:
    """Tell the agent which photo the user is looking at, so \"this one\" works."""
    iid = image_id or _current_image
    if iid is None:
        return text
    rows = state.db().query("SELECT rel_path FROM images WHERE id=?", (iid,))
    if not rows:
        return text
    return (
        f"<viberoom-context>Currently open image: {rows[0]['rel_path']} "
        f"(id {iid}). Use the viberoom MCP tools to inspect or edit it."
        "</viberoom-context>\n\n" + text
    )


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
        async for changes in awatch(*lib.all_roots(), recursive=True):
            ids = set()
            for _, p in changes:
                if p.endswith(SIDECAR_SUFFIX):
                    try:
                        rel = str(Path(p).relative_to(lib.root))[: -len(SIDECAR_SUFFIX)]
                    except ValueError:
                        rel = p[: -len(SIDECAR_SUFFIX)]  # extra roots: absolute
                    ids.add(make_id(rel))
            if ids:
                # Off the event loop, and once for the whole batch rather than
                # once per file: each id is a SQLite round-trip plus a sidecar
                # read, and a batch metadata edit over a large selection would
                # otherwise stall every other request for the duration.
                await run_in_threadpool(_sync_sidecars_to_db, sorted(ids))
                yield {"event": "sidecar", "data": json.dumps(sorted(ids))}

    return EventSourceResponse(gen())


def _sync_sidecars_to_db(image_ids: list[str]) -> None:
    """Refresh several rows in one transaction — the watcher reports changes in
    batches, and committing per file is what made a bulk edit expensive."""
    with state.db().transaction():
        for image_id in image_ids:
            _sync_sidecar_to_db(image_id)


def _sync_sidecar_to_db(image_id: str) -> None:
    """Refresh one image's DB row from its sidecar (external edit landed)."""
    lib = state.library_or_none()
    if lib is None:
        return
    rows = state.db().query("SELECT rel_path FROM images WHERE id=?", (image_id,))
    if not rows:
        return
    path = lib.resolve(rows[0]["rel_path"])
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
def browse_fs(path: str | None = None, hidden: bool = False) -> dict:
    """List subdirectories of a path so the UI can offer a folder picker.
    With no path, returns sensible roots: home and mounted volumes.
    Dot-directories are omitted unless `hidden` is set."""

    def keep(c: Path) -> bool:
        return c.is_dir() and (hidden or not c.name.startswith("."))

    if path is None:
        roots = [str(Path.home())]
        volumes = Path("/Volumes")
        if volumes.is_dir():
            roots += sorted(str(v) for v in volumes.iterdir() if keep(v))
        return {"path": None, "parent": None, "dirs": roots}

    p = Path(path).expanduser()
    if not p.is_dir():
        raise HTTPException(400, f"Not a directory: {p}")
    try:
        dirs = sorted(str(c) for c in p.iterdir() if keep(c))
    except PermissionError:
        raise HTTPException(403, f"Permission denied: {p}")
    parent = None if p == p.parent else str(p.parent)
    return {"path": str(p), "parent": parent, "dirs": dirs}


def _native_picker_cmd(start: str | None) -> list[str] | None:
    """The platform's folder-chooser, or None if we can't offer one.

    Only meaningful because viberoom is a local app: the dialog opens on the
    same machine as the browser. Remote use falls back to the tree picker.
    """
    import shutil as _shutil
    import sys as _sys

    if _sys.platform == "darwin":
        default = f'default location POSIX file "{start}" ' if start else ""
        return [
            "osascript",
            "-e", 'tell application "System Events" to activate',
            "-e", f'POSIX path of (choose folder with prompt "Export to" {default})',
        ]
    if _shutil.which("zenity"):
        return ["zenity", "--file-selection", "--directory", *(["--filename", start] if start else [])]
    if _shutil.which("kdialog"):
        return ["kdialog", "--getexistingdirectory", start or "."]
    return None


@api.get("/fs/native-picker")
def native_picker_available() -> dict:
    return {"available": _native_picker_cmd(None) is not None}


class NativePickerIn(BaseModel):
    start: str | None = None


@api.post("/fs/native-picker")
def native_picker(body: NativePickerIn) -> dict:
    """Open the OS folder dialog and return what was chosen.

    Blocks until the user answers, so it runs in FastAPI's threadpool (this is
    a sync endpoint on purpose).
    """
    cmd = _native_picker_cmd(body.start)
    if cmd is None:
        raise HTTPException(501, "No native folder dialog on this platform.")
    import subprocess as _sp

    try:
        out = _sp.run(cmd, capture_output=True, text=True, timeout=300)
    except _sp.TimeoutExpired:
        raise HTTPException(504, "Folder dialog timed out.")
    path = out.stdout.strip()
    if out.returncode != 0 or not path:
        # Cancelling is a normal outcome, not an error.
        return {"path": None, "cancelled": True}
    return {"path": path.rstrip("/") or "/", "cancelled": False}


class MkdirIn(BaseModel):
    parent: str
    name: str


@api.post("/fs/mkdir")
def make_dir(body: MkdirIn) -> dict:
    """Create a folder, so the picker can make one without leaving the app."""
    name = body.name.strip()
    if not name or "/" in name or name in {".", ".."}:
        raise HTTPException(400, "Folder name must be a single path segment.")
    parent = Path(body.parent).expanduser()
    if not parent.is_dir():
        raise HTTPException(400, f"Not a directory: {parent}")
    target = parent / name
    if target.exists():
        raise HTTPException(409, f"Already exists: {target}")
    try:
        target.mkdir(parents=False)
    except PermissionError:
        raise HTTPException(403, f"Permission denied: {parent}")
    return {"path": str(target)}


# ---------- images ----------

# Everything a grid row needs, minus the multi-KB exif_json blob: parsing it for
# 500 rows dominated the list endpoint. faces_json is likewise counted in SQL.
# The full blob still ships from GET /images/{id}, which is what the editor reads.
_LIST_COLUMNS = (
    "id, rel_path, filename, ext, is_raw, filesize, mtime, width, height, rating,"
    " flag, has_edits, sidecar_mtime, label, keywords_json, camera, lens, iso,"
    " focal_length, aperture, shutter, taken_at, stack_id, gps_lat, gps_lon, dhash,"
    " CASE WHEN faces_json IS NULL THEN NULL ELSE json_array_length(faces_json) END AS faces"
)


def _summary_exif(d: dict) -> dict:
    """Rebuild the handful of EXIF keys the UI's caption line reads out of the
    denormalized columns, so list rows keep the same `exif` shape as detail rows.
    Values are strings because that is what the scanner stores."""
    pairs = (
        ("Model", d.get("camera")), ("LensModel", d.get("lens")),
        ("ISO", d.get("iso")), ("FocalLength", d.get("focal_length")),
        ("FNumber", d.get("aperture")), ("ExposureTime", d.get("shutter")),
        ("DateTimeOriginal", d.get("taken_at")),
    )
    return {k: str(v) for k, v in pairs if v is not None}


def _row_to_dict(row) -> dict:
    d = dict(row)
    if "exif_json" in d:
        d["exif"] = json.loads(d.pop("exif_json"))
    else:
        d["exif"] = _summary_exif(d)
    d["keywords"] = json.loads(d.pop("keywords_json") or "[]")
    if "faces_json" in d:
        faces = d.pop("faces_json")
        d["faces"] = len(json.loads(faces)) if faces else None  # None = not scanned
    d["is_raw"] = bool(d["is_raw"])
    d["has_edits"] = bool(d["has_edits"])
    return d


def _image_paths(image_ids: list[str]) -> dict[str, Path]:
    """Resolve many ids in one pass — a batch op over 1000 ids was 1000 queries.
    Unknown ids are simply absent from the result."""
    lib = state.require_library()
    found: dict[str, Path] = {}
    for i in range(0, len(image_ids), 500):  # SQLITE_MAX_VARIABLE_NUMBER is 999
        chunk = image_ids[i:i + 500]
        rows = state.db().query(
            f"SELECT id, rel_path FROM images WHERE id IN ({','.join('?' * len(chunk))})",
            tuple(chunk),
        )
        for r in rows:
            found[r["id"]] = lib.resolve(r["rel_path"])
    return found


def _image_path(image_id: str) -> Path:
    lib = state.require_library()
    rows = state.db().query("SELECT rel_path FROM images WHERE id=?", (image_id,))
    if not rows:
        raise HTTPException(404, f"unknown image id {image_id}")
    return lib.resolve(rows[0]["rel_path"])


def _build_where(f: dict) -> tuple[list[str], list]:
    """Translate a filter dict (the /images query params, also used by smart
    collections) into SQL where fragments + params."""
    where, params = [], []
    if f.get("rating_gte") is not None:
        where.append("rating >= ?")
        params.append(f["rating_gte"])
    flag = f.get("flag")
    if flag == "none":
        where.append("flag IS NULL")
    elif flag:
        where.append("flag = ?")
        params.append(flag)
    label = f.get("label")
    if label == "none":
        where.append("label IS NULL")
    elif label:
        where.append("label = ?")
        params.append(label)
    if f.get("keyword"):
        # keywords_json is a JSON array of strings; match one, case-insensitive
        where.append(
            "EXISTS (SELECT 1 FROM json_each(images.keywords_json) WHERE lower(json_each.value) = ?)"
        )
        params.append(f["keyword"].lower())
    if f.get("camera"):
        where.append("camera LIKE ?")
        params.append(f"%{f['camera']}%")
    if f.get("lens"):
        where.append("lens LIKE ?")
        params.append(f"%{f['lens']}%")
    if f.get("iso_gte") is not None:
        where.append("iso >= ?")
        params.append(f["iso_gte"])
    if f.get("iso_lte") is not None:
        where.append("iso <= ?")
        params.append(f["iso_lte"])
    if f.get("taken_after"):
        where.append("taken_at >= ?")
        params.append(f["taken_after"])
    if f.get("taken_before"):
        # a bare date means "through the end of that day"
        tb = f["taken_before"]
        where.append("taken_at <= ?")
        params.append(tb + (" 23:59:59" if len(tb) == 10 else ""))
    if f.get("q"):
        where.append("filename LIKE ?")
        params.append(f"%{f['q']}%")
    if f.get("folder"):
        where.append("rel_path LIKE ?")
        params.append(f"{f['folder']}%")
    if f.get("ext"):
        ext = f["ext"]
        where.append("ext = ?")
        params.append(ext.lower() if ext.startswith(".") else f".{ext.lower()}")
    if f.get("has_edits") is not None:
        where.append("has_edits = ?")
        params.append(int(f["has_edits"]))
    if f.get("has_gps") is not None:
        where.append("gps_lat IS NOT NULL" if f["has_gps"] else "gps_lat IS NULL")
    if f.get("faces_gte") is not None:
        where.append("faces_json IS NOT NULL AND json_array_length(faces_json) >= ?")
        params.append(f["faces_gte"])
    return where, params


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
    folder: str | None = None,
    ext: str | None = None,
    has_edits: bool | None = None,
    has_gps: bool | None = None,
    faces_gte: Annotated[int | None, Query(ge=0)] = None,
    collection: str | None = None,
    stacks: Literal["collapse"] | None = None,
    sort: Literal["filename", "mtime", "rating", "taken_at"] = "filename",
    order: Literal["asc", "desc"] = "asc",
    limit: Annotated[int, Query(ge=1, le=1000)] = 200,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> dict:
    """List/filter images. Substring filters: camera, lens, q (filename).
    keyword matches exactly, case-insensitive. taken_after/taken_before
    compare against EXIF capture time as 'YYYY-MM-DD' or 'YYYY-MM-DD HH:MM:SS'.
    collection restricts to a static or smart collection; stacks=collapse
    shows only stack leaders and unstacked images."""
    from viberoom.catalog import collections_store

    lib = state.require_library()
    where, params = _build_where({
        "rating_gte": rating_gte, "flag": flag, "label": label, "keyword": keyword,
        "camera": camera, "lens": lens, "iso_gte": iso_gte, "iso_lte": iso_lte,
        "taken_after": taken_after, "taken_before": taken_before, "q": q,
        "folder": folder, "ext": ext, "has_edits": has_edits,
        "has_gps": has_gps, "faces_gte": faces_gte,
    })
    if collection is not None:
        try:
            col = collections_store.get_collection(lib, collection)
        except KeyError:
            raise HTTPException(404, f"no collection named {collection!r}")
        if col["type"] == "static":
            if not col["ids"]:
                return {"total": 0, "images": []}
            where.append(f"id IN ({','.join('?' * len(col['ids']))})")
            params.extend(col["ids"])
        else:
            smart_where, smart_params = _build_where(col["query"])
            where += smart_where
            params += smart_params
    if stacks == "collapse":
        where.append("(stack_id IS NULL OR stack_id = id)")
    clause = ("WHERE " + " AND ".join(where)) if where else ""
    total = state.db().query(f"SELECT COUNT(*) AS n FROM images {clause}", tuple(params))[0]["n"]
    rows = state.db().query(
        f"SELECT {_LIST_COLUMNS} FROM images {clause}"
        f" ORDER BY {sort} {order.upper()} LIMIT ? OFFSET ?",
        tuple(params) + (limit, offset),
    )
    return {"total": total, "images": [_row_to_dict(r) for r in rows]}


# ---------- collections ----------

class CollectionIn(BaseModel):
    type: Literal["static", "smart"]
    ids: list[str] | None = None
    query: dict | None = None


class CollectionImagesIn(BaseModel):
    add: list[str] = Field(default_factory=list)
    remove: list[str] = Field(default_factory=list)


@api.get("/collections")
def list_collections_endpoint() -> dict:
    from viberoom.catalog import collections_store

    lib = state.require_library()
    return {"collections": collections_store.list_collections(lib)}


@api.put("/collections/{name}")
def save_collection(name: str, body: CollectionIn) -> dict:
    """Create/replace a collection. Static: {type: 'static', ids: [...]}.
    Smart: {type: 'smart', query: {rating_gte: 4, flag: 'pick', ...}} — the
    query uses the same filters as GET /images and is evaluated live."""
    from viberoom.catalog import collections_store

    lib = state.require_library()
    spec: dict = {"type": body.type}
    if body.ids is not None:
        spec["ids"] = body.ids
    if body.query is not None:
        spec["query"] = body.query
    try:
        return collections_store.save_collection(lib, name, spec)
    except collections_store.CollectionError as e:
        raise HTTPException(422, str(e))


@api.delete("/collections/{name}")
def delete_collection(name: str) -> dict:
    from viberoom.catalog import collections_store

    lib = state.require_library()
    try:
        collections_store.delete_collection(lib, name)
    except KeyError:
        raise HTTPException(404, f"no collection named {name!r}")
    return {"deleted": name}


@api.post("/collections/{name}/images")
def edit_collection_images(name: str, body: CollectionImagesIn) -> dict:
    """Add/remove images in a static collection."""
    from viberoom.catalog import collections_store

    lib = state.require_library()
    try:
        return collections_store.edit_static(lib, name, body.add, body.remove)
    except KeyError:
        raise HTTPException(404, f"no collection named {name!r}")
    except collections_store.CollectionError as e:
        raise HTTPException(422, str(e))


# ---------- stacks & duplicates ----------

class AutoStackIn(BaseModel):
    gap_seconds: float = Field(default=2.0, gt=0, le=60)
    raw_jpeg: bool = True


class StackIn(BaseModel):
    image_ids: list[str] = Field(min_length=2, max_length=1000)


@api.post("/stacks/auto")
def auto_stack_endpoint(body: AutoStackIn | None = None) -> dict:
    """Auto-stack bursts (capture times within gap_seconds) and RAW+JPEG
    pairs. Replaces all existing stacks."""
    from viberoom.catalog.stacks import auto_stack

    state.require_library()
    b = body or AutoStackIn()
    return auto_stack(state.db(), gap_seconds=b.gap_seconds, raw_jpeg=b.raw_jpeg)


@api.post("/stacks")
def create_stack(body: StackIn) -> dict:
    from viberoom.catalog.stacks import set_stack

    state.require_library()
    known = _image_paths(body.image_ids)
    for iid in body.image_ids:
        if iid not in known:
            raise HTTPException(404, f"unknown image id {iid}")
    return set_stack(state.db(), body.image_ids)


@api.delete("/stacks/{stack_id}")
def delete_stack(stack_id: str) -> dict:
    from viberoom.catalog.stacks import unstack

    state.require_library()
    return {"unstacked": unstack(state.db(), stack_id)}


@api.get("/duplicates")
def list_duplicates(threshold: Annotated[int, Query(ge=0, le=16)] = 5) -> dict:
    """Groups of visually near-identical images (perceptual dHash within
    `threshold` bits). Useful for proposing rejects."""
    from viberoom.catalog.stacks import find_duplicates

    lib = state.require_library()
    return find_duplicates(state.db(), lib, threshold=threshold)


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


class IPTCIn(BaseModel):
    title: str | None = None
    caption: str | None = None
    copyright: str | None = None
    creator: str | None = None


@api.get("/images/{image_id}/iptc")
def get_iptc(image_id: str) -> dict:
    return load_sidecar(_image_path(image_id)).iptc.model_dump(mode="json")


@api.put("/images/{image_id}/iptc")
def set_iptc(image_id: str, body: IPTCIn) -> dict:
    """Set IPTC-style descriptive metadata. Fields set to null are cleared;
    omitted fields keep their value. Embedded in exports and written to XMP."""
    from viberoom.recipe.sidecar import IPTC

    path = _image_path(image_id)
    current = load_sidecar(path).iptc.model_dump()
    current.update(body.model_dump(exclude_unset=True))
    _update_sidecar(image_id, iptc=IPTC(**current))
    return current


@api.get("/images/{image_id}/xmp")
def get_xmp(image_id: str) -> dict:
    """Parse a foreign .xmp sidecar next to the image (if any)."""
    from viberoom.xmp import find_xmp, read_xmp

    path = _image_path(image_id)
    xmp_file = find_xmp(path)
    if xmp_file is None:
        return {"path": None, "data": {}}
    return {"path": str(xmp_file), "data": read_xmp(xmp_file)}


@api.post("/images/{image_id}/xmp/write")
def write_xmp_endpoint(image_id: str) -> dict:
    """Write <image>.xmp with the current rating/label/keywords/IPTC so
    Lightroom-family tools can read viberoom's organize state."""
    from viberoom.xmp import write_xmp

    path = _image_path(image_id)
    sc = load_sidecar(path)
    out = write_xmp(
        path.with_name(path.name + ".xmp"),
        rating=sc.rating, label=sc.label, keywords=sc.keywords,
        title=sc.iptc.title, caption=sc.iptc.caption,
        copyright=sc.iptc.copyright, creator=sc.iptc.creator,
    )
    return {"path": str(out)}


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


class CropAspectIn(BaseModel):
    aspect: str | float = Field(
        description="Target aspect as width:height — '3:2', '16:9', or a number like 1.5."
    )
    orientation: Literal["landscape", "portrait", "auto"] = Field(
        default="auto", description="auto matches the image's own orientation."
    )


@api.post("/images/{image_id}/crop")
def set_crop_aspect(image_id: str, body: CropAspectIn) -> dict:
    """Helper: set the largest centered crop with a given aspect ratio.
    (For full manual control, patch geometry.crop directly.)"""
    if isinstance(body.aspect, str):
        try:
            wpart, hpart = body.aspect.split(":")
            aspect = float(wpart) / float(hpart)
        except (ValueError, ZeroDivisionError):
            raise HTTPException(422, f"bad aspect {body.aspect!r}; use '3:2' or a number")
    else:
        aspect = float(body.aspect)
    if not (0.1 <= aspect <= 10):
        raise HTTPException(422, "aspect out of range")

    rows = state.db().query("SELECT width, height FROM images WHERE id=?", (image_id,))
    if not rows or not rows[0]["width"] or not rows[0]["height"]:
        raise HTTPException(422, "image dimensions unknown; rescan the library")
    w, h = rows[0]["width"], rows[0]["height"]
    sc = load_sidecar(_image_path(image_id))
    if sc.recipe.geometry.orientation in (90, 270):
        w, h = h, w
    img_aspect = w / h
    if body.orientation == "portrait" or (body.orientation == "auto" and img_aspect < 1):
        aspect = min(aspect, 1 / aspect)
    else:
        aspect = max(aspect, 1 / aspect)

    if aspect >= img_aspect:  # target is wider: full width, trim height
        frac = img_aspect / aspect
        crop = Crop(left=0, top=(1 - frac) / 2, right=1, bottom=(1 + frac) / 2)
    else:  # target is taller: full height, trim width
        frac = aspect / img_aspect
        crop = Crop(left=(1 - frac) / 2, top=0, right=(1 + frac) / 2, bottom=1)
    recipe = sc.recipe.model_copy(deep=True)
    recipe.geometry.crop = crop
    _update_sidecar(image_id, recipe=recipe)
    return recipe.geometry.model_dump(mode="json")


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

#: Rendered imagery is addressed by a key that already covers the file mtime,
#: the recipe and the pipeline version, so a given URL+ETag pair can never
#: describe different pixels. That makes the response genuinely immutable and
#: lets the browser skip revalidation entirely for a year.
_IMMUTABLE = "private, max-age=31536000, immutable"


def _etag_response(
    request: Request, data: bytes, etag_key: str, media_type: str, **headers: str
) -> Response:
    """Response with an ETag, answering 304 when the client already has it.

    Without this every navigation re-downloaded all 500 grid thumbnails: the
    bytes were disk-cached server-side but nothing told the browser it could
    reuse what it already had.
    """
    etag = f'"{hashlib.sha1(etag_key.encode()).hexdigest()}"'
    common = {"ETag": etag, "Cache-Control": _IMMUTABLE, **headers}

    if request.headers.get("if-none-match") == etag:
        return Response(status_code=304, headers=common)
    return Response(content=data, media_type=media_type, headers=common)


def _image_response(request: Request, data: bytes, etag_key: str, **headers: str) -> Response:
    """JPEG flavor of `_etag_response` — the shape nearly every route wants."""
    return _etag_response(request, data, etag_key, "image/jpeg", **headers)


@api.get("/images/{image_id}/thumbnail")
def thumbnail(image_id: str, request: Request) -> Response:
    lib = state.require_library()
    path = _image_path(image_id)
    key = f"thumb-{image_id}-{path.stat().st_mtime_ns}"
    cached = lib.cache_dir / f"{key}.jpg"

    # Answer the conditional request before touching the disk at all — a warm
    # grid then costs one stat() per image instead of a JPEG read and resend.
    if request.headers.get("if-none-match"):
        probe = _image_response(request, b"", key)
        if probe.status_code == 304:
            return probe

    if cached.exists():
        data = cached.read_bytes()
    else:
        data = extract_thumbnail(path)
        cached.write_bytes(data)
    return _image_response(request, data, key)


@api.get("/images/{image_id}/preview")
def preview(
    image_id: str,
    request: Request,
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

    # The disk cache key already hashes path, mtime, recipe and pipeline
    # version — exactly the identity an ETag needs — so reuse it rather than
    # inventing a second, subtly different one.
    key = preview_cache_key(path, recipe, size)
    if request.headers.get("if-none-match"):
        probe = _image_response(request, b"", key)
        if probe.status_code == 304:
            return probe

    data = render_preview(path, recipe, size, lib.cache_dir)
    return _image_response(request, data, key, **{"X-Recipe-Hash": key})


@api.get("/images/{image_id}/source")
def source(
    image_id: str,
    request: Request,
    size: Annotated[int, Query(ge=256, le=4096)] = 1600,
    format: Literal["rgb9e5", "rgba16f"] = "rgb9e5",
) -> Response:
    """The decoded linear frame as raw WebGL texture bytes.

    This is what lets the browser run the pointwise half of the pipeline
    itself, so a slider drag costs a shader pass instead of a render and a
    JPEG download. `size` means what it means for /preview, and the frame
    comes back at the resolution the server would have *rendered* that
    preview at — X-Source-Width/Height report it, and the client must honor
    them or its frame is a different image from the one it settles to.

    Deliberately uncompressed: the payload is float mantissas, so gzip finds
    about 5% for a couple hundred milliseconds of CPU, over loopback.
    """
    from viberoom.engine.cache import PIPELINE_VERSION
    from viberoom.engine.source import cached_source_dims, source_bytes

    lib = state.require_library()
    path = _image_path(image_id)
    key = f"source-v{PIPELINE_VERSION}|{path}|{path.stat().st_mtime_ns}|{size}|{format}"

    def _headers(w: int, h: int) -> dict[str, str]:
        return {
            "X-Source-Width": str(w),
            "X-Source-Height": str(h),
            "X-Source-Format": format,
            "X-Pipeline-Version": str(PIPELINE_VERSION),
        }

    # Answer the conditional request before decoding anything. The dimensions
    # still ship on the 304 so a client that revalidates rather than reusing
    # its own cached headers is not left guessing.
    if request.headers.get("if-none-match"):
        dims = cached_source_dims(path, size, format, lib.cache_dir)
        if dims is not None:
            probe = _etag_response(
                request, b"", key, "application/octet-stream", **_headers(*dims)
            )
            if probe.status_code == 304:
                return probe

    data, w, h = source_bytes(path, size, format, lib.cache_dir)
    return _etag_response(
        request, data, key, "application/octet-stream", **_headers(w, h)
    )


@api.get("/images/{image_id}/proof")
def soft_proof(
    image_id: str,
    request: Request,
    space: Literal["display-p3", "adobe-rgb", "prophoto"] = "display-p3",
    warn: bool = False,
    size: Annotated[int, Query(ge=256, le=4096)] = 1600,
) -> Response:
    """Soft proof: simulate how the edited image survives conversion to a
    target color space, rendered back to sRGB for display. warn=true paints
    out-of-gamut pixels magenta. (The working space is sRGB, so wide-gamut
    targets rarely clip; the endpoint exists for the day decode goes wide.)"""
    import io as _io

    import numpy as np

    from viberoom.color_mgmt import convert_from_srgb
    from viberoom.engine.cache import _decode_cache
    from viberoom.engine.pipeline import render_float

    lib = state.require_library()
    path = _image_path(image_id)
    recipe = load_sidecar(path).recipe

    # Proofing was the one preview endpoint with no disk cache, so every poll
    # of the same unchanged image paid for a full render plus a colour-space
    # conversion. The space and warn flags are part of the identity here.
    key = preview_cache_key(path, recipe, size) + f"|proof|{space}|{warn}"
    digest = hashlib.sha1(key.encode()).hexdigest()
    if request.headers.get("if-none-match"):
        probe = _image_response(request, b"", key)
        if probe.status_code == 304:
            return probe

    cached = lib.cache_dir / f"proof-{digest}.jpg"
    meta = lib.cache_dir / f"proof-{digest}.oog"
    if cached.exists() and meta.exists():
        return _image_response(
            request, cached.read_bytes(), key,
            **{"X-Out-Of-Gamut-Percent": meta.read_text()},
        )

    linear = _decode_cache.get(path, half_size=True)
    rendered = render_float(linear, recipe)
    proofed, oog = convert_from_srgb(rendered, space)
    # Show the proofed pixels — the whole point of the endpoint. This
    # previously encoded `rendered`, quietly returning the unproofed image.
    out = proofed.copy() if warn else proofed
    if warn:
        out[oog] = [1.0, 0.0, 1.0]
    from PIL import Image as PILImage

    im = PILImage.fromarray((np.clip(out, 0, 1) * 255).round().astype("uint8"))
    im.thumbnail((size, size), PILImage.LANCZOS)
    buf = _io.BytesIO()
    im.save(buf, "JPEG", quality=90)
    data = buf.getvalue()

    percent = f"{float(oog.mean()) * 100:.3f}"
    cached.write_bytes(data)
    meta.write_text(percent)
    return _image_response(request, data, key, **{"X-Out-Of-Gamut-Percent": percent})


# ---------- ML: enhance (denoise / super-resolution) + faces ----------

class EnhanceIn(BaseModel):
    model: str = Field(description="An ONNX model name from ~/.viberoom/models (see /models).")
    tile: int = Field(default=512, ge=128, le=2048)


@api.get("/models")
def list_ml_models() -> dict:
    from viberoom.ml import MODELS_DIR, list_models

    return {"models": list_models(), "dir": str(MODELS_DIR)}


@api.post("/images/{image_id}/enhance")
def enhance_image(image_id: str, body: EnhanceIn) -> dict:
    """Run an image-to-image ONNX model (denoise, super-resolution) over the
    decoded original, tiled; the result joins the library as a 16-bit PNG
    with the source's recipe copied over (like Lightroom's Denoise DNG)."""
    from viberoom import ml
    from viberoom.engine.decode import decode_linear, linear_to_srgb
    from viberoom.export import _write_png16

    lib = state.require_library()
    src = _image_path(image_id)
    try:
        base = linear_to_srgb(decode_linear(src, half_size=False))
        result = ml.run_image_model(base, body.model, tile=body.tile)
    except ml.MLUnavailable as e:
        raise HTTPException(503, str(e))
    out = src.with_name(f"{src.stem}-enhanced.png")
    i = 1
    while out.exists():
        out = src.with_name(f"{src.stem}-enhanced-{i}.png")
        i += 1
    _write_png16((result * 65535).round().astype("uint16"), out)
    sc = load_sidecar(src)
    save_sidecar(out, sc.model_copy(update={"history": [], "snapshots": {}, "variants": {}}))
    scan(lib, state.db())
    from viberoom.catalog.scanner import image_id as make_id

    try:
        rel = str(out.relative_to(lib.root))
    except ValueError:
        rel = str(out)  # extra-root files are indexed by absolute path
    return {"id": make_id(rel), "path": str(out), "scale": result.shape[0] // base.shape[0]}


@api.post("/faces/setup")
def faces_setup() -> dict:
    """Download the UltraFace detector (~1.2 MB) into ~/.viberoom/models."""
    from viberoom import ml

    try:
        ml.get_ort()
        path = ml.download_ultraface()
    except ml.MLUnavailable as e:
        raise HTTPException(503, str(e))
    except OSError as e:
        raise HTTPException(502, f"model download failed: {e}")
    return {"model": str(path)}


class FacesScanIn(BaseModel):
    image_ids: list[str] | None = Field(default=None, description="Default: whole library.")
    threshold: float = Field(default=0.7, ge=0.1, le=0.99)


@api.post("/faces/scan")
def faces_scan(body: FacesScanIn | None = None) -> dict:
    """Detect faces and store per-image counts/boxes; then filter with
    /images?has_faces=true or faces_gte=N."""
    from viberoom import ml
    from viberoom.engine.cache import _decode_cache
    from viberoom.engine.decode import linear_to_srgb

    state.require_library()
    b = body or FacesScanIn()
    ids = b.image_ids or [r["id"] for r in state.db().query("SELECT id FROM images")]
    scanned, with_faces, errors = 0, 0, []
    paths = _image_paths(ids)  # one query instead of one per image
    for iid in ids:
        try:
            path = paths.get(iid)
            if path is None:
                raise HTTPException(404, f"unknown image id {iid}")
            img = linear_to_srgb(_decode_cache.get(path, half_size=True))
            faces = ml.detect_faces(img, threshold=b.threshold)
        except ml.MLUnavailable as e:
            raise HTTPException(503, str(e))
        except HTTPException as e:
            errors.append({"id": iid, "error": e.detail})
            continue
        except Exception as e:
            errors.append({"id": iid, "error": str(e)})
            continue
        state.db().execute(
            "UPDATE images SET faces_json=? WHERE id=?", (json.dumps(faces), iid)
        )
        scanned += 1
        with_faces += bool(faces)
    return {"scanned": scanned, "with_faces": with_faces, "errors": errors}


@api.get("/map")
def map_points(
    lat_min: float = -90, lat_max: float = 90,
    lon_min: float = -180, lon_max: float = 180,
    limit: Annotated[int, Query(ge=1, le=5000)] = 2000,
) -> dict:
    """GPS points for all geotagged images (optionally within a bounding
    box) — the data layer for a map view."""
    state.require_library()
    rows = state.db().query(
        "SELECT id, filename, gps_lat, gps_lon, taken_at, rating FROM images"
        " WHERE gps_lat IS NOT NULL AND gps_lat BETWEEN ? AND ?"
        " AND gps_lon BETWEEN ? AND ? LIMIT ?",
        (lat_min, lat_max, lon_min, lon_max, limit),
    )
    return {"points": [dict(r) for r in rows]}


# ---------- HDR / panorama merge ----------

class MergeIn(BaseModel):
    image_ids: list[str] = Field(min_length=2, max_length=12)
    out_name: str | None = Field(default=None, description="Output stem; defaults to hdr-/pano-<first>.")


def _merge(kind: Literal["hdr", "pano"], body: MergeIn) -> dict:
    from viberoom.export import _write_png16
    from viberoom.merge import merge_hdr, merge_pano

    lib = state.require_library()
    resolved = _image_paths(body.image_ids)
    for iid in body.image_ids:
        if iid not in resolved:
            raise HTTPException(404, f"unknown image id {iid}")
    paths = [resolved[iid] for iid in body.image_ids]
    fused = merge_hdr(paths) if kind == "hdr" else merge_pano(paths)
    name = body.out_name or f"{kind}-{paths[0].stem}"
    if not _VERSION_NAME_RE.match(name):
        raise HTTPException(422, "out_name must be 1-64 word characters")
    out = lib.root / f"{name}.png"
    i = 1
    while out.exists():
        out = lib.root / f"{name}-{i}.png"
        i += 1
    _write_png16((fused * 65535).round().astype("uint16"), out)
    scan(lib, state.db())
    from viberoom.catalog.scanner import image_id as make_id

    new_id = make_id(str(out.relative_to(lib.root)))
    return {"id": new_id, "path": str(out), "width": fused.shape[1], "height": fused.shape[0]}


@api.post("/merge/hdr")
def merge_hdr_endpoint(body: MergeIn) -> dict:
    """Exposure-fuse a bracketed set (align by phase correlation, Mertens
    weights) into a 16-bit PNG that joins the library as a new image."""
    return _merge("hdr", body)


@api.post("/merge/pano")
def merge_pano_endpoint(body: MergeIn) -> dict:
    """Stitch a left-to-right pan (translation-only alignment with feathered
    blending — best on tripod pans) into a 16-bit PNG in the library."""
    return _merge("pano", body)


# ---------- export ----------

class WatermarkIn(BaseModel):
    text: str | None = None
    image: str | None = Field(default=None, description="Path to a PNG overlay.")
    position: Literal[
        "bottom-right", "bottom-left", "top-right", "top-left", "center", "bottom-center"
    ] = "bottom-right"
    opacity: float = Field(default=60, ge=0, le=100)
    scale: float = Field(default=20, ge=1, le=100, description="Width as % of the long edge.")
    margin: float = Field(default=2.5, ge=0, le=25)


class ExportIn(BaseModel):
    format: ExportFormat = "jpeg"
    quality: int = Field(default=90, ge=1, le=100, description="JPEG only.")
    bit_depth: Literal[8, 16] = Field(default=8, description="16 is PNG only.")
    max_dimension: int | None = Field(default=None, ge=64, le=20000)
    color_space: Literal["srgb", "display-p3", "adobe-rgb", "prophoto"] = "srgb"
    watermark: WatermarkIn | None = None
    output_sharpen: Literal["screen", "matte", "glossy"] | None = None
    variant: str | None = Field(default=None, description="Export a virtual copy's recipe.")
    preset: str | None = Field(
        default=None, description="Export preset name; explicit fields override its settings."
    )
    dest_dir: str | None = Field(
        default=None,
        description="Directory to write into. Defaults to <library>/exports.",
    )
    path: str | None = None


def _resolve_export_preset(body: ExportIn, extra_exclude: set[str] | None = None) -> ExportIn:
    """Merge a named export preset under the request's explicitly-set fields."""
    if not body.preset:
        return ExportIn(**body.model_dump(exclude=(extra_exclude or set()) | {"preset"}))
    from viberoom.export_extras import load_export_preset

    try:
        settings = load_export_preset(body.preset)
    except KeyError:
        raise HTTPException(404, f"no export preset named {body.preset!r}")
    explicit = body.model_dump(exclude_unset=True, exclude=(extra_exclude or set()) | {"preset"})
    try:
        return ExportIn(**{**settings, **explicit})
    except ValidationError as e:
        raise HTTPException(422, e.errors(include_url=False))


def _export_base(body: ExportIn, lib) -> Path:
    """Where exports land: the chosen folder, else <library>/exports."""
    return Path(body.dest_dir).expanduser() if body.dest_dir else lib.exports_dir


def _export_one(image_id: str, body: ExportIn, filename: str | None = None, seq: int = 1) -> dict:
    lib = state.require_library()
    src = _image_path(image_id)
    if body.bit_depth == 16 and body.format != "png":
        raise HTTPException(422, "bit_depth 16 is only supported for png")
    sc = load_sidecar(src)
    recipe = _recipe_for_variant(sc, body.variant)
    suffix = f"-{body.variant}" if body.variant else ""
    if body.path:
        out = Path(body.path).expanduser()
    elif filename:
        from viberoom.export_extras import render_filename

        rows = state.db().query("SELECT rating, taken_at FROM images WHERE id=?", (image_id,))
        try:
            rel = render_filename(
                filename, name=src.stem + suffix, seq=seq,
                rating=rows[0]["rating"] if rows else 0,
                taken_at=rows[0]["taken_at"] if rows else None,
                ext=default_extension(body.format),
            )
        except (ValueError, KeyError, IndexError) as e:
            raise HTTPException(422, f"bad filename template: {e}")
        out = _export_base(body, lib) / rel
    else:
        out = _export_base(body, lib) / (src.stem + suffix + default_extension(body.format))
    result = export_file(
        src, recipe, out, body.format,
        quality=body.quality, bit_depth=body.bit_depth, max_dimension=body.max_dimension,
        iptc=sc.iptc.model_dump(), color_space=body.color_space,
        watermark=body.watermark.model_dump() if body.watermark else None,
        output_sharpen=body.output_sharpen,
    )
    return {"id": image_id, "path": str(result), "format": body.format}


@api.post("/images/{image_id}/export")
def export_image(image_id: str, body: ExportIn) -> dict:
    return _export_one(image_id, _resolve_export_preset(body))


# ---------- export presets ----------

class ExportPresetIn(BaseModel):
    settings: dict = Field(description="ExportIn-shaped settings (format, quality, watermark, ...).")


@api.get("/export-presets")
def list_export_presets_endpoint() -> dict:
    from viberoom.export_extras import list_export_presets

    return {"presets": list_export_presets()}


@api.put("/export-presets/{name}")
def save_export_preset_endpoint(name: str, body: ExportPresetIn) -> dict:
    from viberoom.export_extras import ExportPresetError, save_export_preset

    try:
        ExportIn(**{k: v for k, v in body.settings.items() if k != "preset"})
    except (ValidationError, TypeError) as e:
        raise HTTPException(422, f"invalid export settings: {e}")
    try:
        return save_export_preset(name, body.settings)
    except ExportPresetError as e:
        raise HTTPException(422, str(e))


@api.delete("/export-presets/{name}")
def delete_export_preset_endpoint(name: str) -> dict:
    from viberoom.export_extras import ExportPresetError, delete_export_preset

    try:
        delete_export_preset(name)
    except KeyError:
        raise HTTPException(404, f"no export preset named {name!r}")
    except ExportPresetError as e:
        raise HTTPException(422, str(e))
    return {"deleted": name}


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
    filename: str | None = Field(
        default=None,
        description="Filename template with {name} {seq} {rating} {date} {ext}; may contain '/'.",
    )


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
    single = _resolve_export_preset(body, extra_exclude={"image_ids", "filename"})
    counter = {"n": 0}

    def one(iid: str) -> dict:
        counter["n"] += 1
        return _export_one(iid, single, filename=body.filename, seq=counter["n"])

    return _batch(body.image_ids, one)


# ---------- LUTs ----------

class LutIn(BaseModel):
    content: str = Field(description="The .cube file contents.")


@api.get("/luts")
def list_luts() -> dict:
    from viberoom.engine.ops.lut import LUTS_DIR

    if not LUTS_DIR.is_dir():
        return {"luts": []}
    return {"luts": sorted(p.stem for p in LUTS_DIR.glob("*.cube"))}


@api.put("/luts/{name}")
def save_lut(name: str, body: LutIn) -> dict:
    """Install a .cube LUT (1D or 3D). Reference it from a recipe as
    color.lut {name, strength, stage: 'pre' (camera profile) | 'post' (look)}."""
    from viberoom.engine.ops.lut import LUTS_DIR, LutError, parse_cube

    _check_version_name(name)
    try:
        kind, data = parse_cube(body.content)
    except LutError as e:
        raise HTTPException(422, str(e))
    LUTS_DIR.mkdir(parents=True, exist_ok=True)
    (LUTS_DIR / f"{name}.cube").write_text(body.content)
    return {"name": name, "kind": kind, "size": int(data.shape[0])}


@api.delete("/luts/{name}")
def delete_lut(name: str) -> dict:
    from viberoom.engine.ops.lut import LUTS_DIR

    _check_version_name(name)
    p = LUTS_DIR / f"{name}.cube"
    if not p.exists():
        raise HTTPException(404, f"no LUT named {name!r}")
    p.unlink()
    return {"deleted": name}


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
import sys

if getattr(sys, "frozen", False):
    # PyInstaller bundle (desktop app): dist is packaged next to the extracted files
    _frontend_dist = Path(getattr(sys, "_MEIPASS", ".")) / "frontend" / "dist"
else:
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

    port = int(os.environ.get("VIBEROOM_PORT", "8423"))  # VIBE on a phone keypad
    # pass the app object (not an import string): required under PyInstaller,
    # equivalent otherwise since we don't use reload workers
    uvicorn.run(app, host="127.0.0.1", port=port)
