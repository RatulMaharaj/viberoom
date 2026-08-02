"""Runtime configuration: which library folder is active, cache locations."""

from __future__ import annotations

import json
from pathlib import Path

RAW_EXTENSIONS = {
    ".cr2", ".cr3", ".nef", ".nrw", ".arw", ".raf", ".orf", ".rw2",
    ".dng", ".pef", ".srw", ".x3f", ".3fr", ".erf", ".kdc", ".mrw", ".iiq",
}
NON_RAW_EXTENSIONS = {".jpg", ".jpeg", ".png", ".tif", ".tiff", ".heic", ".webp"}
IMAGE_EXTENSIONS = RAW_EXTENSIONS | NON_RAW_EXTENSIONS

APP_DIR_NAME = ".viberoom"
STATE_FILE = Path.home() / APP_DIR_NAME / "state.json"


class Library:
    """The active library folder and its derived paths."""

    def __init__(self, root: Path):
        self.root = root.expanduser().resolve()
        if not self.root.is_dir():
            raise NotADirectoryError(f"Not a directory: {self.root}")

    @property
    def app_dir(self) -> Path:
        d = self.root / APP_DIR_NAME
        d.mkdir(exist_ok=True)
        return d

    @property
    def db_path(self) -> Path:
        return self.app_dir / "catalog.db"

    @property
    def cache_dir(self) -> Path:
        d = self.app_dir / "cache"
        d.mkdir(parents=True, exist_ok=True)
        return d

    @property
    def exports_dir(self) -> Path:
        d = self.root / "exports"
        d.mkdir(exist_ok=True)
        return d


def save_last_library(root: Path) -> None:
    STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    STATE_FILE.write_text(json.dumps({"library": str(root)}))


def load_last_library() -> Library | None:
    try:
        root = Path(json.loads(STATE_FILE.read_text())["library"])
        return Library(root)
    except (OSError, ValueError, KeyError):
        return None


def is_raw(path: Path) -> bool:
    return path.suffix.lower() in RAW_EXTENSIONS
