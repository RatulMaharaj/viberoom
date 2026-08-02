"""Edit recipe schema — the source of truth for all editable parameters.

All fields are optional with no-op defaults, so a partial recipe (or none at
all) always renders the image unchanged. Parameter names and ranges follow
Lightroom conventions so agents familiar with LR sliders can drive them
directly. The JSON Schema for this model is served at /api/v1/recipe/schema.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class WhiteBalance(StrictModel):
    temp: float | None = Field(
        default=None, ge=2000, le=50000,
        description="Color temperature in Kelvin. None = as-shot camera WB.",
    )
    tint: float = Field(default=0, ge=-150, le=150, description="Green(-)/magenta(+) tint.")


class ToneCurve(StrictModel):
    points: list[tuple[float, float]] = Field(
        default=[(0, 0), (255, 255)],
        description="Control points (input, output) in 0-255, monotonically increasing in x.",
    )

    @field_validator("points")
    @classmethod
    def _validate_points(cls, v: list[tuple[float, float]]) -> list[tuple[float, float]]:
        if len(v) < 2:
            raise ValueError("tone curve needs at least 2 points")
        xs = [p[0] for p in v]
        if xs != sorted(xs) or len(set(xs)) != len(xs):
            raise ValueError("tone curve x values must be strictly increasing")
        for x, y in v:
            if not (0 <= x <= 255 and 0 <= y <= 255):
                raise ValueError("tone curve points must be within 0-255")
        return v


class Tone(StrictModel):
    exposure: float = Field(default=0, ge=-5, le=5, description="Exposure in EV stops.")
    contrast: float = Field(default=0, ge=-100, le=100)
    highlights: float = Field(default=0, ge=-100, le=100)
    shadows: float = Field(default=0, ge=-100, le=100)
    whites: float = Field(default=0, ge=-100, le=100)
    blacks: float = Field(default=0, ge=-100, le=100)
    toneCurve: ToneCurve = Field(default_factory=ToneCurve)


class HSLChannel(StrictModel):
    hue: float = Field(default=0, ge=-100, le=100)
    saturation: float = Field(default=0, ge=-100, le=100)
    luminance: float = Field(default=0, ge=-100, le=100)


HSL_CHANNELS = ("red", "orange", "yellow", "green", "aqua", "blue", "purple", "magenta")


class HSL(StrictModel):
    red: HSLChannel = Field(default_factory=HSLChannel)
    orange: HSLChannel = Field(default_factory=HSLChannel)
    yellow: HSLChannel = Field(default_factory=HSLChannel)
    green: HSLChannel = Field(default_factory=HSLChannel)
    aqua: HSLChannel = Field(default_factory=HSLChannel)
    blue: HSLChannel = Field(default_factory=HSLChannel)
    purple: HSLChannel = Field(default_factory=HSLChannel)
    magenta: HSLChannel = Field(default_factory=HSLChannel)


class Color(StrictModel):
    saturation: float = Field(default=0, ge=-100, le=100)
    vibrance: float = Field(default=0, ge=-100, le=100)
    hsl: HSL = Field(default_factory=HSL)


class Sharpening(StrictModel):
    amount: float = Field(default=0, ge=0, le=150)
    radius: float = Field(default=1.0, ge=0.5, le=3.0)
    detail: float = Field(default=25, ge=0, le=100)


class NoiseReduction(StrictModel):
    luminance: float = Field(default=0, ge=0, le=100)
    color: float = Field(default=0, ge=0, le=100)


class Detail(StrictModel):
    sharpening: Sharpening = Field(default_factory=Sharpening)
    noiseReduction: NoiseReduction = Field(default_factory=NoiseReduction)


class Crop(StrictModel):
    """Normalized crop rectangle; full frame is (0, 0, 1, 1)."""

    left: float = Field(default=0, ge=0, le=1)
    top: float = Field(default=0, ge=0, le=1)
    right: float = Field(default=1, ge=0, le=1)
    bottom: float = Field(default=1, ge=0, le=1)

    @field_validator("right")
    @classmethod
    def _r(cls, v: float, info) -> float:
        if "left" in info.data and v <= info.data["left"]:
            raise ValueError("crop right must be > left")
        return v

    @field_validator("bottom")
    @classmethod
    def _b(cls, v: float, info) -> float:
        if "top" in info.data and v <= info.data["top"]:
            raise ValueError("crop bottom must be > top")
        return v


class Geometry(StrictModel):
    rotate: float = Field(default=0, ge=-45, le=45, description="Straighten angle in degrees, CW positive.")
    orientation: Literal[0, 90, 180, 270] = Field(default=0, description="Coarse rotation in degrees CW.")
    flipH: bool = False
    flipV: bool = False
    crop: Crop = Field(default_factory=Crop)


class Recipe(StrictModel):
    whiteBalance: WhiteBalance = Field(default_factory=WhiteBalance)
    tone: Tone = Field(default_factory=Tone)
    color: Color = Field(default_factory=Color)
    detail: Detail = Field(default_factory=Detail)
    geometry: Geometry = Field(default_factory=Geometry)

    def is_noop(self) -> bool:
        return self == Recipe()

    def canonical_json(self) -> str:
        """Stable serialization used for preview cache keys."""
        import json

        return json.dumps(self.model_dump(mode="json"), sort_keys=True, separators=(",", ":"))
