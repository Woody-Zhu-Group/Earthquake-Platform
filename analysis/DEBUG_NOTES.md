# Debug log

## From the original `cusum_portal_draft`

The first version of this repository replaced that draft's simple per-cell CUSUM with a tested port. That algorithm has now been
**retired** in favour of the lab's score-matching detector (see `ALGORITHM_NOTES.md`); the previous zip still has it. Defects found in
the draft's *non-algorithmic* code and fixed here, in case they matter elsewhere:

* `--timestep 12H` crashed on pandas >= 2.2; an empty USGS result crashed; the plot failed on headless machines and for negative magnitudes;
  the engine mutated its input; popups injected unescaped text; the playbar covered the zoom buttons; stale responses could overwrite newer ones;
  the 20,000-event USGS cap was reported as an error. Those are carried into the current USGS client/portal where relevant.

## Changes in this version

* Per-region panels with long-term baselines; JMA catalogue for Japan; chunked USGS fetching (a 10-year query can exceed the 20,000-event FDSN cap, so long ranges are split automatically).
* Kernel smoothing layers and scrollable time (see `website/README.md`).
* The browser no longer runs any detection: it displays results written by Python. A browser port of a PyTorch model is not possible, so the portal
  cannot recompute `h`, `k` or radius interactively; rerun the CLI with different options instead.

## What was and was not tested

| Area | Tested here | Not tested here |
| --- | --- | --- |
| Region config, catalogue splitting, JMA parsing, USGS chunking, geometry, pipeline, CLI, detector logic | yes (46 Python tests, stand-in scorer for the model) | against real JMA/USGS responses (no network) |
| JMA record parser | against records built from the published column spec | against a real JMA file (none available offline). **Check one real file first** |
| `ScoreModel` / real detector accuracy | no (PyTorch unavailable) | everything in `tests/test_score_torch.py` and any claim about detection quality |
| Kernels, time maths, loader | yes (numerical checks, mutation-checked) | |
| Page behaviour | UI smoke test under a fake DOM and fake Leaflet (wiring, scrolling, keyboard, playback, file loading) | **real rendering in a browser**: layout, overlay alignment, colours, performance |
