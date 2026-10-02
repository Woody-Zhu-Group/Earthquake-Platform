"""Regenerate the parity fixtures for the score-based CUSUM (website/src/score.js and detect.js).

    python -m tests.fixtures.make_score_fixtures        # needs numpy and scipy (dev-only, not a runtime dependency)

The reference functions below are copied verbatim from the Spatio-Temporal-Change-Detection repository
(model/score.py: find_index and the KDE base estimate; model/detect.py: inner_event, inner_grid, outer, cusum,
arg_cusum, generate_gridded_points) so the JavaScript port is checked against the original NumPy/SciPy code,
not against itself. torch is not needed because none of these functions use it.
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np
from scipy.spatial.distance import cdist
from scipy.stats import gaussian_kde

HERE = Path(__file__).parent


# ---- verbatim from model/score.py ------------------------------------------------------------
def find_index(data, radius):
    mat = cdist(data[:, 1:3], data[:, 1:3])
    mat = np.tril(mat)
    mask = np.logical_or(mat == 0., mat > radius)
    mat = cdist(np.arange(len(data))[:, None], np.arange(len(data))[:, None])
    mat[mask] = np.inf
    index = np.argmin(mat, axis=1)
    return index


def localize(data, radius):
    index = find_index(data, radius)
    data_loc = data.copy()
    data_loc[:, 0] = data[:, 0] - data[index, 0]
    return data_loc


def kde_mu(data):
    kde = gaussian_kde(data[:, 1:].T)
    local_density = kde(data[:, 1:].T) * len(data)
    return float(np.median(local_density))


# ---- verbatim from model/detect.py (static methods) ------------------------------------------
def generate_gridded_points(nres):
    x = np.linspace(0, 1, nres)
    y = np.linspace(0, 1, nres)
    xv, yv = np.meshgrid(x, y)
    return np.stack([xv.ravel(), yv.ravel()], axis=-1)


def cusum(arr):
    arr = np.cumsum(arr[::-1])[::-1]
    return arr.max()


def arg_cusum(arr):
    arr = np.cumsum(arr[::-1])[::-1]
    return arr.argmax()


def inner_grid(data, measure, tau, nres, t):
    mask1 = data[:, 0] >= tau
    mask2 = data[:, 0] < t
    mask = mask1 & mask2
    coords = data[:, 1:3][mask]
    points = generate_gridded_points(nres)
    mat = cdist(points, coords, metric='chebyshev')
    mask1 = mat < 1 / (2 * (nres - 1))
    val = mask1 @ measure[mask]
    return points[val > 1e-5]


def inner_event(data, measure, tau, t):
    mask1 = data[:, 0] >= tau
    mask2 = data[:, 0] < t
    mask3 = measure > 1e-5
    mask = mask1 & mask2 & mask3
    return data[:, 1:3][mask]


def outer(data, measure, omega, radius, t):
    mat = cdist(data[:, 1:3], omega, metric='chebyshev')
    mask1 = (mat < radius).any(1)
    mask2 = data[:, 0] < t
    mask = mask1 & mask2
    if mask.sum() > 0:
        i = arg_cusum(measure[mask])
        stat = cusum(measure[mask])
        tau = data[:, 0][mask][i]
    else:
        tau = t
        stat = 0
    return tau, stat


# ---- fixture generation -----------------------------------------------------------------------
def make_data(rng, n, with_ties=False):
    t = np.sort(rng.uniform(0, 2, n))
    xy = rng.uniform(0, 1, (n, 2))
    if with_ties:  # duplicate coordinates exercise the "distance exactly 0 is ignored" rule
        xy[5] = xy[2]
        xy[40] = xy[39]
    return np.column_stack([t, xy])


def main() -> None:
    rng = np.random.default_rng(2024)
    out = {"localize": [], "kde": [], "detect": []}

    for n, radius, ties in [(60, 0.1, False), (150, 0.05, True), (200, 0.3, True)]:
        data = make_data(rng, n, ties)
        out["localize"].append({"radius": radius, "data": data.tolist(), "expected": localize(data, radius).tolist()})

    for n in (80, 400):
        data = make_data(rng, n)
        out["kde"].append({"data": data.tolist(), "mu": kde_mu(data)})

    for n, nres, radius in [(120, 12, 0.08), (300, 20, 0.05)]:
        data = make_data(rng, n)
        measure = rng.normal(0.3, 1.0, n)
        cases = []
        for tau, t in [(0.0, 1.0), (0.4, 1.5), (1.0, 2.0), (0.0, 0.05)]:
            og = inner_grid(data, measure, tau, nres, t)
            oe = inner_event(data, measure, tau, t)
            tau_g, stat_g = outer(data, measure, og, 1 / (2 * (nres - 1)), t)
            tau_e, stat_e = outer(data, measure, oe, radius, t) if len(oe) else (t, 0)
            cases.append({
                "tau": tau, "t": t,
                "omega_grid": og.tolist(), "omega_event": oe.tolist(),
                "outer_grid": [float(tau_g), float(stat_g)], "outer_event": [float(tau_e), float(stat_e)],
            })
        out["detect"].append({"nres": nres, "radius": radius, "data": data.tolist(), "measure": measure.tolist(), "cases": cases})

    (HERE / "expected_score.json").write_text(json.dumps(out))
    print(f"wrote {HERE / 'expected_score.json'}")


if __name__ == "__main__":
    main()
