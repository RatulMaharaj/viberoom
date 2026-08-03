"""Dev/build launcher scripts, exposed as `uv run <name>`.

    uv run dev            backend (reload) + Vite dev server together
    uv run dev-desktop    Tauri app in dev mode (builds the sidecar first)
    uv run build-desktop  full desktop build: sidecar + Tauri installers
"""

from __future__ import annotations

import signal
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def _run(cmd: list[str], cwd: Path = ROOT) -> None:
    """Run a command, exiting with its status if it fails."""
    result = subprocess.run(cmd, cwd=cwd)
    if result.returncode != 0:
        sys.exit(result.returncode)


def _ensure_node_modules(dir: Path) -> None:
    if not (dir / "node_modules").is_dir():
        print(f"==> npm install ({dir.relative_to(ROOT)})")
        _run(["npm", "install"], cwd=dir)


def dev() -> None:
    """Run the FastAPI backend and the Vite dev server side by side."""
    _ensure_node_modules(ROOT / "frontend")

    procs = [
        subprocess.Popen(
            [sys.executable, "-m", "uvicorn", "viberoom.main:app",
             "--host", "127.0.0.1", "--port", "8423", "--reload"],
            cwd=ROOT,
        ),
        subprocess.Popen(["npm", "run", "dev"], cwd=ROOT / "frontend"),
    ]

    def shutdown(*_: object) -> None:
        for p in procs:
            p.terminate()

    signal.signal(signal.SIGINT, shutdown)
    signal.signal(signal.SIGTERM, shutdown)

    # exit when either process dies, and take the other down with it
    exit_code = 0
    try:
        while all(p.poll() is None for p in procs):
            time.sleep(0.5)
        exit_code = next((p.returncode for p in procs if p.poll() is not None), 0) or 0
    finally:
        shutdown()
        for p in procs:
            p.wait()
    sys.exit(exit_code)


def _build_sidecar() -> None:
    _run(["bash", str(ROOT / "desktop" / "build-backend.sh")])


def dev_desktop() -> None:
    """Run the Tauri desktop app in dev mode (sidecar built first)."""
    _build_sidecar()
    _ensure_node_modules(ROOT / "desktop")
    _run(["npx", "tauri", "dev"], cwd=ROOT / "desktop")


def build_desktop() -> None:
    """Build desktop installers: frontend + sidecar + Tauri bundle."""
    _build_sidecar()
    _ensure_node_modules(ROOT / "desktop")
    _run(["npx", "tauri", "build"], cwd=ROOT / "desktop")
