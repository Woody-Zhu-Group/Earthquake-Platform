"""Repository paths shared by the engine, scripts, and tests."""
from __future__ import annotations

import os
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]


def output_dir() -> Path:
    """Directory for generated CSV/PNG files (``CUSUM_OUTPUT_DIR`` or ``data/outputs``).

    Relative overrides resolve from the repository root, not the working directory.
    """
    raw = os.environ.get("CUSUM_OUTPUT_DIR", "data/outputs")
    path = Path(raw)
    if not path.is_absolute():
        path = REPO_ROOT / path
    return path
