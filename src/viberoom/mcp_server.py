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
    has_edits: bool | None = None,
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
    EXIF capture time. Returns metadata including each image's id, which all
    other tools take."""
    params = {k: v for k, v in {
        "rating_gte": rating_gte, "flag": flag, "label": label, "keyword": keyword,
        "camera": camera, "lens": lens, "iso_gte": iso_gte, "iso_lte": iso_lte,
        "taken_after": taken_after, "taken_before": taken_before, "q": q,
        "has_edits": has_edits, "sort": sort, "order": order,
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
                 crop: {left,top,right,bottom: 0-1 normalized}}
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
def render_preview(image_id: str, size: int = 1024) -> MCPImage:
    """Render the image WITH its current edits applied and return the JPEG so
    you can visually inspect the result. size = longest edge in px (256-4096)."""
    data = _call("GET", f"/images/{image_id}/preview", params={"size": size}).content
    return MCPImage(data=data, format="jpeg")


@mcp.tool()
def export_image(
    image_id: str,
    format: Literal["jpeg", "png", "tiff"] = "jpeg",
    quality: int = 90,
    bit_depth: Literal[8, 16] = 8,
    max_dimension: int | None = None,
    path: str | None = None,
) -> dict:
    """Export the edited image in sRGB. quality 1-100 (JPEG); bit_depth 16 is
    PNG-only; max_dimension resizes the longest edge; path overrides the
    default <library>/exports/ destination. Returns the written file path."""
    body = {"format": format, "quality": quality, "bit_depth": bit_depth,
            "max_dimension": max_dimension, "path": path}
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
) -> dict:
    """Export many images to <library>/exports/ in one call."""
    body = {"image_ids": image_ids, "format": format, "quality": quality,
            "bit_depth": bit_depth, "max_dimension": max_dimension}
    return _call("POST", "/batch/export", json=body).json()


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
