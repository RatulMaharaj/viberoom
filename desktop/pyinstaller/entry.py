"""PyInstaller entrypoint for the bundled viberoom backend sidecar."""

import multiprocessing

from viberoom.main import main

if __name__ == "__main__":
    multiprocessing.freeze_support()  # required in frozen apps on Windows/macOS
    main()
