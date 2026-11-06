# CUSUM Platform

Regional earthquake change detection with the lab's score-matching spatio-temporal CUSUM. One world map shows earthquakes everywhere; four outlined regions, clickable to zoom in, define **normal** from that region's long-term catalogue and then monitor the most recent period online:

| Panel | Catalogue | Box (W, S, E, N) |
| --- | --- | --- |
| California | USGS ComCat | -125.5, 32, -114, 42.5 |
| Japan and surroundings | **JMA** unified hypocenter catalogue | 122, 24, 150, 46 |
| Central & South America | USGS ComCat | -95, -56, -60, 20 |
| Sumatra / Indonesia | USGS ComCat | 92, -12, 141, 8 |

Boxes, starting magnitude cut-offs, baseline length and monitoring length are in [`shared/regions.json`](shared/regions.json).

## How it fits together

```
catalogue (USGS / JMA) -> per region: baseline (10 y) | monitoring (1 y)
   -> unit cube (time unit = baseline length) -> f0 fitted on the baseline
   -> SpatioTemporalDetector.online over the monitoring period -> cusum_<region>.json
website: one world map; events worldwide (USGS live, M4.5+) plus each region's own events; the detector layers exist only inside the four regions; click a region to zoom in
```

The detector needs PyTorch, so it runs in Python (`services/change_detection`); the website (`website/`, published from `docs/`) only displays its output.

## Quick start

```bash
pip install -r requirements.txt                       # CPU PyTorch is enough
python -m services.change_detection --as-of 2025-12-31   # all four regions -> data/outputs/
cp data/outputs/*.json docs/data/                        # publish (mkdir -p docs/data first)
python scripts/serve_site.py                             # http://127.0.0.1:8780/
```

Single region: `--region california`. No network: `--region synthetic` (the lab's simulator). Japan from a file you downloaded:
`--region japan --jma-file h2024.zip`. Options: [`services/change_detection/README.md`](services/change_detection/README.md).
To try the interface without PyTorch, open the page and load `tests/fixtures/standin_california.json` with the file picker (labelled as a stand-in on screen).

## Using the portal

* **World map, click to zoom:** events are drawn worldwide, but the CUSUM detector only runs on the four boxes (precomputed by the Python service, loaded from `docs/data`). Click a box or its chip to zoom in and see that region's anomaly zones, tau and statistic; `Esc` or the World button zooms out. Outside the boxes there is no detector output.
* **Scroll through time:** wheel on the timeline strip (Shift = 5x, Alt = 0.2x), drag a strip, or use the keyboard (`←` `→`, `Shift` = 10x, `Home`, `End`, `Space`). `Shift`+wheel over a map scrolls time too; a checkbox makes plain wheel do so (otherwise it zooms). Play/pause and the top slider still work.
* **Two kernels:** one smooths events in the observation window, one smooths the detector's anomaly region at the cursor time. Each has its own kernel (Gaussian, Epanechnikov, quartic, uniform), bandwidth in km and colour saturation. Colour is absolute, so brightness is comparable while scrolling.
* **Info chips** (world view: one per region; zoomed: the selected region) show events in the window, the CUSUM statistic now and at its peak, the change-point estimate tau, the size of the region, and how much history defines normal. An optional layer shows the long-term normal rate on the same scale as the events.

## Layout

```
website/                  static portal source (worldmap.js = the map, events.js = global event pool) + Node tests (kernels, time maths, loader, UI smoke test)
docs/                     built GitHub Pages entrypoint (docs/data = detector results)
services/change_detection score.py, detect.py (lab's algorithm), geo.py, pipeline.py, cli.py, synthetic.py
services/data_query/      USGS (chunked) and JMA catalogue access
shared/                   regions.json / regions.py, paths
scripts/                  serve_site.py
tests/                    pytest suite (stand-in scorer), fixtures
analysis/                 ALGORITHM_NOTES, METHOD_NOTES, DEBUG_NOTES, demo notebook
.github/workflows/ci.yml  pytest (with CPU torch) + node tests + docs freshness
```

## Tests

```bash
pip install -r requirements-dev.txt && python -m pytest      # Python; torch-gated tests run when torch is installed
cd website && npm test                                          # JavaScript
cd website && npm run build                                     # refresh docs/ (CI fails if it is stale)
```

## Read before relying on results

* **Not run here:** the real `ScoreModel` (PyTorch unavailable where this was built), real JMA files, live USGS calls, and the page in a real browser. See [`analysis/DEBUG_NOTES.md`](analysis/DEBUG_NOTES.md) for exactly what was and was not tested; check one real JMA file and one real run first.
* [`analysis/ALGORITHM_NOTES.md`](analysis/ALGORITHM_NOTES.md): issues found in `score.py` / `detect.py`, including that every layer of the network is zero-initialised so it cannot currently learn anything input-dependent.
* The portal shows the raw statistic and region, not an alarm decision (no calibrated threshold). It is a research display, not a hazard model or forecast.
