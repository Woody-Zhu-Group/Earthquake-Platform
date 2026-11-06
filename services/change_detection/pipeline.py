"""Per-region run: long-term baseline defines "normal" (f0), then ``SpatioTemporalDetector.online`` monitors.

The detector and score model are the lab's (``detect.py`` / ``score.py``) and are called as in ``demo.ipynb``'s
online section; this module prepares their input and reshapes their output for the portal.
"""
from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field
from pathlib import Path

import numpy as np
import pandas as pd

from shared.regions import Region

from .geo import UnitSquare, harmonize_min_mag

RESULT_VERSION = 2
YEAR_DAYS = 365.25
MIN_BASELINE_EVENTS = 50
MIN_MONITOR_EVENTS = 10
MAX_BASELINE_POINTS = 1500     # thinned long-term sample exported for the "normal activity" map layer


@dataclass
class DetectionConfig:
    max_baseline_events: int = 3000
    max_monitor_events: int = 3000
    # detector (demo.ipynb: ntt=100, K=5, nres=20, radius=0.05, use_grid=False)
    ntt: int = 100
    K: int = 5
    nres: int = 20
    radius: float = 0.05
    use_grid: bool = False
    n_update: int = 10
    window: int | None = None
    # score model (demo.ipynb)
    score_radius: float = 0.1
    ff_layers: list = field(default_factory=lambda: [64])
    rn_layers: int = 2
    rn_hidden: int = 64
    use_transform: bool = False
    # fitting f0 on the baseline
    batch_size: int = 256
    n_epochs: int = 400
    lr: float = 1e-3
    sigma: float = 0.1
    # online refits of f1 (demo.ipynb online: n_epochs=1, lr=0, so only the KDE-initialised `base` changes)
    update_epochs: int = 1
    update_lr: float = 0.0
    seed: int = 0


def _score_kwds(cfg):
    return dict(ndim=3, radius=cfg.score_radius, ff_layers=list(cfg.ff_layers), rn_layers=cfg.rn_layers,
                rn_hidden=cfg.rn_hidden, use_transform=cfg.use_transform)


def plan_periods(as_of, baseline_years, monitor_days, coverage_end=None):
    """(baseline_start, monitor_start, monitor_end). ``coverage_end`` trims a catalogue that lags (JMA)."""
    end = pd.Timestamp(as_of).normalize()
    if coverage_end is not None:
        end = min(end, pd.Timestamp(coverage_end).normalize())
    monitor_start = end - pd.Timedelta(days=monitor_days)
    return monitor_start - pd.Timedelta(days=baseline_years * YEAR_DAYS), monitor_start, end


def run_region(region: Region, as_of=None, cfg: DetectionConfig | None = None, *, baseline_years=None,
               monitor_days=None, fetch=None, jma_file=None, score_cls=None, detector_cls=None,
               progress=False) -> dict:
    """Fetch the region's catalogue, split it into baseline and monitoring periods, run the detector."""
    cfg = cfg or DetectionConfig()
    baseline_years = baseline_years or region.baseline_years
    monitor_days = monitor_days or region.monitor_days
    as_of = pd.Timestamp(as_of if as_of is not None else pd.Timestamp.now("UTC").tz_localize(None)).normalize()
    if fetch is None:
        from services.data_query import fetch_region_events

        def fetch(r, start, end, min_mag):
            return fetch_region_events(r, start, end, min_mag, jma_file=jma_file)

    lag = 2 * YEAR_DAYS if region.catalog == "jma" else 0   # newest JMA year may be unpublished: look further back
    start = as_of - pd.Timedelta(days=baseline_years * YEAR_DAYS + monitor_days + lag)
    events = fetch(region, start, as_of + pd.Timedelta(days=1), region.min_mag)
    if events.empty:
        raise ValueError(f"{region.name}: the catalogue returned no events")
    coverage = events["time"].max() if region.catalog == "jma" else None
    b0, m0, m1 = plan_periods(as_of, baseline_years, monitor_days, coverage)

    events = events.sort_values("time", kind="stable")
    baseline = events[(events["time"] >= b0) & (events["time"] < m0)]
    monitor = events[(events["time"] >= m0) & (events["time"] <= m1 + pd.Timedelta(days=1))]
    return run_detection(baseline, monitor, region, (b0, m0, m1), cfg, score_cls=score_cls,
                         detector_cls=detector_cls, progress=progress)


def run_detection(baseline: pd.DataFrame, monitor: pd.DataFrame, region: Region, periods, cfg: DetectionConfig,
                  *, score_cls=None, detector_cls=None, progress=False) -> dict:
    """f0 is fitted on ``baseline``; the detector then runs online over ``monitor``."""
    if score_cls is None:
        from .score import ScoreModel as score_cls
    if detector_cls is None:
        from .detect import SpatioTemporalDetector as detector_cls

    b0, m0, m1 = (pd.Timestamp(p) for p in periods)
    mc = harmonize_min_mag(baseline["mag"], monitor["mag"], region.min_mag,
                           cfg.max_baseline_events, cfg.max_monitor_events)
    baseline = baseline[baseline["mag"] >= mc].sort_values("time", kind="stable").reset_index(drop=True)
    monitor = monitor[monitor["mag"] >= mc].sort_values("time", kind="stable").reset_index(drop=True)
    if len(baseline) < MIN_BASELINE_EVENTS:
        raise ValueError(f"{region.name}: only {len(baseline)} baseline events at M>={mc}; "
                         f"need {MIN_BASELINE_EVENTS}. Lower min_mag or lengthen the baseline.")
    if len(monitor) < MIN_MONITOR_EVENTS:
        raise ValueError(f"{region.name}: only {len(monitor)} monitoring events at M>={mc}; need {MIN_MONITOR_EVENTS}.")

    frame = UnitSquare.for_region(region.bbox, origin_ms=int(b0.value // 10**6), unit_ms=int((m0 - b0).value // 10**6))
    base_unit, mon_unit = frame.to_unit(baseline), frame.to_unit(monitor)

    np.random.seed(cfg.seed)
    try:
        import torch
        torch.manual_seed(cfg.seed)
    except ImportError:
        pass
    f0, f1 = score_cls(**_score_kwds(cfg)), score_cls(**_score_kwds(cfg))
    f0.fit(base_unit, batch_size=cfg.batch_size, n_epochs=cfg.n_epochs, lr=cfg.lr, sigma=cfg.sigma)
    det = detector_cls(f0, f1)
    update = dict(batch_size=cfg.batch_size, n_epochs=cfg.update_epochs, lr=cfg.update_lr, sigma=cfg.sigma)
    tt, tau_list, omega_list, stat_list, measure = det.online(
        mon_unit, ntt=cfg.ntt, K=cfg.K, n_update=cfg.n_update, window=cfg.window, fit_kwds=update,
        verbose=progress, nres=cfg.nres, radius=cfg.radius, use_grid=cfg.use_grid)

    return build_result(cfg, region, frame, baseline, monitor, mon_unit, (b0, m0, m1), mc,
                        tt, tau_list, omega_list, stat_list, measure,
                        standin=bool(getattr(score_cls, "IS_STANDIN", False)))


def build_result(cfg, region, frame, baseline, monitor, mon_unit, periods, mc, tt, tau_list, omega_list,
                 stat_list, measure, standin=False) -> dict:
    b0, m0, m1 = periods
    measure = np.asarray(measure, dtype=float)
    pos_max = float(measure[measure > 0].max()) if np.any(measure > 0) else 1.0
    weight_by_xy: dict = {}
    for (x, y), m in zip(mon_unit[:, 1:3], measure):
        key = (float(x), float(y))
        weight_by_xy[key] = max(weight_by_xy.get(key, 0.0), max(float(m), 0.0) / pos_max)

    points, point_id, zone_index = [], {}, []
    for omega in omega_list:
        omega = np.asarray(omega, dtype=float).reshape(-1, 2)
        ids = []
        for (x, y), (lon, lat) in zip(omega, frame.xy_to_lonlat(omega)):
            key = (round(float(lon), 3), round(float(lat), 3))
            if key not in point_id:
                point_id[key] = len(points)
                points.append([key[0], key[1], round(weight_by_xy.get((float(x), float(y)), 1.0), 3)])
            ids.append(point_id[key])
        zone_index.append(ids)

    step = max(1, int(np.ceil(len(baseline) / MAX_BASELINE_POINTS)))
    ms = lambda ts: int(pd.Timestamp(ts).value // 10**6)  # noqa: E731
    b = frame.bounds()
    return {
        "version": RESULT_VERSION,
        "region": {"id": region.id, "name": region.name, "bbox": list(region.bbox), "catalog": region.catalog},
        "meta": {
            "algorithm": "score-matching spatio-temporal CUSUM, online (services/change_detection)",
            "standin": standin,
            "note": "Produced with a stand-in scorer for testing, NOT the score-matching model." if standin else "",
            "min_mag": mc, "min_mag_requested": region.min_mag,
            "n_baseline": int(len(baseline)), "n_monitor": int(len(monitor)),
        },
        "config": {k: (list(v) if isinstance(v, (list, tuple)) else v) for k, v in asdict(cfg).items()},
        "frame": {**{k: round(v, 4) for k, v in b.items()}, "side_deg": round(frame.side_deg, 4),
                  "radius_deg": round(frame.radius_deg(cfg.radius), 4), "radius_km": round(frame.radius_km(cfg.radius), 1)},
        "time": {"baseline_start_ms": ms(b0), "monitor_start_ms": ms(m0), "monitor_end_ms": ms(m1)},
        "tt_ms": [int(v) for v in frame.time_to_ms(tt)],
        "tau_ms": [int(v) for v in frame.time_to_ms(np.asarray(tau_list, dtype=float))],
        "stat": [round(float(s), 6) for s in stat_list],
        "zone_points": points,              # [lon, lat, weight 0..1]
        "zone_index": zone_index,           # per grid time: indices into zone_points (the estimated region omega)
        "event_columns": ["time_ms", "lon", "lat", "mag", "measure"],
        "events": [[ms(t), round(float(lo), 4), round(float(la), 4), round(float(m), 2), round(float(me), 5)]
                   for t, lo, la, m, me in zip(monitor["time"], monitor["lon"], monitor["lat"], monitor["mag"], measure)],
        "baseline_points": [[round(float(lo), 3), round(float(la), 3)]
                            for lo, la in zip(baseline["lon"].to_numpy()[::step], baseline["lat"].to_numpy()[::step])],
    }


def write_result(result: dict, path) -> Path:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(result, separators=(",", ":")), encoding="utf-8")
    return path


def stat_csv(result: dict) -> pd.DataFrame:
    return pd.DataFrame({
        "time": pd.to_datetime(result["tt_ms"], unit="ms"), "tau": pd.to_datetime(result["tau_ms"], unit="ms"),
        "cusum_stat": result["stat"], "region_points": [len(z) for z in result["zone_index"]],
    })
