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
    has_edits: bool | None = None,
    sort: Literal["filename", "mtime", "rating"] = "filename",
    order: Literal["asc", "desc"] = "asc",
    limit: int = 200,
    offset: int = 0,
) -> dict:
    """List images in the library with optional filters.

    rating_gte: only images rated >= this (0-5). flag: 'pick', 'reject', or
    'none' for unflagged. Returns metadata including each image's id, which
    all other tools take."""
    params = {k: v for k, v in {
        "rating_gte": rating_gte, "flag": flag, "has_edits": has_edits,
        "sort": sort, "order": order, "limit": limit, "offset": offset,
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
def get_recipe(image_id: str) -> dict:
    """Get the image's current non-destructive edit recipe (JSON)."""
    return _call("GET", f"/images/{image_id}/recipe").json()


@mcp.tool()
def update_recipe(image_id: str, patch: dict) -> dict:
    """Merge a partial recipe into the image's edit recipe (the usual way to
    edit). Only supply the fields you want to change; everything else keeps
    its value. Ranges (Lightroom-style):

    - whiteBalance: {temp: 2000-50000 Kelvin (null=as-shot), tint: -150..150 (+magenta)}
    - tone: {exposure: -5..5 EV, contrast/highlights/shadows/whites/blacks: -100..100,
             toneCurve: {points: [[in,out],...] 0-255 increasing}}
    - color: {saturation/vibrance: -100..100,
              hsl: {red|orange|yellow|green|aqua|blue|purple|magenta:
                    {hue/saturation/luminance: -100..100}}}
    - detail: {sharpening: {amount: 0-150, radius: 0.5-3, detail: 0-100},
               noiseReduction: {luminance: 0-100, color: 0-100}}
    - geometry: {rotate: -45..45 deg, orientation: 0|90|180|270, flipH/flipV: bool,
                 crop: {left,top,right,bottom: 0-1 normalized}}

    Example: {"tone": {"exposure": 0.5}, "whiteBalance": {"temp": 6500}}
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
    quality: int = 90,
    max_dimension: int | None = None,
    path: str | None = None,
) -> dict:
    """Export the edited image as an sRGB JPEG. quality 1-100; max_dimension
    resizes the longest edge; path overrides the default <library>/exports/
    destination. Returns the written file path."""
    body = {"quality": quality, "max_dimension": max_dimension, "path": path}
    return _call("POST", f"/images/{image_id}/export", json=body).json()


@mcp.tool()
def get_recipe_schema() -> dict:
    """The full JSON Schema for edit recipes (all parameters and ranges)."""
    return _call("GET", "/recipe/schema").json()


def main() -> None:
    mcp.run()
