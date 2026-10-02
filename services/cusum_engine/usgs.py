"""USGS data access: summary feeds (real time) and the FDSN event API (historical)."""
from __future__ import annotations

import os

import pandas as pd
import requests

SUMMARY_URL = "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/{feed}.geojson"
FDSN_URL = "https://earthquake.usgs.gov/fdsnws/event/1/query"
FDSN_LIMIT = 20000  # hard cap enforced by the USGS FDSN service

RECORD_COLUMNS = ["id", "title", "lon", "lat", "depth", "mag", "time", "place"]


class UsgsFetchError(RuntimeError):
    """Raised when USGS data cannot be downloaded or parsed."""


def _timeout() -> float:
    return float(os.environ.get("USGS_TIMEOUT", "15"))


def features_to_dataframe(geojson: dict) -> pd.DataFrame:
    """Convert a USGS GeoJSON payload to a DataFrame.

    Events without a magnitude, time, or coordinates are dropped. ``time`` is a
    tz-naive UTC timestamp, matching the original engine.
    """
    records = []
    for feature in geojson.get("features") or []:
        geometry = feature.get("geometry") or {}
        coords = geometry.get("coordinates") or []
        props = feature.get("properties") or {}
        if len(coords) < 2 or props.get("mag") is None or props.get("time") is None:
            continue
        records.append(
            {
                "id": feature.get("id"),
                "title": props.get("title", "Unknown"),
                "lon": float(coords[0]),
                "lat": float(coords[1]),
                "depth": float(coords[2]) if len(coords) > 2 and coords[2] is not None else float("nan"),
                "mag": float(props["mag"]),
                "time": pd.to_datetime(props["time"], unit="ms"),
                "place": props.get("place", "Unknown"),
            }
        )
    df = pd.DataFrame(records, columns=RECORD_COLUMNS)
    if not df.empty:
        df = df.sort_values("time").reset_index(drop=True)
    return df


def _get_json(url: str, params: dict | None = None) -> dict:
    try:
        response = requests.get(url, params=params, timeout=_timeout())
        response.raise_for_status()
        return response.json()
    except Exception as exc:  # network, HTTP status, or JSON decoding
        raise UsgsFetchError(f"Error fetching data from USGS: {exc}") from exc


def fetch_usgs_summary(feed: str = "all_month") -> pd.DataFrame:
    """Fetch a real-time USGS summary feed (``all_day``, ``all_week``, ``4.5_month``...)."""
    print(f"[*] Fetching live USGS GeoJSON feed ({feed})...")
    return features_to_dataframe(_get_json(SUMMARY_URL.format(feed=feed)))


def fetch_usgs_historical(start: str, end: str, min_magnitude: float = 5.0) -> pd.DataFrame:
    """Fetch a historical range from the USGS FDSN event API (same query the website uses)."""
    if start > end:
        raise ValueError(f"start date {start} is after end date {end}")
    print(f"[*] Querying USGS FDSN ({start} to {end}, M >= {min_magnitude})...")
    params = {
        "format": "geojson",
        "starttime": f"{start}T00:00:00",
        "endtime": f"{end}T23:59:59",
        "minmagnitude": min_magnitude,
        "eventtype": "earthquake",
        "orderby": "time-asc",
        "limit": FDSN_LIMIT,
    }
    df = features_to_dataframe(_get_json(FDSN_URL, params))
    if len(df) >= FDSN_LIMIT:
        print("[!] Result hit the 20000-event USGS limit; narrow the range or raise --min-mag.")
    return df
