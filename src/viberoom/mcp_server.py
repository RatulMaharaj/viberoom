"""MCP server: thin typed wrapper over the viberoom REST API so any
MCP-capable agent (Claude Code, etc.) can drive the library and edits.

Run with the REST server already up:
    uv run viberoom-mcp            # talks to http://127.0.0.1:8000

Register with Claude Code:
    claude mcp add viberoom -- uv --directory /path/to/viberoom run viberoom-mcp
"""

from __future__ import annotations

import os
from typing import Any, Literal

import httpx
from mcp.server.mcpserver import Image as MCPImage
from mcp.server.mcpserver import MCPServer

BASE = os.environ.get("VIBEROOM_URL", "http://127.0.0.1:8423") + "/api/v1"

mcp = MCPServer("viberoom")
_client = httpx.Client(base_url=BASE, timeout=120)


def _call(method: str, path: str, **kwargs) -> Any:
    r = _client.request(method, path, **kwargs)
    if r.status_code >= 400:
        raise RuntimeError(f"viberoom API {r.status_code}: {r.text}")
    return r


@mcp.tool()
def set_library(path: str) -> dict:
    """Open a local folder as the photo library and scan it for images."""
    return _call("POST", "/library", json={"path": path}).json()


@mcp.tool()
def library_roots(
    action: Literal["list", "add", "remove"] = "list", path: str | None = None
) -> dict:
    """The catalog can span multiple folders (any drive). 'list' shows the
    primary + extra roots; 'add'/'remove' manage extra roots (rescans)."""
    if action == "list":
        return _call("GET", "/library/roots").json()
    if action == "add":
        return _call("POST", "/library/roots", json={"path": path}).json()
    return _call("DELETE", "/library/roots", params={"path": path}).json()


@mcp.tool()
def import_photos(
    source: str,
    move: bool = False,
    rename: str = "{name}{ext}",
    backup_dir: str | None = None,
    dedupe: bool = True,
    rating: int | None = None,
    keywords: list[str] | None = None,
    preset: str | None = None,
) -> dict:
    """Import images from a folder (memory card, downloads) into the library.
    rename is a filename template (may contain '/' for subfolders) with
    {name} {ext} {date} {time} {seq}; dedupe skips files whose content already
    exists in the library; backup_dir copies originals there first; rating/
    keywords/preset are applied to each imported image."""
    body = {"source": source, "move": move, "rename": rename,
            "backup_dir": backup_dir, "dedupe": dedupe, "rating": rating,
            "keywords": keywords or [], "preset": preset}
    return _call("POST", "/import", json=body).json()


@mcp.tool()
def list_images(
    rating_gte: int | None = None,
    flag: Literal["pick", "reject", "none"] | None = None,
    label: Literal["red", "yellow", "green", "blue", "purple", "none"] | None = None,
    keyword: str | None = None,
    camera: str | None = None,
    lens: str | None = None,
    iso_gte: int | None = None,
    iso_lte: int | None = None,
    taken_after: str | None = None,
    taken_before: str | None = None,
    q: str | None = None,
    folder: str | None = None,
    has_edits: bool | None = None,
    has_gps: bool | None = None,
    faces_gte: int | None = None,
    collection: str | None = None,
    stacks: Literal["collapse"] | None = None,
    sort: Literal["filename", "mtime", "rating", "taken_at"] = "filename",
    order: Literal["asc", "desc"] = "asc",
    limit: int = 200,
    offset: int = 0,
) -> dict:
    """List images in the library with optional filters.

    rating_gte: only images rated >= this (0-5). flag: 'pick'/'reject'/'none'.
    label: color label or 'none' for unlabeled. keyword: exact keyword
    (case-insensitive). camera/lens/q: substring match (q searches filenames).
    taken_after/taken_before: 'YYYY-MM-DD' or 'YYYY-MM-DD HH:MM:SS' against
    EXIF capture time. folder: rel-path prefix. collection: restrict to a
    collection. stacks='collapse': one frame per stack. Returns metadata
    including each image's id, which all other tools take."""
    params = {k: v for k, v in {
        "rating_gte": rating_gte, "flag": flag, "label": label, "keyword": keyword,
        "camera": camera, "lens": lens, "iso_gte": iso_gte, "iso_lte": iso_lte,
        "taken_after": taken_after, "taken_before": taken_before, "q": q,
        "folder": folder, "has_edits": has_edits, "has_gps": has_gps,
        "faces_gte": faces_gte, "collection": collection,
        "stacks": stacks, "sort": sort, "order": order,
        "limit": limit, "offset": offset,
    }.items() if v is not None}
    return _call("GET", "/images", params=params).json()


@mcp.tool()
def get_current_image() -> dict:
    """The image the user currently has selected/open in the Viberoom web UI
    (or image_id: null if nothing is selected). Use this when the user says
    'this image' / 'my current image'."""
    return _call("GET", "/session/current").json()


@mcp.tool()
def get_image(image_id: str) -> dict:
    """Full metadata for one image: path, EXIF, rating, flag, edit status."""
    return _call("GET", f"/images/{image_id}").json()


@mcp.tool()
def set_rating(image_id: str, rating: int) -> dict:
    """Set the star rating, 0 (unrated) to 5."""
    return _call("PUT", f"/images/{image_id}/rating", json={"rating": rating}).json()


@mcp.tool()
def set_flag(image_id: str, flag: Literal["pick", "reject"] | None) -> dict:
    """Flag an image as 'pick' or 'reject', or None to unflag."""
    return _call("PUT", f"/images/{image_id}/flag", json={"flag": flag}).json()


@mcp.tool()
def set_label(
    image_id: str, label: Literal["red", "yellow", "green", "blue", "purple"] | None
) -> dict:
    """Set the color label, or None to clear it."""
    return _call("PUT", f"/images/{image_id}/label", json={"label": label}).json()


@mcp.tool()
def edit_keywords(
    image_id: str,
    add: list[str] | None = None,
    remove: list[str] | None = None,
) -> dict:
    """Add and/or remove keywords (tags) on an image. Case-insensitive dedupe."""
    body = {"add": add or [], "remove": remove or []}
    return _call("PATCH", f"/images/{image_id}/keywords", json=body).json()


@mcp.tool()
def list_keywords() -> dict:
    """All distinct keywords in the library with usage counts."""
    return _call("GET", "/keywords").json()


@mcp.tool()
def set_iptc(
    image_id: str,
    title: str | None = None,
    caption: str | None = None,
    copyright: str | None = None,
    creator: str | None = None,
) -> dict:
    """Set IPTC-style descriptive metadata (embedded in exports, written to
    XMP). Omitted fields keep their current value."""
    body = {k: v for k, v in {"title": title, "caption": caption,
                               "copyright": copyright, "creator": creator}.items()
            if v is not None}
    return _call("PUT", f"/images/{image_id}/iptc", json=body).json()


@mcp.tool()
def write_xmp(image_id: str) -> dict:
    """Write <image>.xmp with the current rating/label/keywords/IPTC so
    Lightroom-family tools can read viberoom's organize state. (Foreign .xmp
    files are read automatically at scan time for images without edits.)"""
    return _call("POST", f"/images/{image_id}/xmp/write").json()


@mcp.tool()
def collections(
    action: Literal["list", "save", "delete", "add_images", "remove_images"],
    name: str | None = None,
    type: Literal["static", "smart"] | None = None,
    ids: list[str] | None = None,
    query: dict | None = None,
) -> dict:
    """Manage collections; filter with list_images(collection=name).
    'save' creates/replaces: static needs ids, smart needs a query using
    list_images filter keys (e.g. {"rating_gte": 4, "flag": "pick"}).
    'add_images'/'remove_images' edit a static collection's members (pass ids)."""
    if action == "list":
        return _call("GET", "/collections").json()
    if action == "save":
        return _call("PUT", f"/collections/{name}",
                     json={"type": type, "ids": ids, "query": query}).json()
    if action == "delete":
        return _call("DELETE", f"/collections/{name}").json()
    body = {"add": ids or []} if action == "add_images" else {"remove": ids or []}
    return _call("POST", f"/collections/{name}/images", json=body).json()


@mcp.tool()
def auto_stack(gap_seconds: float = 2.0, raw_jpeg: bool = True) -> dict:
    """Auto-stack burst sequences (capture times within gap_seconds) and
    RAW+JPEG pairs. Then list_images(stacks='collapse') shows one frame per
    stack. Replaces existing stacks."""
    return _call("POST", "/stacks/auto",
                 json={"gap_seconds": gap_seconds, "raw_jpeg": raw_jpeg}).json()


@mcp.tool()
def stack(image_ids: list[str] | None = None, unstack_id: str | None = None) -> dict:
    """Manually stack images (first id becomes leader), or pass unstack_id
    (a stack's leader id) to dissolve that stack."""
    if unstack_id:
        return _call("DELETE", f"/stacks/{unstack_id}").json()
    return _call("POST", "/stacks", json={"image_ids": image_ids}).json()


@mcp.tool()
def find_duplicates(threshold: int = 5) -> dict:
    """Groups of visually near-identical images (perceptual hash within
    `threshold` bits, 0-16). Useful for proposing rejects."""
    return _call("GET", "/duplicates", params={"threshold": threshold}).json()


@mcp.tool()
def get_recipe(image_id: str) -> dict:
    """Get the image's current non-destructive edit recipe (JSON)."""
    return _call("GET", f"/images/{image_id}/recipe").json()


@mcp.tool()
def update_recipe(image_id: str, patch: dict) -> dict:
    """Merge a partial recipe into the image's edit recipe (the usual way to
    edit). Only supply the fields you want to change; everything else keeps
    its value. Note: lists (toneCurve points, masks) replace wholesale, so
    send the full masks array when editing masks. Ranges (Lightroom-style):

    - whiteBalance: {temp: 2000-50000 Kelvin (null=as-shot), tint: -150..150 (+magenta)}
    - tone: {exposure: -5..5 EV, contrast/highlights/shadows/whites/blacks: -100..100,
             texture/clarity/dehaze: -100..100,
             toneCurve: {points: [[in,out],...] 0-255 increasing;
                          red/green/blue: per-channel curves, same format}}
    - color: {saturation/vibrance: -100..100,
              hsl: {red|orange|yellow|green|aqua|blue|purple|magenta:
                    {hue/saturation/luminance: -100..100}},
              grading: {shadows|midtones|highlights: {hue: 0-360, saturation: 0-100,
                         luminance: -100..100}, blending: 0-100, balance: -100..100}}
    - detail: {sharpening: {amount: 0-150, radius: 0.5-3, detail: 0-100},
               noiseReduction: {luminance: 0-100, color: 0-100}}
    - geometry: {rotate: -45..45 deg, orientation: 0|90|180|270, flipH/flipV: bool,
                 perspective: {vertical/horizontal: -100..100 keystone correction,
                                scale: 50-150 zoom to hide warped borders},
                 crop: {left,top,right,bottom: 0-1 normalized}}
    - lens: {distortion: -100..100 (+ fixes barrel), vignette: -100..100
             (+ brightens corners), caRed/caBlue: -100..100 lateral CA,
             defringe: {amount: 0-100}} — applied first, pre-crop
    - color.lut: {name: installed LUT name (see luts tool), strength: 0-100,
             stage: 'pre' (camera profile) | 'post' (creative look)}
    - effects: {vignette: {amount: -100..100 (negative darkens), midpoint/feather: 0-100,
                 roundness: -100..100}, grain: {amount: 0-100, size: 0-100}}
    - masks: local adjustments; a list of masks, each {type, ...geometry, invert,
             opacity: 0-100, adjustments: {exposure: -5..5, contrast/highlights/
             shadows/temp/tint/saturation/clarity/dehaze/sharpness: -100..100}}.
             Coordinates are normalized 0-1 in the RENDERED (post-crop) frame,
             matching what render_preview shows. Types:
             {type: 'linear', start: [x,y] (full effect), end: [x,y] (zero)}
             {type: 'radial', center: [x,y], radiusX/radiusY: 0-2, feather: 0-100}
             {type: 'luminance', lumMin/lumMax: 0-100, feather: 0-100}
             {type: 'color', hue: 0-360, range: 5-180}
             {type: 'brush', strokes: [{points: [[x,y],...], radius: 0-0.5
              (fraction of short side), feather/flow: 0-100, erase: bool}]}
             {type: 'subject'|'background'|'sky'} — content-aware AI masks
              (render_preview to inspect the result)
    - retouch: heal/clone spots, list of {mode: 'heal'|'clone', source: [x,y],
             dest: [x,y], radius: 0-0.25 (fraction of short side),
             feather/opacity: 0-100}. Same post-crop coordinates as masks.

    Example: {"tone": {"clarity": 20}, "masks": [{"type": "radial",
      "center": [0.5, 0.4], "radiusX": 0.3, "radiusY": 0.25,
      "adjustments": {"exposure": 0.6}}]}
    Use get_recipe_schema for the full JSON Schema."""
    return _call("PATCH", f"/images/{image_id}/recipe", json=patch).json()


@mcp.tool()
def set_recipe(image_id: str, recipe: dict) -> dict:
    """Replace the entire edit recipe. Omitted fields reset to defaults."""
    return _call("PUT", f"/images/{image_id}/recipe", json=recipe).json()


@mcp.tool()
def auto_adjust(image_id: str, white_balance: bool = True) -> dict:
    """Computational auto-adjust: analyzes the image (exposure targeting,
    percentile tone recovery, gray-world WB) and sets whiteBalance/tone/
    vibrance. Keeps existing detail and geometry settings. Returns the new
    recipe — render_preview afterwards to judge the result."""
    return _call("POST", f"/images/{image_id}/auto", json={"white_balance": white_balance}).json()


@mcp.tool()
def reset_recipe(image_id: str) -> dict:
    """Remove all edits, restoring the image to its unedited state."""
    return _call("DELETE", f"/images/{image_id}/recipe").json()


@mcp.tool()
def render_preview(image_id: str, size: int = 1024, variant: str | None = None) -> MCPImage:
    """Render the image WITH its current edits applied and return the JPEG so
    you can visually inspect the result. size = longest edge in px (256-4096).
    variant renders a virtual copy's recipe instead of the main one."""
    params: dict = {"size": size}
    if variant:
        params["variant"] = variant
    data = _call("GET", f"/images/{image_id}/preview", params=params).content
    return MCPImage(data=data, format="jpeg")


@mcp.tool()
def get_history(image_id: str) -> dict:
    """Edit history (index + timestamp per superseded recipe, oldest first)
    plus snapshot and variant names for an image."""
    return _call("GET", f"/images/{image_id}/history").json()


@mcp.tool()
def restore_history(image_id: str, index: int) -> dict:
    """Restore a history entry as the current recipe. The replaced recipe is
    pushed to history itself, so this is always undoable."""
    return _call("POST", f"/images/{image_id}/history/{index}/restore").json()


@mcp.tool()
def snapshot(
    image_id: str, action: Literal["save", "restore", "delete"], name: str
) -> dict:
    """Named point-in-time saves of an image's recipe. 'save' stores the
    current recipe under the name; 'restore' makes that snapshot current;
    'delete' removes it. List names via get_history."""
    if action == "save":
        return _call("PUT", f"/images/{image_id}/snapshots/{name}").json()
    if action == "restore":
        return _call("POST", f"/images/{image_id}/snapshots/{name}/restore").json()
    return _call("DELETE", f"/images/{image_id}/snapshots/{name}").json()


@mcp.tool()
def variant(
    image_id: str,
    action: Literal["save", "delete", "promote"],
    name: str,
    recipe: dict | None = None,
) -> dict:
    """Virtual copies: independent named recipes for one image, renderable
    (render_preview variant=...) and exportable (export_image variant=...)
    side by side. 'save' creates/updates a variant (from `recipe`, or a copy
    of the current recipe if omitted); 'promote' makes it the main recipe;
    'delete' removes it. List names via get_history."""
    if action == "save":
        return _call("PUT", f"/images/{image_id}/variants/{name}", json={"recipe": recipe}).json()
    if action == "promote":
        return _call("POST", f"/images/{image_id}/variants/{name}/promote").json()
    return _call("DELETE", f"/images/{image_id}/variants/{name}").json()


@mcp.tool()
def export_image(
    image_id: str,
    format: Literal["jpeg", "png", "tiff"] = "jpeg",
    quality: int = 90,
    bit_depth: Literal[8, 16] = 8,
    max_dimension: int | None = None,
    color_space: Literal["srgb", "display-p3", "adobe-rgb", "prophoto"] = "srgb",
    watermark: dict | None = None,
    output_sharpen: Literal["screen", "matte", "glossy"] | None = None,
    variant: str | None = None,
    preset: str | None = None,
    path: str | None = None,
) -> dict:
    """Export the edited image. quality 1-100 (JPEG); bit_depth 16 is
    PNG-only; max_dimension resizes the longest edge; color_space embeds the
    matching ICC profile; watermark: {text|image, position, opacity, scale};
    output_sharpen tunes for the medium; variant exports a virtual copy;
    preset applies a saved export preset; path overrides the default
    <library>/exports/ destination. Returns the written file path."""
    body = {"format": format, "quality": quality, "bit_depth": bit_depth,
            "max_dimension": max_dimension, "color_space": color_space,
            "watermark": watermark, "output_sharpen": output_sharpen,
            "variant": variant, "preset": preset, "path": path}
    return _call("POST", f"/images/{image_id}/export", json=body).json()


@mcp.tool()
def batch_update_recipe(image_ids: list[str], patch: dict) -> dict:
    """Apply one recipe merge-patch to many images at once (sync settings).
    Same patch format as update_recipe."""
    return _call("POST", "/batch/recipe", json={"image_ids": image_ids, "patch": patch}).json()


@mcp.tool()
def batch_set_meta(
    image_ids: list[str],
    rating: int | None = None,
    flag: Literal["pick", "reject", "clear"] | None = None,
    label: Literal["red", "yellow", "green", "blue", "purple", "clear"] | None = None,
    add_keywords: list[str] | None = None,
    remove_keywords: list[str] | None = None,
) -> dict:
    """Set rating/flag/label and add/remove keywords on many images at once.
    flag/label take 'clear' to unset."""
    body = {"image_ids": image_ids, "rating": rating, "flag": flag, "label": label,
            "add_keywords": add_keywords or [], "remove_keywords": remove_keywords or []}
    return _call("POST", "/batch/meta", json=body).json()


@mcp.tool()
def batch_export(
    image_ids: list[str],
    format: Literal["jpeg", "png", "tiff"] = "jpeg",
    quality: int = 90,
    bit_depth: Literal[8, 16] = 8,
    max_dimension: int | None = None,
    color_space: Literal["srgb", "display-p3", "adobe-rgb", "prophoto"] = "srgb",
    watermark: dict | None = None,
    output_sharpen: Literal["screen", "matte", "glossy"] | None = None,
    preset: str | None = None,
    filename: str | None = None,
) -> dict:
    """Export many images to <library>/exports/ in one call. filename is a
    template with {name} {seq} {rating} {date} {ext} (may contain '/');
    preset applies a saved export preset (explicit fields override);
    watermark: {text|image, position, opacity, scale, margin}."""
    body = {"image_ids": image_ids, "format": format, "quality": quality,
            "bit_depth": bit_depth, "max_dimension": max_dimension,
            "color_space": color_space, "watermark": watermark,
            "output_sharpen": output_sharpen, "preset": preset, "filename": filename}
    return _call("POST", "/batch/export", json=body).json()


@mcp.tool()
def export_presets(
    action: Literal["list", "save", "delete"] = "list",
    name: str | None = None,
    settings: dict | None = None,
) -> dict:
    """Named export presets (format, quality, color_space, watermark,
    output_sharpen, ...) usable via export_image/batch_export preset=name."""
    if action == "list":
        return _call("GET", "/export-presets").json()
    if action == "save":
        return _call("PUT", f"/export-presets/{name}", json={"settings": settings}).json()
    return _call("DELETE", f"/export-presets/{name}").json()


@mcp.tool()
def soft_proof(
    image_id: str,
    space: Literal["display-p3", "adobe-rgb", "prophoto"] = "display-p3",
    warn: bool = True,
    size: int = 1024,
) -> MCPImage:
    """Preview how the edited image survives conversion to a target color
    space; warn=true paints out-of-gamut pixels magenta."""
    data = _call("GET", f"/images/{image_id}/proof",
                 params={"space": space, "warn": warn, "size": size}).content
    return MCPImage(data=data, format="jpeg")


@mcp.tool()
def tether(action: Literal["status", "capture"] = "status",
           subfolder: str = "tethered", prefix: str = "tether",
           preset: str | None = None, keywords: list[str] | None = None) -> dict:
    """Tethered capture via a USB-connected camera (needs gphoto2 installed).
    'status' reports the connected camera; 'capture' triggers the shutter,
    imports the frame into <library>/<subfolder>, applies preset/keywords,
    and returns the new image id (render_preview it to check the shot)."""
    if action == "status":
        return _call("GET", "/tether").json()
    body = {"subfolder": subfolder, "prefix": prefix, "preset": preset,
            "keywords": keywords or []}
    return _call("POST", "/tether/capture", json=body).json()


@mcp.tool()
def enhance_image(image_id: str, model: str, tile: int = 512) -> dict:
    """Run an image-to-image ONNX model (denoise, super-resolution) from
    ~/.viberoom/models over the original, tiled; the result joins the
    library as a new 16-bit PNG with the recipe copied. See GET /models for
    installed models. Needs the ml extra (onnxruntime)."""
    return _call("POST", f"/images/{image_id}/enhance",
                 json={"model": model, "tile": tile}).json()


@mcp.tool()
def scan_faces(image_ids: list[str] | None = None, threshold: float = 0.7,
               setup: bool = False) -> dict:
    """Detect faces (UltraFace via onnxruntime). setup=true first downloads
    the small detector model. After scanning, filter with
    list_images(faces_gte=1). Needs the ml extra."""
    if setup:
        _call("POST", "/faces/setup")
    body = {"image_ids": image_ids, "threshold": threshold}
    return _call("POST", "/faces/scan", json=body).json()


@mcp.tool()
def map_points(lat_min: float = -90, lat_max: float = 90,
               lon_min: float = -180, lon_max: float = 180) -> dict:
    """GPS points for geotagged images (optionally within a bounding box).
    Also: list_images(has_gps=true)."""
    return _call("GET", "/map", params={
        "lat_min": lat_min, "lat_max": lat_max,
        "lon_min": lon_min, "lon_max": lon_max,
    }).json()


@mcp.tool()
def merge_images(
    kind: Literal["hdr", "pano"],
    image_ids: list[str],
    out_name: str | None = None,
) -> dict:
    """Merge 2-12 frames into a new 16-bit PNG that joins the library as a
    normal image (with its own recipe). 'hdr' exposure-fuses a bracketed
    set (auto-aligned); 'pano' stitches a left-to-right pan (translation
    alignment — best for tripod pans). Returns the new image's id."""
    return _call("POST", f"/merge/{kind}",
                 json={"image_ids": image_ids, "out_name": out_name}).json()


@mcp.tool()
def set_crop_aspect(
    image_id: str,
    aspect: str,
    orientation: Literal["landscape", "portrait", "auto"] = "auto",
) -> dict:
    """Set the largest centered crop with a given aspect ratio ('3:2',
    '16:9', '1:1', or a number). For full manual control patch
    geometry.crop via update_recipe."""
    return _call("POST", f"/images/{image_id}/crop",
                 json={"aspect": aspect, "orientation": orientation}).json()


@mcp.tool()
def luts(
    action: Literal["list", "save", "delete"] = "list",
    name: str | None = None,
    content: str | None = None,
) -> dict:
    """Manage .cube LUTs (1D/3D) in ~/.viberoom/luts/. 'save' installs from
    the file contents in `content`. Reference from a recipe via color.lut
    {name, strength, stage} — stage 'pre' for camera-matching profiles,
    'post' for creative looks."""
    if action == "list":
        return _call("GET", "/luts").json()
    if action == "save":
        return _call("PUT", f"/luts/{name}", json={"content": content}).json()
    return _call("DELETE", f"/luts/{name}").json()


@mcp.tool()
def list_presets() -> dict:
    """List saved develop presets (named recipe merge-patches, shared across
    libraries)."""
    return _call("GET", "/presets").json()


@mcp.tool()
def save_preset(name: str, patch: dict) -> dict:
    """Save (or overwrite) a develop preset: a partial recipe that can later
    be merge-patched onto any image. Example patch:
    {"tone": {"contrast": 15, "clarity": 10}, "effects": {"grain": {"amount": 25}}}"""
    return _call("PUT", f"/presets/{name}", json={"patch": patch}).json()


@mcp.tool()
def apply_preset(name: str, image_ids: list[str]) -> dict:
    """Merge-patch a saved preset into each listed image's recipe."""
    return _call("POST", f"/presets/{name}/apply", json={"image_ids": image_ids}).json()


@mcp.tool()
def delete_preset(name: str) -> dict:
    """Delete a saved develop preset."""
    return _call("DELETE", f"/presets/{name}").json()


@mcp.tool()
def get_recipe_schema() -> dict:
    """The full JSON Schema for edit recipes (all parameters and ranges)."""
    return _call("GET", "/recipe/schema").json()


def main() -> None:
    mcp.run()
