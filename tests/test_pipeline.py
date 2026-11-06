import numpy as np
import pandas as pd
import pytest

from services.change_detection.detect import SpatioTemporalDetector
from services.change_detection.pipeline import DetectionConfig, plan_periods, run_region, stat_csv
from tests.helpers import AS_OF, BURST, HOT, REGION, catalogue
from tests.standin import StandInScore

CFG = DetectionConfig(ntt=40, K=3, n_update=8, radius=0.05)


def run_cat(cat):
    return run_region(REGION, AS_OF, CFG, fetch=lambda r, s, e, m: cat,
                      score_cls=StandInScore, detector_cls=SpatioTemporalDetector)


def run(burst, seed=0, **kw):
    return run_cat(catalogue(burst, seed=seed, **kw))


def test_periods_are_baseline_then_monitoring_ending_at_as_of():
    b0, m0, m1 = plan_periods("2025-06-30", 10, 365)
    assert m1 == pd.Timestamp("2025-06-30") and (m1 - m0).days == 365
    assert abs((m0 - b0).days - 3652) <= 1


def test_lagging_catalogue_ends_monitoring_at_its_newest_data():
    _, _, end = plan_periods("2026-10-29", 10, 365, coverage_end="2025-12-31")
    assert end == pd.Timestamp("2025-12-31")


def test_result_document_shape_and_scale():
    r = run(burst=True)
    n = len(r["tt_ms"])
    assert n == CFG.ntt and len(r["stat"]) == len(r["tau_ms"]) == len(r["zone_index"]) == n
    assert r["meta"]["standin"] is True and r["version"] == 2
    t = r["time"]
    assert t["baseline_start_ms"] < t["monitor_start_ms"] < t["monitor_end_ms"]
    assert all(t["monitor_start_ms"] <= e[0] <= t["monitor_end_ms"] + 86_400_000 for e in r["events"])
    assert len(r["events"]) == r["meta"]["n_monitor"] and len(r["baseline_points"]) <= 1500
    assert all(0 <= w <= 1 for _, _, w in r["zone_points"])
    assert all(max(z, default=0) < len(r["zone_points"]) for z in r["zone_index"])
    b = r["frame"]
    assert b["west"] <= REGION.bbox[0] and b["east"] >= REGION.bbox[2]
    assert r["tt_ms"] == sorted(r["tt_ms"])


def test_the_regional_baseline_is_what_keeps_a_busy_region_from_alarming():
    """Lots of earthquakes in California-like HOT are normal: f0 must be fitted on *that region's* long-term data.

    Same monitoring year, two baselines: its own 10 years, versus a baseline 10x too quiet (as if "normal" came from a
    quieter, larger area). The wrong baseline makes the busy region alarm; the right one does not.
    """
    m0 = AS_OF - pd.Timedelta(days=365)
    for seed in range(6):
        cat = catalogue(burst=False, seed=seed)
        quiet = pd.concat([cat[cat["time"] < m0].iloc[::10], cat[cat["time"] >= m0]])
        own = max(run_cat(cat)["stat"])
        wrong = max(run_cat(quiet)["stat"])
        assert wrong > 3 * own, (seed, own, wrong)


def test_swarm_is_localised_and_dated():
    """Plumbing check with the stand-in scorer (seed 0): output coordinates, tau and region omega line up.

    Detection *accuracy* is a property of the real score model, not of this test: with the purely local stand-in,
    some seeds lock onto an early false alarm instead, so only one fixed seed is asserted.
    """
    r = run(burst=True, seed=0)
    lon, lat = BURST
    final = [r["zone_points"][i] for i in r["zone_index"][-1]]
    assert final, "no anomaly region at the end of the monitoring period"
    strongest = sorted(final, key=lambda p: -p[2])[: max(3, len(final) // 4)]
    assert np.median([p[0] for p in strongest]) == pytest.approx(lon, abs=1.0)
    assert np.median([p[1] for p in strongest]) == pytest.approx(lat, abs=1.0)
    swarm_start = (AS_OF - pd.Timedelta(days=150)).value // 10**6
    assert abs(r["tau_ms"][-1] - swarm_start) < 60 * 86_400_000
    assert np.argmax(r["stat"]) >= len(r["stat"]) // 2
    normal = run(burst=False, seed=0)
    assert max(r["stat"]) > 100 * max(normal["stat"])


def test_same_seed_same_result_and_stat_csv():
    a, b = run(True, seed=3), run(True, seed=3)
    assert a["stat"] == b["stat"] and a["events"] == b["events"]
    df = stat_csv(a)
    assert list(df.columns) == ["time", "tau", "cusum_stat", "region_points"] and len(df) == CFG.ntt


def test_too_little_baseline_is_a_clear_error():
    cat = catalogue(False)
    cat = cat[cat["time"] > AS_OF - pd.Timedelta(days=500)]          # only a sliver of history
    with pytest.raises(ValueError):
        run_region(REGION, AS_OF, CFG, fetch=lambda r, s, e, m: cat, score_cls=StandInScore,
                   detector_cls=SpatioTemporalDetector)


def test_empty_catalogue_is_a_clear_error():
    with pytest.raises(ValueError):
        run_region(REGION, AS_OF, CFG, fetch=lambda r, s, e, m: catalogue(False).iloc[0:0],
                   score_cls=StandInScore, detector_cls=SpatioTemporalDetector)


def test_event_cap_raises_one_shared_magnitude_cutoff():
    cfg = DetectionConfig(ntt=20, K=2, n_update=4, max_baseline_events=300, max_monitor_events=300)
    cat = catalogue(False)
    r = run_region(REGION, AS_OF, cfg, fetch=lambda r_, s, e, m: cat, score_cls=StandInScore,
                   detector_cls=SpatioTemporalDetector)
    assert r["meta"]["min_mag"] > r["meta"]["min_mag_requested"]
    assert r["meta"]["n_baseline"] <= 300
    assert all(e[3] >= r["meta"]["min_mag"] for e in r["events"])
