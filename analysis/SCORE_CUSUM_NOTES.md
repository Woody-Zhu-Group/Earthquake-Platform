# Score-based CUSUM in the portal: what to know

Source: `score.py`, `detect.py`, `simulator.py`, `demo.ipynb` from the Spatio-Temporal-Change-Detection code.

## Status of the two CUSUMs in this repository

| | Portal (`website/`) | Python engine (`services/cusum_engine`) |
| - | - | - |
| Algorithm | score-based CUSUM (this port) | per-cell energy CUSUM (original draft, audited in DEBUG_NOTES.md) |
| Tests | Node: parity with NumPy/SciPy reference, finite-difference psi, synthetic change recovery | pytest + parity with `website/src/cusum.js` |

The portal and the Python CLI therefore no longer agree. Either port the score model to Python (torch version
is the original) or retire the energy engine; the parity tests only cover the legacy `cusum.js`.

## Limits observed while porting

1. **Detection quality depends on the training budget.** On an earthquake-like synthetic catalog (clustered
   hubs, swarm of 400 events) 80 epochs left the anomaly measure of the swarm indistinguishable from background;
   200 epochs for `f0` and 40 for each `f1` refit separated it (mean measure 64 vs 1). The demo notebook trains 400
   epochs. The portal uses a step budget (about 2500 optimiser steps for `f0`).
2. **Noise level.** DSM uses sigma = 0.1 on all coordinates (time gaps and unit-square space). Changes that push
   local time gaps far below sigma (rate x10 or more in the synthetic test) make the learned score stop
   discriminating. A per-coordinate sigma scaled to the data was tried and did not clearly help, so it was removed.
3. **The statistic drifts upward after the baseline** because `f0` is out of sample and `f1` lags; that is why the
   threshold is a multiple of the baseline maximum and the default is 2.5, not 1.
4. **Unit-square assumption.** Coordinates are rescaled with one isotropic factor from the loaded catalog; a global
   catalog squeezes regional structure (5 degrees is ~1.4 % of the unit square). Radii are therefore in degrees.
5. **Online adaptation absorbs a persistent change**: after `f1` is refitted on post-change data the statistic
   falls again, so S/h is highest shortly after a change, not forever.
6. Same cautions as METHOD_NOTES.md: screening tool, not a hazard model or forecast.

## Not tested

The page itself (Leaflet, canvas kernels, wheel handling) was not run in a browser: the build environment has no
network and no browser. Run `python scripts/serve_site.py`, load a range, and check: kernels follow pan/zoom,
Shift+wheel scrubs without zooming, the strip drag works on touch, and the first fit completes in a few seconds.
