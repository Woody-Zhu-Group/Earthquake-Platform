"""Synthetic region from ``simulator_old.SyntheticSimulator`` (demo.ipynb): baseline = no-change run, monitor = change at 0.5.

Baseline and monitoring each span one time unit (1 "year"), so ``baseline_years=1, monitor_days=365`` reproduces the
notebook's setup. The unit cube is mapped onto a nominal 10 x 10 degree box.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from shared.regions import Region

from .simulator_old import SyntheticSimulator

SYNTHETIC = Region(id="synthetic", name="Synthetic demo", bbox=(-120.0, 30.0, -110.0, 40.0), catalog="usgs",
                   min_mag=4.5, baseline_years=1, monitor_days=365, notes="demo.ipynb simulator")
START = pd.Timestamp("2024-01-01")
DAYS = 365.0


def _frame(data, rng, t_offset_days):
    west, south, east, north = SYNTHETIC.bbox
    return pd.DataFrame({
        "id": [f"syn{int(t_offset_days)}_{i:05d}" for i in range(len(data))],
        "lon": west + data[:, 1] * (east - west), "lat": south + data[:, 2] * (north - south),
        "depth": 10.0, "mag": 4.5 + rng.exponential(1 / np.log(10), len(data)),
        "time": START + pd.to_timedelta(t_offset_days + data[:, 0] * DAYS, unit="D"),
        "title": "synthetic", "place": "synthetic"})


def synthetic_events(seed: int = 0, mu0: float = 50.0, mu1: float = 5000.0, radius_post: float = 0.1):
    """Returns (events DataFrame spanning baseline then monitor, as_of Timestamp)."""
    centers = np.array([[0.5, 0.5], [0.5 + 2 * radius_post, 0.5], [0.5 - 2 * radius_post, 0.5],
                        [0.5, 0.5 - 2 * radius_post], [0.5, 0.5 + 2 * radius_post]])
    kw = dict(mu0=mu0, mu1=mu1, beta=1.0, alpha=0.0, center_post=centers, radius_post=radius_post)
    np.random.seed(seed)
    pre = SyntheticSimulator(nu=2.0, **kw).simulate(verbose=False, restart=False, lam_bar=mu1)   # nu > T: never changes
    post = SyntheticSimulator(nu=0.5, **kw).simulate(verbose=False, restart=False, lam_bar=mu1)
    rng = np.random.default_rng(seed)
    df = pd.concat([_frame(pre, rng, 0), _frame(post, rng, DAYS)], ignore_index=True)
    return df, START + pd.Timedelta(days=2 * DAYS)
