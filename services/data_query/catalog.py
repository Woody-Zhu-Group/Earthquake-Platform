"""Catalogue dispatch: one call returns events for a region's source."""
from __future__ import annotations

from pathlib import Path

import pandas as pd

from shared.regions import Region

from .jma import fetch_jma_range, parse_hypocenter_bytes, read_zip_bytes
from .usgs import fetch_usgs_range


def fetch_region_events(region: Region, start, end, min_mag: float, jma_file=None) -> pd.DataFrame:
    """Events inside the region bbox with mag >= min_mag and start <= time <= end (UTC)."""
    if region.catalog == "usgs":
        df = fetch_usgs_range(start, end, min_mag, bbox=region.bbox)
    elif jma_file:
        path = Path(jma_file)
        blob = path.read_bytes()
        blob = read_zip_bytes(blob) if path.suffix.lower() == ".zip" else blob
        df = parse_hypocenter_bytes(blob, bbox=region.bbox, min_mag=min_mag)
    else:
        df = fetch_jma_range(start, end, bbox=region.bbox, min_mag=min_mag)
    start, end = pd.Timestamp(start), pd.Timestamp(end)
    return df[(df["time"] >= start) & (df["time"] <= end)].reset_index(drop=True)
