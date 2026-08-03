"""Tethered capture via gphoto2 (`brew install gphoto2`). Frames land in
the library (optionally under a subfolder), get scanned, and can have a
develop preset applied on arrival — so an agent can direct a studio
session: trigger, inspect the preview, adjust, trigger again."""

from __future__ import annotations

import re
import shutil
import subprocess
from pathlib import Path

GPHOTO2 = shutil.which("gphoto2")


class TetherError(RuntimeError):
    pass


def _run(args: list[str], timeout: float = 30) -> str:
    if GPHOTO2 is None:
        raise TetherError(
            "gphoto2 not found - install it (e.g. `brew install gphoto2`) to tether"
        )
    try:
        proc = subprocess.run(
            [GPHOTO2, *args], capture_output=True, text=True, timeout=timeout
        )
    except subprocess.TimeoutExpired:
        raise TetherError(f"gphoto2 timed out after {timeout}s")
    if proc.returncode != 0:
        raise TetherError(proc.stderr.strip() or f"gphoto2 exited {proc.returncode}")
    return proc.stdout


def detect_camera() -> dict:
    """The connected camera (first one), or raise TetherError."""
    out = _run(["--auto-detect"], timeout=15)
    lines = [ln.strip() for ln in out.splitlines()[2:] if ln.strip()]
    if not lines:
        raise TetherError("no camera detected - connect via USB and wake it")
    model = re.split(r"\s{2,}", lines[0])[0]
    return {"model": model}


def capture(dest_dir: Path, prefix: str = "tether") -> Path:
    """Trigger the shutter and download the frame into dest_dir."""
    dest_dir.mkdir(parents=True, exist_ok=True)
    template = str(dest_dir / f"{prefix}-%Y%m%d-%H%M%S.%C")
    out = _run(
        ["--capture-image-and-download", "--filename", template, "--force-overwrite"],
        timeout=60,
    )
    saved = re.findall(r"Saving file as (.+)", out)
    if not saved:
        raise TetherError(f"capture ran but no file reported:\n{out.strip()}")
    return Path(saved[-1].strip())


def camera_summary() -> str:
    return _run(["--summary"], timeout=15)
