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


_IDENTITY_CURVE = [(0.0, 0.0), (255.0, 255.0)]


def _validate_curve_points(v: list[tuple[float, float]]) -> list[tuple[float, float]]:
    if len(v) < 2:
        raise ValueError("tone curve needs at least 2 points")
    xs = [p[0] for p in v]
    if xs != sorted(xs) or len(set(xs)) != len(xs):
        raise ValueError("tone curve x values must be strictly increasing")
    for x, y in v:
        if not (0 <= x <= 255 and 0 <= y <= 255):
            raise ValueError("tone curve points must be within 0-255")
    return v


class ToneCurve(StrictModel):
    points: list[tuple[float, float]] = Field(
        default=_IDENTITY_CURVE,
        description="Luminance control points (input, output) in 0-255, monotonically increasing in x.",
    )
    red: list[tuple[float, float]] = Field(
        default=_IDENTITY_CURVE, description="Red-channel curve points, same format as points."
    )
    green: list[tuple[float, float]] = Field(
        default=_IDENTITY_CURVE, description="Green-channel curve points."
    )
    blue: list[tuple[float, float]] = Field(
        default=_IDENTITY_CURVE, description="Blue-channel curve points."
    )

    @field_validator("points", "red", "green", "blue")
    @classmethod
    def _check(cls, v: list[tuple[float, float]]) -> list[tuple[float, float]]:
        return _validate_curve_points(v)


class Tone(StrictModel):
    exposure: float = Field(default=0, ge=-5, le=5, description="Exposure in EV stops.")
    contrast: float = Field(default=0, ge=-100, le=100)
    highlights: float = Field(default=0, ge=-100, le=100)
    shadows: float = Field(default=0, ge=-100, le=100)
    whites: float = Field(default=0, ge=-100, le=100)
    blacks: float = Field(default=0, ge=-100, le=100)
    texture: float = Field(default=0, ge=-100, le=100, description="Fine-detail contrast; negative smooths.")
    clarity: float = Field(default=0, ge=-100, le=100, description="Midtone local contrast; negative softens.")
    dehaze: float = Field(default=0, ge=-100, le=100, description="Haze removal; negative adds haze.")
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


class GradeBand(StrictModel):
    """One color-grading wheel: tint toward `hue` with `saturation` strength."""

    hue: float = Field(default=0, ge=0, le=360, description="Tint hue in degrees on the color wheel.")
    saturation: float = Field(default=0, ge=0, le=100, description="Tint strength; 0 = no tint.")
    luminance: float = Field(default=0, ge=-100, le=100, description="Brighten/darken this band.")


class ColorGrading(StrictModel):
    """Three-way color grading (shadows/midtones/highlights wheels)."""

    shadows: GradeBand = Field(default_factory=GradeBand)
    midtones: GradeBand = Field(default_factory=GradeBand)
    highlights: GradeBand = Field(default_factory=GradeBand)
    blending: float = Field(default=50, ge=0, le=100, description="Band overlap softness.")
    balance: float = Field(
        default=0, ge=-100, le=100,
        description="Shifts the shadow/highlight split: negative favors shadows, positive highlights.",
    )


class Color(StrictModel):
    saturation: float = Field(default=0, ge=-100, le=100)
    vibrance: float = Field(default=0, ge=-100, le=100)
    hsl: HSL = Field(default_factory=HSL)
    grading: ColorGrading = Field(default_factory=ColorGrading)


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


class Vignette(StrictModel):
    """Post-crop vignette. Negative amount darkens corners, positive lightens."""

    amount: float = Field(default=0, ge=-100, le=100)
    midpoint: float = Field(default=50, ge=0, le=100, description="How far from center the falloff starts.")
    feather: float = Field(default=50, ge=0, le=100, description="Softness of the falloff.")
    roundness: float = Field(
        default=0, ge=-100, le=100,
        description="Shape: -100 more rectangular, 0 elliptical, +100 circular.",
    )


class Grain(StrictModel):
    amount: float = Field(default=0, ge=0, le=100)
    size: float = Field(default=25, ge=0, le=100)


class Effects(StrictModel):
    vignette: Vignette = Field(default_factory=Vignette)
    grain: Grain = Field(default_factory=Grain)


# ---------- local adjustments (masks) ----------

class LocalAdjustments(StrictModel):
    """Adjustments applied only where a mask selects. Same feel as the global
    sliders; temp/tint are relative warm/cool shifts, not Kelvin."""

    exposure: float = Field(default=0, ge=-5, le=5, description="EV stops.")
    contrast: float = Field(default=0, ge=-100, le=100)
    highlights: float = Field(default=0, ge=-100, le=100)
    shadows: float = Field(default=0, ge=-100, le=100)
    temp: float = Field(default=0, ge=-100, le=100, description="Relative cool(-)/warm(+) shift.")
    tint: float = Field(default=0, ge=-100, le=100, description="Green(-)/magenta(+) shift.")
    saturation: float = Field(default=0, ge=-100, le=100)
    clarity: float = Field(default=0, ge=-100, le=100)
    dehaze: float = Field(default=0, ge=-100, le=100)
    sharpness: float = Field(default=0, ge=-100, le=100)


class MaskBase(StrictModel):
    name: str | None = Field(default=None, description="Optional label for humans/agents.")
    invert: bool = False
    opacity: float = Field(default=100, ge=0, le=100, description="Overall mask strength.")
    adjustments: LocalAdjustments = Field(default_factory=LocalAdjustments)


class LinearGradientMask(MaskBase):
    """Full effect on the `start` side, fading to zero at `end`. Coordinates
    are normalized 0-1 in the final rendered (post-crop) frame."""

    type: Literal["linear"] = "linear"
    start: tuple[float, float] = Field(description="[x, y] where the effect is full strength.")
    end: tuple[float, float] = Field(description="[x, y] where the effect reaches zero.")


class RadialGradientMask(MaskBase):
    """Elliptical mask: full effect inside, feathering out to the edge.
    Coordinates/radii normalized 0-1 in the final rendered frame."""

    type: Literal["radial"] = "radial"
    center: tuple[float, float] = Field(description="[x, y] ellipse center.")
    radiusX: float = Field(gt=0, le=2, description="Horizontal radius (fraction of width).")
    radiusY: float = Field(gt=0, le=2, description="Vertical radius (fraction of height).")
    feather: float = Field(default=50, ge=0, le=100)


class LuminanceRangeMask(MaskBase):
    """Selects pixels whose brightness falls within [lumMin, lumMax] (0-100)."""

    type: Literal["luminance"] = "luminance"
    lumMin: float = Field(default=0, ge=0, le=100)
    lumMax: float = Field(default=100, ge=0, le=100)
    feather: float = Field(default=25, ge=0, le=100, description="Edge softness of the range.")


class ColorRangeMask(MaskBase):
    """Selects pixels near a hue (degrees on the color wheel); saturated
    pixels weigh more, grays are unaffected."""

    type: Literal["color"] = "color"
    hue: float = Field(ge=0, le=360, description="Target hue center in degrees.")
    range: float = Field(default=30, ge=5, le=180, description="Hue distance of influence, degrees.")


Mask = LinearGradientMask | RadialGradientMask | LuminanceRangeMask | ColorRangeMask


class Recipe(StrictModel):
    whiteBalance: WhiteBalance = Field(default_factory=WhiteBalance)
    tone: Tone = Field(default_factory=Tone)
    color: Color = Field(default_factory=Color)
    detail: Detail = Field(default_factory=Detail)
    geometry: Geometry = Field(default_factory=Geometry)
    effects: Effects = Field(default_factory=Effects)
    masks: list[Mask] = Field(
        default_factory=list,
        description="Local adjustments, applied in order after global edits (coordinates are post-crop).",
    )

    def is_noop(self) -> bool:
        return self == Recipe()

    def canonical_json(self) -> str:
        """Stable serialization used for preview cache keys."""
        import json

        return json.dumps(self.model_dump(mode="json"), sort_keys=True, separators=(",", ":"))
