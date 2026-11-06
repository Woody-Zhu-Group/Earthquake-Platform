"""Region definitions shared by the detector (Python) and the portal (regions.json is copied to docs/)."""
from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

REGIONS_FILE = Path(__file__).with_name("regions.json")
CATALOGS = ("usgs", "jma")


@dataclass(frozen=True)
class Region:
    id: str
    name: str
    bbox: tuple            # (west, south, east, north) degrees
    catalog: str           # "usgs" | "jma"
    min_mag: float         # starting completeness magnitude; raised automatically if an event cap would be exceeded
    baseline_years: float  # long-term period that defines "normal"
    monitor_days: float    # length of the online-detection period
    notes: str = ""

    def __post_init__(self):
        west, south, east, north = self.bbox
        if not (-180 <= west < east <= 180 and -90 <= south < north <= 90):
            raise ValueError(f"region {self.id}: invalid bbox {self.bbox}")
        if self.catalog not in CATALOGS:
            raise ValueError(f"region {self.id}: unknown catalog {self.catalog!r}")
        if self.baseline_years <= 0 or self.monitor_days <= 0:
            raise ValueError(f"region {self.id}: baseline_years and monitor_days must be positive")


def load_regions(path=REGIONS_FILE) -> dict:
    raw = json.loads(Path(path).read_text(encoding="utf-8"))["regions"]
    regions = {r["id"]: Region(**{**r, "bbox": tuple(r["bbox"])}) for r in raw}
    if len(regions) != len(raw):
        raise ValueError("duplicate region ids in regions.json")
    return regions
