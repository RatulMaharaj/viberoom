#!/usr/bin/env bash
# Build the PyInstaller backend sidecar and place it where Tauri expects it
# (desktop/src-tauri/binaries/viberoom-backend-<target-triple>).
# Run from anywhere; requires uv, node, and rustc on PATH.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

echo "==> Building frontend"
npm --prefix frontend ci
npm --prefix frontend run build

echo "==> Freezing backend with PyInstaller"
uv run --with pyinstaller pyinstaller \
  desktop/pyinstaller/viberoom-backend.spec \
  --distpath desktop/pyinstaller/dist \
  --workpath desktop/pyinstaller/build \
  --noconfirm

triple="$(rustc -vV | sed -n 's/^host: //p')"
mkdir -p desktop/src-tauri/binaries

ext=""
case "$triple" in *windows*) ext=".exe" ;; esac

cp "desktop/pyinstaller/dist/viberoom-backend${ext}" \
   "desktop/src-tauri/binaries/viberoom-backend-${triple}${ext}"

echo "==> Sidecar ready: desktop/src-tauri/binaries/viberoom-backend-${triple}${ext}"
