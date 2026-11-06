import math

import pandas as pd
import pytest

from services.data_query import features_to_dataframe, fetch_usgs_historical, fetch_usgs_range, filter_bbox
from services.data_query.usgs import FDSN_LIMIT


def feature(mag=4.5, time=1_700_000_000_000, coords=(-120.0, 35.0, 8.0), fid="x1"):
    return {"id": fid, "properties": {"mag": mag, "time": time, "place": "Somewhere", "title": "M"},
            "geometry": {"coordinates": list(coords)}}


def test_parses_valid_features_sorted_by_time():
    df = features_to_dataframe({"features": [feature(time=2000, fid="b"), feature(time=1000, fid="a")]})
    assert df["id"].tolist() == ["a", "b"]
    assert df.iloc[0]["lat"] == 35.0 and df.iloc[0]["lon"] == -120.0


def test_drops_events_with_missing_mag_time_or_geometry():
    payload = {"features": [feature(mag=None), feature(time=None),
                            {"id": "g", "properties": {"mag": 1, "time": 1}, "geometry": None}, feature()]}
    assert len(features_to_dataframe(payload)) == 1


def test_missing_depth_becomes_nan_and_empty_payload_is_fine():
    assert math.isnan(features_to_dataframe({"features": [feature(coords=(1.0, 2.0))]}).iloc[0]["depth"])
    assert features_to_dataframe({"features": []}).empty


def test_reversed_dates_rejected():
    with pytest.raises(ValueError):
        fetch_usgs_historical("2025-02-01", "2025-01-01")


def test_bbox_filter():
    df = features_to_dataframe({"features": [feature(coords=(-120, 35, 1), fid="in"), feature(coords=(10, 5, 1), fid="out")]})
    assert filter_bbox(df, (-125, 32, -114, 42))["id"].tolist() == ["in"]
    with pytest.raises(ValueError):
        filter_bbox(df, (0, 0, -1, 1))


def test_range_fetch_splits_when_the_20000_cap_is_hit_and_does_not_duplicate():
    calls = []

    def fake(a, b):
        calls.append((a, b))
        days = (pd.Timestamp(b) - pd.Timestamp(a)).days + 1
        n = FDSN_LIMIT if days > 100 else days            # a request longer than 100 days "hits the cap"
        t = pd.date_range(a, periods=n, freq="D")[:n] if n < FDSN_LIMIT else pd.date_range(a, periods=n, freq="min")
        return pd.DataFrame({"id": [f"{a}_{i}" for i in range(len(t))], "time": t})

    out = fetch_usgs_range("2020-01-01", "2020-12-31", 4.5, fetch=fake)
    assert len(calls) > 1 and out["id"].is_unique
    assert out["time"].is_monotonic_increasing
    covered = {pd.Timestamp(a) for a, _ in calls if True}
    assert pd.Timestamp("2020-01-01") in covered
