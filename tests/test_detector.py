"""detect.py logic with the stand-in scorer (the detector itself is the lab's, unmodified apart from two lines)."""
import numpy as np

from services.change_detection.detect import SpatioTemporalDetector
from tests.standin import StandInScore


def make(n=300, seed=0):
    rng = np.random.default_rng(seed)
    t = np.sort(rng.uniform(0, 1, n))
    xy = rng.uniform(0, 1, (n, 2))
    burst = (t > 0.6) & (np.abs(xy - 0.7).max(1) < 0.15)
    xy[burst] = rng.uniform(0.6, 0.8, (burst.sum(), 2))
    return np.column_stack([t, xy]), burst


def test_cusum_helpers():
    arr = np.array([1.0, -2.0, 3.0, 1.0])
    assert SpatioTemporalDetector.cusum(arr) == 3.0 + 1.0 and SpatioTemporalDetector.arg_cusum(arr) == 2


def test_stopping_time_accepts_the_statistic_list():
    """Regression: `stat_list >= threshold` compared a list with a float and raised TypeError."""
    data, _ = make()
    f0, f1 = StandInScore(), StandInScore()
    f0.fit(data[:100]); f1.fit(data[200:])
    det = SpatioTemporalDetector(f0, f1)
    t_hi, _ = det.stopping_time_and_region(data, threshold=1e12, ntt=15, K=2)     # never crossed -> last time
    t_lo, region = det.stopping_time_and_region(data, threshold=0.0, ntt=15, K=2)  # crossed immediately
    assert t_lo <= t_hi and region.shape[1] == 2


def test_offline_outputs_are_consistent():
    data, _ = make()
    f0, f1 = StandInScore(), StandInScore()
    f0.fit(data[:100]); f1.fit(data[100:])
    tt, tau, omega, stat, measure = SpatioTemporalDetector(f0, f1).offline(data, ntt=12, K=2, verbose=False)
    assert len(tt) == len(tau) == len(omega) == len(stat) == 12 and len(measure) == len(data)
    assert all(a <= b for a, b in zip(tt, tt[1:]))
