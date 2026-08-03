# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller spec for the viberoom backend sidecar.

Build (from repo root, after `npm --prefix frontend run build`):
    uv run pyinstaller desktop/pyinstaller/viberoom-backend.spec --distpath desktop/pyinstaller/dist

Produces a single-file executable that serves the API and the built frontend.
"""

from pathlib import Path

root = Path(SPECPATH).resolve().parents[1]  # noqa: F821 — SPECPATH injected by PyInstaller
dist = root / "frontend" / "dist"
assert dist.is_dir(), "frontend/dist missing — run `npm --prefix frontend run build` first"

a = Analysis(
    [str(root / "desktop" / "pyinstaller" / "entry.py")],
    pathex=[str(root / "src")],
    datas=[(str(dist), "frontend/dist")],
    hiddenimports=[
        "viberoom.main",
        # uvicorn's default loop/protocol classes are imported by string name
        "uvicorn.logging",
        "uvicorn.loops.auto",
        "uvicorn.protocols.http.auto",
        "uvicorn.protocols.websockets.auto",
        "uvicorn.lifespan.on",
    ],
    noarchive=False,
)
pyz = PYZ(a.pure)
exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    name="viberoom-backend",
    console=False,
    upx=False,
)
