import math

import pytest

from services.cusum_engine import features_to_dataframe, fetch_usgs_historical


def feature(mag=4.5, time=1_700_000_000_000, coords=(-120.0, 35.0, 8.0), fid="x1"):
    return {"id": fid, "properties": {"mag": mag, "time": time, "place": "Somewhere", "title": "M"},
            "geometry": {"coordinates": list(coords)}}


def test_parses_valid_features_sorted_by_time():
    df = features_to_dataframe({"features": [feature(time=2000, fid="b"), feature(time=1000, fid="a")]})
    assert df["id"].tolist() == ["a", "b"]
    assert {"lat", "lon", "depth", "mag", "time"} <= set(df.columns)
    assert df.iloc[0]["lat"] == 35.0 and df.iloc[0]["lon"] == -120.0


def test_drops_events_with_missing_mag_time_or_geometry():
    payload = {"features": [feature(mag=None), feature(time=None), {"id": "g", "properties": {"mag": 1, "time": 1}, "geometry": None}, feature()]}
    assert len(features_to_dataframe(payload)) == 1


def test_missing_depth_becomes_nan_not_a_crash():
    df = features_to_dataframe({"features": [feature(coords=(1.0, 2.0))]})
    assert math.isnan(df.iloc[0]["depth"])


def test_empty_payload_gives_empty_frame_with_columns():
    df = features_to_dataframe({"features": []})
    assert df.empty and "mag" in df.columns


def test_historical_rejects_reversed_dates():
    with pytest.raises(ValueError):
        fetch_usgs_historical("2025-02-01", "2025-01-01")
