"""Regenerate the synthetic parity fixtures shared by the Python and JavaScript tests.

    python -m tests.fixtures.make_fixtures

``expected_cusum.json`` is produced by the Python engine; ``website/tests`` asserts that the
browser implementation reproduces it, which guards the "same algorithm" requirement.
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pandas as pd

from services.cusum_engine import run_spatio_temporal_cusum

HERE = Path(__file__).parent
T0 = pd.Timestamp("2024-03-01").value // 10**6  # ms since epoch

CONFIGS = [
    {"name": "daily_default", "grid_deg": 2.0, "time_step": "1D", "k_factor": 0.5, "h_factor": 3.5, "min_events": 4},
    {"name": "six_hour_tight", "grid_deg": 2.0, "time_step": "6h", "k_factor": 0.25, "h_factor": 2.0, "min_events": 4},
    {"name": "coarse_grid", "grid_deg": 5.0, "time_step": "1D", "k_factor": 0.5, "h_factor": 3.5, "min_events": 4},
]


def build_events() -> list[dict]:
    rng = np.random.default_rng(42)
    events = []

    def add(lat, lon, mag, day):
        events.append(
            {"id": f"ev{len(events):04d}", "lat": round(float(lat), 4), "lon": round(float(lon), 4),
             "mag": round(float(mag), 1), "time_ms": int(T0 + day * 86_400_000)}
        )

    # Quiet background in five regions (incl. negative lat/lon cells and one negative magnitude).
    for lat0, lon0 in [(34.0, -118.0), (-21.5, -68.5), (38.2, 142.4), (-0.5, 100.2), (61.0, -150.0)]:
        for _ in range(40):
            add(lat0 + rng.uniform(-0.9, 0.9), lon0 + rng.uniform(-0.9, 0.9), rng.gamma(4.0, 0.45) + 0.5, rng.uniform(0, 30))
    add(34.2, -118.3, -0.4, 3.2)
    # A swarm: sudden burst of large events in one cell late in the window.
    for _ in range(25):
        add(38.2 + rng.uniform(-0.8, 0.8), 142.4 + rng.uniform(-0.8, 0.8), rng.uniform(5.0, 6.8), rng.uniform(24, 26))
    # Sparse cell that must be skipped (< min_events).
    for _ in range(2):
        add(-45.0, 170.0, 4.0, rng.uniform(0, 30))
    return sorted(events, key=lambda e: e["time_ms"])


def to_frame(events: list[dict]) -> pd.DataFrame:
    df = pd.DataFrame(events)
    df["time"] = pd.to_datetime(df["time_ms"], unit="ms")
    return df[["id", "lat", "lon", "mag", "time"]]


def main() -> None:
    events = build_events()
    (HERE / "synthetic_events.json").write_text(json.dumps(events, indent=1), encoding="utf-8")
    df = to_frame(events)
    expected = {}
    for cfg in CONFIGS:
        params = {k: v for k, v in cfg.items() if k != "name"}
        anomalies, grid = run_spatio_temporal_cusum(df, **params)
        expected[cfg["name"]] = {
            "params": params,
            "anomalies": json.loads(anomalies.to_json(orient="records")),
            "grid": json.loads(grid.to_json(orient="records")),
        }
    (HERE / "expected_cusum.json").write_text(json.dumps(expected, indent=1), encoding="utf-8")
    for name, e in expected.items():
        print(f"{name}: {len(e['anomalies'])} alarm rows, {len(e['grid'])} tested cells")


if __name__ == "__main__":
    main()
