# Debug notes: `cusum_portal_draft` -> this repository

Source reviewed: `spatio_temporal_cusum_python_engine.py` (181 lines) and `index.html` (807 lines) at
`ArchithSharma/cusum_portal_draft@main`. The `.github/workflows` folder could not be read, so CI here is new.

Status key: **verified** = reproduced or covered by an automated test here; **by inspection** = fixed from reading
the code, not exercised in a browser.

## Behaviour changes (these can change numbers, so read first)

| # | Where | Original | Now | Status |
| - | ----- | -------- | --- | ------ |
| 1 | Python engine | CUSUM loop started at `t = 1` with `S[0]` fixed at 0, so the first time bin of every cell was never scored. | Loop starts at `t = 0` (`S_{-1} = 0`), matching the documented formula. | verified (`test_cusum_includes_the_first_observation`) |
| 2 | Portal | CUSUM ran over the *sequence of individual events* in a cell, with a baseline of `slider*1000/100` joule-like units unrelated to the data. Python binned energy in time and used each cell's own mean. The two never agreed. | Portal uses the Python algorithm: per-cell, time-binned energy, `mu_0` = cell mean, sample std (`ddof=1`), `k`/`h` in multiples of sigma, `MIN_EVENTS = 4`, at least 4 time bins. The meaningless baseline slider is replaced by a time-step selector and a `k` slider. | verified (parity tests on 3 configurations) |
| 3 | Portal | Population std (`ddof=0`) and a 3-event minimum. | `ddof=1` and 4 events, as pandas/Python. | verified |
| 4 | Portal | Loading data set the timeline to 0%, showing a nearly empty first window. | Timeline starts at 100% (most recent window). | by inspection |

If you need the *old* portal numbers, they were not a valid implementation of the stated algorithm; there is nothing to preserve.

## Bugs fixed (no change to the algorithm)

**Python**

- `--timestep 12H` / `6H` (the values suggested by `--help`) raised `Invalid frequency` on pandas >= 2.2 (verified on pandas 3.0). Steps are now normalised (`12H` -> `12h`). Test: `test_uppercase_hour_step_runs_on_current_pandas`.
- Empty USGS result crashed on `df['time'].min().strftime(...)`. Now reports "no usable events" and exits 0; the engine returns empty frames. Test: `test_empty_input_returns_empty_frames`.
- `run_spatio_temporal_cusum` wrote `lat_bin`, `lon_bin` and `energy` into the caller's DataFrame. It now works on a copy. Test: `test_sparse_cells_are_skipped_and_input_is_not_mutated`.
- Plot size `mag ** 2.5` is NaN for negative magnitudes (they occur in USGS data). Clipped at 0.
- Anomaly rings were drawn once per alarmed time step (hundreds of overlapping markers); now de-duplicated per cell.
- `matplotlib` was imported with the default backend, which fails on headless machines/CI. Uses `Agg`.
- Map path was hard-coded to the working directory and not configurable. Added `--map-output`, `--no-map`, and a default output folder (`CUSUM_OUTPUT_DIR`).
- `sys.exit(1)` inside the fetch function made it unusable as a library. It raises `UsgsFetchError`; the CLI converts it to an exit code.
- Events with null time or geometry raised `KeyError`/`TypeError`; they are now dropped (null depth becomes NaN).
- `props["mag"]` lookups used hard indexing; replaced with safe access.

**Portal (`index.html`)** *(all by inspection; no browser was available to run the page)*

- The playbar covered Leaflet's default zoom buttons; zoom control moved to the bottom right.
- Event popups injected `place` strings via template literals into HTML; now escaped.
- The popup labelled `10^(1.5M)` as "Energy Release ... J". It is a relative proxy, not joules; relabelled.
- The model re-ran (rebuilding every marker and heat layer) on every pan (`moveend`). Only `zoomend` changes the heatmap radius, so only that is bound.
- Zones were drawn as circles of radius `gridDeg * 111 km / 2`, which does not match the 2 degree x 2 degree cell actually tested. They are rectangles over the real cell bounds.
- After a failed or empty load, the stat cards kept stale numbers. They reset.
- Overlapping requests could race (slower old response overwrote a newer one). A request token now discards stale responses.
- No validation of start > end; empty results gave no message. Both handled.
- `Math.min(...times)` spreads up to 20,000 arguments; replaced with `reduce`.
- Status banner could not show a warning without looking like an error; added a separate warning style.
- The 20,000-event warning was rendered as an error even though data had loaded; now a warning.

## Not changed

Everything listed in [`METHOD_NOTES.md`](METHOD_NOTES.md). Those are properties of the algorithm, not bugs in its implementation.

## What was and was not tested

- Python: 24 unit/integration tests, run offline (`tests/`). The CLI is tested through `--input`.
- JavaScript: 6 `node:test` tests, including exact agreement with the Python engine on a shared synthetic dataset.
- **Not tested:** live calls to `earthquake.usgs.gov` (no network in the build environment), and the page rendering in a real browser. Run `python scripts/serve_site.py` and click through once before publishing.
