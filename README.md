# CUSUM Platform

A spatio-temporal **CUSUM** (cumulative sum) earthquake-anomaly platform: a Python engine that pulls live or
historical USGS data and flags swarm-like energy spikes per grid cell, plus an interactive map portal that runs
the same algorithm in the browser. Opening the website needs no database, API key, or local server beyond a static file server.

## How it works

The **portal** runs the score-based spatio-temporal CUSUM from the Spatio-Temporal-Change-Detection code
(`score.py`, `detect.py`), ported to JavaScript:

```
USGS events (t, lon, lat) -> unit square, baseline period -> time [0, 1]
  f0: score model fitted (denoising score matching) on the baseline period
  f1: score model refitted online on recent events inside the estimated change region
  measure_i = psi_f0(event_i) - psi_f1(event_i)          (weighted Hyvarinen score difference)
  per time step, K rounds of:  omega = events with positive measure in [tau, t)
                               tau, S = argmax / max of the reverse cumulative sum of measure in omega x [0, t)
  alarm when S > h,   h = multiplier x the largest S seen during the baseline period
```

Two kernels turn the result into map layers: a **kernel density of the events** in the observation window and a
**kernel-smoothed anomaly zone** (every event in the estimated change region contributes its anomaly measure; the
zone boundary is the 30 % contour of the smoothed surface). Time is scrubbed by scrolling.

The **Python engine** (`services/cusum_engine`) still implements the earlier per-cell *energy* CUSUM
(`S_t = max(0, S_{t-1} + X_t - mu_0 - k)` on `10^(1.5 M)` per 2-degree cell). It is no longer what the portal runs;
see [`analysis/SCORE_CUSUM_NOTES.md`](analysis/SCORE_CUSUM_NOTES.md).

## Layout

```
website/                     # static Leaflet portal source and Node tests
  src/score.js               # score model: DSM fit, localisation, weighted Hyvarinen psi (port of score.py)
  src/detect.js              # detector: inner/outer CUSUM, online mode (port of detect.py)
  src/kernels.js             # kernel density / smoothing, contours, region count (DOM-free)
  src/kernel-layer.js        # Leaflet canvas layer for the two kernels
  src/timeline.js            # timeline strip + wheel/drag scrubbing
  src/cusum.js               # legacy energy CUSUM (port of the Python engine; parity-tested, not used by the portal)
  src/api.js                 # USGS clients
  src/main.js                # map, controls, playback
  scripts/build.mjs          # copies the site into docs/
docs/                        # built GitHub Pages entrypoint
services/cusum_engine/       # Python engine, USGS access, plotting, CLI
shared/                      # cross-service utilities (paths)
scripts/                     # serve_site.py (local preview)
tests/                       # pytest suite + shared parity fixtures
analysis/                    # DEBUG_NOTES.md, METHOD_NOTES.md
data/outputs/                # generated CSV/PNG (gitignored)
.github/workflows/ci.yml     # pytest + node tests + docs freshness
```

## Quick start: website

```bash
python scripts/serve_site.py          # then open http://127.0.0.1:8770/
```

Pages is served from `docs/` (**Settings -> Pages -> Deploy from a branch -> `main` / `/docs`**). The page loads
Leaflet from unpkg, tiles from OpenStreetMap, and data from `earthquake.usgs.gov`, so it needs internet access.
For development (Node 20+):

```bash
cd website
npm test            # unit tests + Python parity
npm run build       # refresh ../docs   (commit source and docs together)
```

Using the portal: pick **Historical** (date range + minimum magnitude, up to 20,000 events) or a **Real-time feed**;
set the observation window, the baseline share used to train the score models, the two radii, the threshold and the
two kernel bandwidths. Move through time by **scrolling over the timeline strip** (or the top bar), **Shift+scroll
(or a horizontal trackpad swipe) over the map**, dragging the strip, the arrow keys (Shift = faster, Home/End), or
Play (Space). The red contour is the smoothed anomaly zone, drawn only while S > h.

## Quick start: Python engine

```bash
python -m venv .venv && source .venv/bin/activate     # Windows: .venv\Scripts\Activate.ps1
pip install -r requirements.txt
python -m services.cusum_engine --feed all_month
```

Writes `data/outputs/cusum_anomalies.csv` and `data/outputs/cusum_spatial_map.png`. Historical queries
(`--start 2024-01-01 --end 2025-12-31 --min-mag 5.5`), offline input (`--input saved.geojson`), and every flag are
documented in [`services/cusum_engine/README.md`](services/cusum_engine/README.md).

Configuration is optional; see [`.env.example`](.env.example).

## Tests

```bash
pip install -r requirements-dev.txt && python -m pytest        # Python
cd website && npm test                                          # JavaScript + parity with Python
```

The legacy energy CUSUM must be changed in both implementations (then `python -m tests.fixtures.make_fixtures`).
The score-based port is checked against the original NumPy/SciPy functions through
`tests/fixtures/expected_score.json` (regenerate with `python -m tests.fixtures.make_score_fixtures`; needs scipy).

## Notes and limits

- This is a screening tool for unusual seismic energy release, **not** a hazard model or earthquake forecast.
- Algorithm caveats (in-sample baseline, no reset after alarm, ...) are in [`analysis/METHOD_NOTES.md`](analysis/METHOD_NOTES.md).
- Bugs fixed relative to the original draft, and the two intentional behaviour changes, are in
  [`analysis/DEBUG_NOTES.md`](analysis/DEBUG_NOTES.md).

## Documentation

| Doc | Covers |
| --- | --- |
| [`website/README.md`](website/README.md) | Website structure, tests, build |
| [`docs/README.md`](docs/README.md) | GitHub Pages output |
| [`services/cusum_engine/README.md`](services/cusum_engine/README.md) | CLI flags and algorithm |
| [`analysis/DEBUG_NOTES.md`](analysis/DEBUG_NOTES.md) | Debug log |
| [`analysis/METHOD_NOTES.md`](analysis/METHOD_NOTES.md) | Method caveats |
