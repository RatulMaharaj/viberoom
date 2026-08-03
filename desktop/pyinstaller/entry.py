"""PyInstaller entrypoint for the bundled viberoom backend sidecar."""

import multiprocessing
import os
import sys
import threading

from viberoom.main import main


def _exit_when_parent_dies() -> None:
    """Exit when stdin hits EOF — i.e. when the Tauri parent goes away.

    PyInstaller onefile runs a bootloader parent + the real Python child;
    Tauri can only kill the bootloader, which would orphan this process.
    The sidecar stdin pipe closes when the parent exits (cleanly or by
    crashing), so EOF is a reliable cross-platform death signal.
    """
    try:
        while sys.stdin.buffer.read(1024):
            pass
    except Exception:
        pass
    os._exit(0)


if __name__ == "__main__":
    multiprocessing.freeze_support()  # required in frozen apps on Windows/macOS
    if os.environ.get("VIBEROOM_SIDECAR") == "1":
        threading.Thread(target=_exit_when_parent_dies, daemon=True).start()
    main()
