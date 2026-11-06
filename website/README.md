# Website

Static Leaflet portal: one world map; the detector regions are clickable boxes that zoom in. No build toolchain or runtime dependencies; Node is only
used for tests and for copying the site into `docs/`.

```
index.html          page shell and sidebar controls
src/main.js         wiring: time cursor, playback, wheel/keyboard scrolling, file loading
src/worldmap.js     the world map: region boxes, kernel overlays, chips, scrubbable timeline strip
src/events.js       global event pool (region events + live events outside the regions), magnitude filter
src/kernel.js       kernel density smoothing (Gaussian / Epanechnikov / quartic / uniform) + colour scale
src/timeline.js     time-axis maths (histogram, wheel -> time, clamping)
src/results.js      loader/validator for detector result files and per-time queries
src/api.js          region config, result files, live USGS fallback
tests/              node:test suites, including a UI smoke test run under a fake DOM
scripts/build.mjs   copies index.html, src/ and shared/regions.json into ../docs
```

```bash
cd website
npm test            # kernel/time/results unit tests + UI smoke test
npm run build       # refresh ../docs
npm run check       # fail if ../docs is stale (used by CI)
```

Preview from the repository root: `python scripts/serve_site.py`, then open <http://127.0.0.1:8770/>. The page uses ES
modules, so double-clicking `index.html` (`file://`) does not work.

## Data

On start the page reads `./regions.json` (the four regions), then `./data/index.json` and the result files it lists.
Worldwide events come live from USGS (M4.5+, chunked); inside regions that have a result file, that file's events are used instead. A region without a result file is still clickable but shows a notice.
Result files can also be loaded by hand with the file picker.

To try the interface without running PyTorch, load `tests/fixtures/standin_california.json` with the file picker.
It is produced by a stand-in scorer and is labelled as such on screen; it is not output of the score-matching model.

## Time navigation

All panels share one time cursor. Move it by scrolling on any timeline strip, dragging a strip, dragging the top slider,
the step buttons, or the keyboard (`←`/`→`, `Shift` = 10x, `Home`/`End`, `Space`). `Shift`+wheel over a map scrolls time;
a checkbox makes the plain wheel over maps do so too (otherwise it zooms). On a strip, `Shift` scrolls 5x faster and `Alt`
5x slower. The strip shows events per period (blue), the CUSUM statistic (magenta), the observation window (shaded),
the current change-point estimate tau (dashed orange) and the cursor (white).

## Kernels

Two separate kernel layers, each with its own kernel shape, bandwidth h (km) and saturation:

* **Event kernel**: smooths the events in the observation window (each counts 1, or magnitude/5).
* **Anomaly-zone kernel**: smooths the detector's estimated region omega at the cursor time, weighted by each point's
  anomaly measure (0..1).

Colour is absolute: 1.0 = `saturation` unit-weight points stacked in one place, so intensity is comparable while
scrolling. Kernels are evaluated in km on the sphere's local scale; if a bandwidth is finer than the screen resolves it is
widened to 1.5 grid cells and the panel says so ("h≈ ... km"). An optional third layer shows the long-term normal rate as
the expected number of events in the window, on the same colour scale as the events layer.
