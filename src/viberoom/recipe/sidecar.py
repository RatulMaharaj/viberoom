"""Sidecar files are the source of truth for ratings, flags and edit recipes.

A sidecar lives next to the original as `<filename>.vibe.json` (e.g.
`IMG_1234.CR3.vibe.json`). Originals are never modified. Sidecars are plain
JSON so agents can read/write them directly; anything the app writes is
pretty-printed for diffability.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from viberoom.recipe.schema import Recipe

SIDECAR_SUFFIX = ".vibe.json"

Flag = Literal["pick", "reject"] | None
Label = Literal["red", "yellow", "green", "blue", "purple"] | None


class Sidecar(BaseModel):
    model_config = ConfigDict(extra="forbid")

    version: int = 1
    rating: int = Field(default=0, ge=0, le=5)
    flag: Flag = None
    label: Label = None
    keywords: list[str] = Field(default_factory=list)
    recipe: Recipe = Field(default_factory=Recipe)


def sidecar_path(image_path: Path) -> Path:
    return image_path.with_name(image_path.name + SIDECAR_SUFFIX)


def load_sidecar(image_path: Path) -> Sidecar:
    """Load the sidecar for an image, or defaults if absent/invalid."""
    p = sidecar_path(image_path)
    if not p.exists():
        return Sidecar()
    try:
        return Sidecar.model_validate(json.loads(p.read_text()))
    except (json.JSONDecodeError, ValueError):
        # A malformed sidecar (e.g. mid-edit by an agent) must never take down
        # the app; treat as defaults until it parses again.
        return Sidecar()


def save_sidecar(image_path: Path, sidecar: Sidecar) -> Path:
    p = sidecar_path(image_path)
    p.write_text(json.dumps(sidecar.model_dump(mode="json"), indent=2) + "\n")
    return p
