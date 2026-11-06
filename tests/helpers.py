"""Catalogue builders shared by tests."""
import numpy as np
import pandas as pd

from shared.regions import Region

REGION = Region(id="testland", name="Testland", bbox=(-125.0, 32.0, -114.0, 43.0), catalog="usgs",
                min_mag=3.0, baseline_years=10, monitor_days=365)
AS_OF = pd.Timestamp("2025-06-30")
HOT = (-118.0, 34.0)       # an always-busy area: lots of earthquakes there are *normal*
BURST = (-122.0, 40.0)     # a quiet area that suddenly lights up


def _events(rng, n, start, days, centre=None, spread=0.4, tag=""):
    t = start + pd.to_timedelta(np.sort(rng.uniform(0, days, n)), unit="D")
    if centre is None:
        lon, lat = rng.uniform(-125, -114, n), rng.uniform(32, 43, n)
    else:
        lon, lat = rng.normal(centre[0], spread, n), rng.normal(centre[1], spread, n)
    return pd.DataFrame({"id": [f"{tag}{i}" for i in range(n)], "lon": lon.clip(-124.9, -114.1),
                         "lat": lat.clip(32.1, 42.9), "depth": 8.0, "mag": 3.0 + rng.exponential(0.4, n),
                         "time": t, "title": "t", "place": "t"})


def catalogue(burst: bool, seed: int = 0, hot_per_year: float = 60.0, bg_per_year: float = 15.0):
    """10 years of baseline + 1 year of monitoring; HOT stays busy throughout; optionally a late BURST."""
    rng = np.random.default_rng(seed)
    start = AS_OF - pd.Timedelta(days=11 * 365.25 + 1)
    parts = []
    for y in range(11):
        s = start + pd.Timedelta(days=y * 365.25)
        parts.append(_events(rng, rng.poisson(hot_per_year), s, 365.25, HOT, 0.5, f"h{y}_"))
        parts.append(_events(rng, rng.poisson(bg_per_year), s, 365.25, None, tag=f"b{y}_"))
    if burst:   # a sustained swarm (online detection learns f1 from the previous batch, so it needs to persist)
        s = AS_OF - pd.Timedelta(days=150)
        parts.append(_events(rng, 200, s, 150, BURST, 0.25, "burst"))
    return pd.concat(parts, ignore_index=True).sort_values("time").reset_index(drop=True)
