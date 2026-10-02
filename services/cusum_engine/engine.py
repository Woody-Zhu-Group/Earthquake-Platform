"""Spatio-temporal CUSUM engine (algorithm unchanged from the original draft).

Energy proxy:        E ~ 10^(1.5 * M)               (Gutenberg-Richter relation)
Spatial binning:     floor(lat / grid) * grid, floor(lon / grid) * grid
Temporal binning:    summed energy per fixed time step, zero-filled between the
                     first and last event of each cell
Control statistic:   S_t = max(0, S_{t-1} + (X_t - mu_0 - k)),  S_{-1} = 0
Parameters:          mu_0 = mean(X), sigma_0 = std(X) (sample std, ddof=1),
                     k = k_factor * sigma_0, h = h_factor * sigma_0
Alarm condition:     S_t > h
"""
from __future__ import annotations

import re

import numpy as np
import pandas as pd

CUSUM_COLUMNS = [
    "grid_lat",
    "grid_lon",
    "timestamp",
    "energy_spike",
    "baseline_mean",
    "cusum_score",
    "threshold_h",
    "event_count",
    "max_mag",
]
GRID_COLUMNS = ["lat", "lon", "max_cusum", "count"]

MIN_TIME_BINS = 4
_UNIT_ALIASES = {"h": "h", "d": "D", "t": "min", "min": "min", "s": "s"}


def energy_proxy(mag):
    """Relative seismic energy, 10^(1.5 M). Not calibrated to joules."""
    return 10 ** (1.5 * np.asarray(mag, dtype=float))


def normalize_time_step(step: str) -> str:
    """Normalise a pandas offset alias so '12H' and '12h' both work.

    pandas 2.2 deprecated upper-case ``H``/``T``/``S`` and pandas 3 rejects them, so the
    documented ``--timestep 12H`` option crashed on current installs.
    """
    match = re.fullmatch(r"\s*(\d*)\s*([A-Za-z]+)\s*", str(step))
    if not match:
        raise ValueError(f"Unsupported time step {step!r}; use values like 1D, 12h, 6h")
    count, unit = match.groups()
    key = unit if unit == "min" else unit.lower()
    if key not in _UNIT_ALIASES:
        raise ValueError(f"Unsupported time step unit {unit!r}; use D, h, min or s")
    return f"{count or 1}{_UNIT_ALIASES[key]}"


def cusum_series(values, mu_0: float, k: float) -> np.ndarray:
    """One-sided upper CUSUM: S_t = max(0, S_{t-1} + (x_t - mu_0 - k)) with S_{-1} = 0."""
    values = np.asarray(values, dtype=float)
    scores = np.zeros(len(values))
    previous = 0.0
    for t, x in enumerate(values):
        previous = max(0.0, previous + (x - mu_0 - k))
        scores[t] = previous
    return scores


def run_spatio_temporal_cusum(
    df: pd.DataFrame,
    grid_deg: float = 2.0,
    time_step: str = "1D",
    k_factor: float = 0.5,
    h_factor: float = 3.5,
    min_events: int = 4,
) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Run CUSUM change detection per spatial grid cell.

    Returns ``(anomalies_df, grid_df)``: one anomaly row per alarmed time step, and one
    summary row per cell that had enough data to be tested.
    """
    if grid_deg <= 0:
        raise ValueError("grid_deg must be positive")
    step = normalize_time_step(time_step)

    if df.empty:
        return pd.DataFrame(columns=CUSUM_COLUMNS), pd.DataFrame(columns=GRID_COLUMNS)

    work = df.copy()  # never mutate the caller's frame
    work["lat_bin"] = (work["lat"] // grid_deg) * grid_deg
    work["lon_bin"] = (work["lon"] // grid_deg) * grid_deg
    work["energy"] = energy_proxy(work["mag"])

    anomalies: list[dict] = []
    grid_summaries: list[dict] = []

    for (lat, lon), group in work.groupby(["lat_bin", "lon_bin"]):
        if len(group) < min_events:
            continue

        ts = group.set_index("time")["energy"].sort_index().resample(step).sum().fillna(0)
        if len(ts) < MIN_TIME_BINS:
            continue

        mu_0 = ts.mean()
        std = ts.std()
        sigma_0 = std if std > 0 else 1e-6
        k = k_factor * sigma_0
        h = h_factor * sigma_0

        scores = cusum_series(ts.to_numpy(), mu_0, k)

        for t in np.flatnonzero(scores > h):
            anomalies.append(
                {
                    "grid_lat": lat + grid_deg / 2,
                    "grid_lon": lon + grid_deg / 2,
                    "timestamp": ts.index[t].strftime("%Y-%m-%d %H:%M:%S"),
                    "energy_spike": float(ts.iloc[t]),
                    "baseline_mean": float(mu_0),
                    "cusum_score": float(scores[t]),
                    "threshold_h": float(h),
                    "event_count": len(group),
                    "max_mag": float(group["mag"].max()),
                }
            )

        grid_summaries.append(
            {"lat": lat, "lon": lon, "max_cusum": float(scores.max()), "count": len(group)}
        )

    return (
        pd.DataFrame(anomalies, columns=CUSUM_COLUMNS),
        pd.DataFrame(grid_summaries, columns=GRID_COLUMNS),
    )
