# Viberoom Desktop

Tauri shell that bundles the Python backend (PyInstaller sidecar) and the built
frontend into native apps for macOS, Windows, and Linux.

## How it works

- `build-backend.sh` builds `frontend/dist`, then freezes the FastAPI backend
  (which serves the SPA at `/`) into a single `viberoom-backend` executable and
  drops it into `src-tauri/binaries/` with the target-triple suffix Tauri expects.
- The Tauri app spawns that sidecar on a free localhost port (via
  `VIBEROOM_PORT`), shows a loading splash, and navigates the window to the
  local server once it's up. The sidecar is killed on app exit.

## Prerequisites

- Rust (`rustup`), Node 20+, [`uv`](https://docs.astral.sh/uv/)
- Linux: `libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf`

## Build

```sh
./desktop/build-backend.sh   # frontend + PyInstaller sidecar
cd desktop
npm install
npx tauri build              # installers in src-tauri/target/release/bundle/
npx tauri dev                # or run it for development
```

CI (`.github/workflows/desktop.yml`) builds all four targets
(macOS arm64/x86_64, Windows, Linux) on version tags or manual dispatch.

## Notes

- Icons are placeholders — replace `icons-src/icon.png` (1024×1024) and run
  `npm run icon` to regenerate the full set.
- macOS/Windows builds are unsigned until you add signing certs to CI
  (`APPLE_CERTIFICATE`, Windows code-signing) — Gatekeeper/SmartScreen will
  warn users on unsigned builds.
- The ML extras (`onnxruntime`, `rembg`) are not installed in the sidecar
  build by default; add `--extra ml` handling to `build-backend.sh` if you
  want them bundled (expect a much larger binary).
