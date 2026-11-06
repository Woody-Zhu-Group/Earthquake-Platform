import numpy as np
import pandas as pd

from services.change_detection.geo import UnitSquare, harmonize_min_mag


def frame():
    return UnitSquare.for_region((-125.0, 32.0, -114.0, 43.0), origin_ms=0, unit_ms=10 * 86_400_000)


def test_space_lands_in_the_unit_square_and_roundtrips():
    f = frame()
    df = pd.DataFrame({"lon": [-125.0, -119.5, -114.0], "lat": [32.0, 37.5, 43.0],
                       "time": pd.to_datetime([0, 5, 10], unit="D")})
    u = f.to_unit(df)
    assert u[:, 1:].min() >= 0 and u[:, 1:].max() <= 1
    assert np.allclose(u[:, 0], [0, 0.5, 1.0])
    lonlat = f.xy_to_lonlat(u[:, 1:3])
    assert np.allclose(lonlat, df[["lon", "lat"]].to_numpy())


def test_out_of_bbox_points_are_clipped_not_nan():
    df = pd.DataFrame({"lon": [-130.0], "lat": [50.0], "time": pd.to_datetime([1], unit="D")})
    u = frame().to_unit(df)
    assert np.isfinite(u).all() and u[0, 1] == 0 and u[0, 2] == 1


def test_time_unit_is_the_baseline_duration_so_monitoring_follows_after_one():
    f = frame()
    df = pd.DataFrame({"lon": [-120.0], "lat": [38.0], "time": pd.to_datetime([12], unit="D")})
    assert abs(f.to_unit(df)[0, 0] - 1.2) < 1e-12
    assert f.time_to_ms([1.2])[0] == 12 * 86_400_000


def test_one_scale_for_both_axes_and_radius_conversion():
    f = frame()
    assert f.side_deg == 11.0                      # max(11, 11)
    assert abs(f.radius_deg(0.05) - 0.55) < 1e-12
    assert abs(f.radius_km(0.05) - 0.55 * 111.19) < 1e-9


def test_harmonize_raises_one_shared_cutoff_until_both_caps_hold():
    rng = np.random.default_rng(1)
    base = 3 + rng.exponential(0.5, 5000)
    mon = 3 + rng.exponential(0.5, 400)
    mc = harmonize_min_mag(base, mon, 3.0, max_baseline=1000, max_monitor=1000)
    assert mc > 3.0 and (base >= mc).sum() <= 1000 and (mon >= mc).sum() <= 1000
    assert (base >= mc - 0.1).sum() > 1000                         # ... and it is the *smallest* such cut
    assert harmonize_min_mag(base, mon, 3.0, 10**6, 10**6) == 3.0  # untouched when already within caps
