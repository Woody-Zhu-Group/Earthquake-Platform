"""JMA unified hypocenter catalogue (Seismological Bulletin of Japan, "hypocenter file").

Record layout: https://www.data.jma.go.jp/eqev/data/bulletin/data/format/hypfmt_e.html
 * one 96-byte fixed-width record per event, numbers written *without* decimal points
   (second "4618" = 46.18 s, minutes "5200" = 52.00 min);
 * origin times are Japan Standard Time (UTC+9);
 * magnitude is two characters: "45" = 4.5, "-1" = -0.1, "A0" = -1.0, "B0" = -2.0, "C0" = -3.0;
 * region names may be multi-byte, so records are sliced as *bytes*.
Yearly files: https://www.data.jma.go.jp/eqev/data/bulletin/data/hypo/h{year}.zip
"""
from __future__ import annotations

import io
import os
import zipfile
from pathlib import Path

import pandas as pd
import requests

from shared.paths import REPO_ROOT

JMA_URL = "https://www.data.jma.go.jp/eqev/data/bulletin/data/hypo/h{year}.zip"
JST_OFFSET = pd.Timedelta(hours=9)
NATURAL_FLAGS = {b"1", b"2", b" ", b""}  # col 61: 1 natural, 2 natural/few stations; 3 artificial, 4 eruption, 5 LFE excluded
COLUMNS = ["id", "title", "lon", "lat", "depth", "mag", "time", "place"]


class JmaFetchError(RuntimeError):
    pass


def cache_dir() -> Path:
    return Path(os.environ.get("JMA_CACHE_DIR", REPO_ROOT / "data" / "cache" / "jma"))


def _decimal(field: bytes, decimals: int):
    """Implied-decimal number; trailing blanks (fixed hypocentres) count as zeros. None if blank."""
    text = field.decode("ascii", "replace")
    if not text.strip():
        return None
    return int(text.replace(" ", "0")) / 10**decimals


def parse_magnitude(field: bytes):
    text = field.decode("ascii", "replace")
    if len(text) < 2 or not text.strip():
        return None
    first, second = text[0], text[1]
    if first == "-":
        return -int(second) / 10
    if first in "ABC":
        return -(("ABC".index(first) + 1) * 10 + int(second)) / 10
    return int(text) / 10


def _degrees(deg_field: bytes, min_field: bytes):
    deg_text = deg_field.decode("ascii", "replace").strip()
    minutes = _decimal(min_field, 2)
    if not deg_text or minutes is None:
        return None
    sign = -1 if deg_text.startswith("-") else 1
    return sign * (abs(int(deg_text)) + minutes / 60)


def _depth_km(field: bytes) -> float:
    text = field.decode("ascii", "replace")
    if not text.strip():
        return float("nan")
    if not text[3:].strip():                 # depth-slice method: I3 + 2X
        return float(int(text[:3]))
    return int(text.replace(" ", "0")) / 100  # depth-free method: F5.2


def parse_hypocenter_bytes(blob: bytes, bbox=None, min_mag=None, agency: bytes = b"J") -> pd.DataFrame:
    """Parse JMA hypocenter records into the same columns as ``usgs.features_to_dataframe`` (time = naive UTC).

    Keeps natural events from one agency (``J`` = JMA's own solutions, consistent in method; ``U``/``I`` rows are
    other agencies' teleseismic solutions).
    """
    rows = []
    for line in blob.splitlines():
        if len(line) < 62 or line[:1] != agency:
            continue
        try:
            mag = parse_magnitude(line[52:54])
            if mag is None or (min_mag is not None and mag < min_mag) or line[60:61] not in NATURAL_FLAGS:
                continue
            lat, lon = _degrees(line[21:24], line[24:28]), _degrees(line[32:36], line[36:40])
            if lat is None or lon is None:
                continue
            if bbox is not None and not (bbox[0] <= lon <= bbox[2] and bbox[1] <= lat <= bbox[3]):
                continue
            sec = _decimal(line[13:17], 2) or 0.0
            when = (pd.Timestamp(year=int(line[1:5]), month=int(line[5:7]), day=int(line[7:9]),
                                 hour=int(line[9:11]), minute=int(line[11:13]))
                    + pd.Timedelta(seconds=sec) - JST_OFFSET)
            rows.append({"id": "jma" + line[1:14].decode("ascii", "replace"), "title": "JMA", "lon": lon, "lat": lat,
                         "depth": _depth_km(line[44:49]), "mag": mag, "time": when, "place": "JMA unified catalogue"})
        except ValueError:      # malformed record: skip it rather than abort a multi-year download
            continue
    df = pd.DataFrame(rows, columns=COLUMNS)
    return df.sort_values("time").reset_index(drop=True) if not df.empty else df


def read_zip_bytes(blob: bytes) -> bytes:
    with zipfile.ZipFile(io.BytesIO(blob)) as zf:
        return b"\n".join(zf.read(n) for n in sorted(zf.namelist()) if not n.endswith("/"))


def fetch_jma_year(year: int, bbox=None, min_mag=None, timeout: float = 120.0):
    """One yearly file (cached). ``None`` when JMA has not published that year (HTTP 404)."""
    path = cache_dir() / f"h{year}.zip"
    if not path.exists():
        print(f"[*] Downloading JMA hypocenter file for {year}...")
        try:
            response = requests.get(JMA_URL.format(year=year), timeout=timeout,
                                    headers={"User-Agent": "cusum-platform/1.0 (research)"})
        except requests.RequestException as exc:
            raise JmaFetchError(f"Could not reach JMA for {year}: {exc}") from exc
        if response.status_code == 404:
            return None
        if not response.ok:
            raise JmaFetchError(f"JMA returned HTTP {response.status_code} for {year}")
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(response.content)
    try:
        return parse_hypocenter_bytes(read_zip_bytes(path.read_bytes()), bbox=bbox, min_mag=min_mag)
    except zipfile.BadZipFile as exc:
        path.unlink(missing_ok=True)
        raise JmaFetchError(f"Corrupt JMA download for {year} (deleted; rerun to retry)") from exc


def fetch_jma_range(start, end, bbox=None, min_mag=None) -> pd.DataFrame:
    """Events in [start, end] from the yearly files; unpublished years are skipped."""
    start, end = pd.Timestamp(start), pd.Timestamp(end)
    frames = []
    for year in range(start.year, end.year + 1):
        df = fetch_jma_year(year, bbox=bbox, min_mag=min_mag)
        if df is not None and not df.empty:
            frames.append(df)
    if not frames:
        raise JmaFetchError("No JMA data found for this period; pass --jma-file with a downloaded file.")
    df = pd.concat(frames, ignore_index=True)
    return df[(df["time"] >= start) & (df["time"] <= end)].reset_index(drop=True)
