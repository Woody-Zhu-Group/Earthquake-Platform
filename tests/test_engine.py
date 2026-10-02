import json
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from services.cusum_engine import (
    cusum_series,
    energy_proxy,
    normalize_time_step,
    run_spatio_temporal_cusum,
)
from tests.fixtures.make_fixtures import CONFIGS, to_frame

FIXTURES = Path(__file__).parent / "fixtures"


def make_events(day_energy_mags, lat=10.5, lon=20.5):
    """One event per listed (day, magnitude) pair inside a single grid cell."""
    rows = [{"lat": lat, "lon": lon, "mag": m, "time": pd.Timestamp("2024-01-01") + pd.Timedelta(days=d)}
            for d, m in day_energy_mags]
    return pd.DataFrame(rows)


def test_energy_proxy_is_gutenberg_richter():
    assert energy_proxy(2.0) == pytest.approx(1000.0)
    assert energy_proxy([0.0, 4.0]).tolist() == pytest.approx([1.0, 1e6])


def test_cusum_recursion_matches_definition():
    scores = cusum_series([0, 5, 5, 0, 0], mu_0=1.0, k=0.5)
    assert scores.tolist() == pytest.approx([0.0, 3.5, 7.0, 5.5, 4.0])


def test_cusum_includes_the_first_observation():
    # Regression: the original loop started at t=1, silently dropping the first bin.
    assert cusum_series([10.0, 0.0], mu_0=1.0, k=0.5)[0] == pytest.approx(8.5)


@pytest.mark.parametrize("raw,expected", [("1D", "1D"), ("12H", "12h"), ("6h", "6h"), ("30T", "30min"), ("D", "1D")])
def test_time_step_normalisation(raw, expected):
    assert normalize_time_step(raw) == expected


def test_time_step_rejects_garbage():
    with pytest.raises(ValueError):
        normalize_time_step("fortnight")


def test_uppercase_hour_step_runs_on_current_pandas():
    # Regression: '--timestep 12H' (documented in --help) raised on pandas >= 2.2/3.
    df = make_events([(0, 3.0), (0.2, 3.1), (1, 3.0), (1.5, 3.2), (2, 3.0), (2.4, 6.5)])
    run_spatio_temporal_cusum(df, time_step="12H")


def test_swarm_is_flagged_and_alarm_row_is_consistent():
    quiet = [(d, 3.0) for d in range(10)] + [(d + 0.5, 3.0) for d in range(10)]
    df = make_events(quiet + [(10, 7.5), (10.3, 7.2)])
    anomalies, grid = run_spatio_temporal_cusum(df, h_factor=1.0)
    assert not anomalies.empty
    row = anomalies.iloc[0]
    assert row["cusum_score"] > row["threshold_h"]
    assert row["grid_lat"] == pytest.approx(11.0) and row["grid_lon"] == pytest.approx(21.0)
    assert grid.iloc[0]["max_cusum"] >= anomalies["cusum_score"].max()


def test_sparse_cells_are_skipped_and_input_is_not_mutated():
    df = make_events([(0, 4.0), (1, 4.0)])
    before = df.copy()
    anomalies, grid = run_spatio_temporal_cusum(df)
    assert anomalies.empty and grid.empty
    pd.testing.assert_frame_equal(df, before)  # no lat_bin/lon_bin/energy leaked in


def test_empty_input_returns_empty_frames():
    anomalies, grid = run_spatio_temporal_cusum(pd.DataFrame(columns=["lat", "lon", "mag", "time"]))
    assert anomalies.empty and grid.empty and "cusum_score" in anomalies.columns


@pytest.mark.parametrize("cfg", CONFIGS, ids=[c["name"] for c in CONFIGS])
def test_matches_committed_expected_output(cfg):
    events = json.loads((FIXTURES / "synthetic_events.json").read_text())
    expected = json.loads((FIXTURES / "expected_cusum.json").read_text())[cfg["name"]]
    anomalies, grid = run_spatio_temporal_cusum(to_frame(events), **expected["params"])
    assert len(anomalies) == len(expected["anomalies"])
    assert np.allclose(anomalies["cusum_score"], [a["cusum_score"] for a in expected["anomalies"]])
    assert np.allclose(grid["max_cusum"], [g["max_cusum"] for g in expected["grid"]])
