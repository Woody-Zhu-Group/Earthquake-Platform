# Notes on `score.py` / `detect.py` (the lab's algorithm)

The algorithm is used as written. Three edits were needed (listed first); everything after is **observed but not changed**,
so you can decide. "Verified" = reproduced here by running code; "by inspection" = read from the source only.
PyTorch was **not installable** where this was built, so nothing below was run against the real `ScoreModel`; the numpy replicas
mirror the maths, and `tests/test_score_torch.py` contains the torch checks (run in CI, skipped without torch).

## Edits made (diff against your uploads is exactly these)

| File | Change | Why | Status |
| --- | --- | --- | --- |
| `detect.py` | `from model.score import` -> `from .score import` | package layout | n/a |
| `detect.py` | `stat_list >= threshold` -> `np.asarray(stat_list) >= threshold` | `list >= float` raised `TypeError` in `stopping_time_and_region` | verified (`test_stopping_time_accepts_the_statistic_list`) |
| `score.py` | `fit()` returns early when `data` is empty | `find_index` raises on empty input; `detect.online` can refit on an empty window | crash verified on the numpy replica; torch test written, not run here |

## Findings that affect results (unchanged)

1. **The networks cannot learn input dependence.** Every `Linear` layer in `ff` is zero-initialised. Then all hidden
   activations are 0, so every weight gradient is 0; only the last layer's bias moves, and the LSTM gets no gradient at all.
   So `ScoreModel` is `base + a learned constant`. *Verified on a numpy replica* (gradients: W2 = 0, W1 = 0, b1 = 0, b2 != 0).
   This probably explains the check in `demo.ipynb` cell 16 ("did f0/f1 converge, or are they dominated by `base`?").
   Usual fix: zero-initialise only the *last* layer's weights. **Fixing it exposes #2**, so do them together.
2. **The LSTM runs over the batch, and `div` mixes samples.** `rn` is fed `[ndata, ndim]`, which PyTorch reads as one
   *sequence of length ndata* (not a batch). Training sees shuffled mini-batches; `psi` sees the whole catalogue in time order,
   so train and inference differ. And `div()` takes `d y_i / d x_i` of `y[:, i].sum()`, which includes how sample *j*'s input
   changes *later* samples' outputs, so the Hyvarinen divergence is not per-sample. Dormant today only because of #1. *By inspection.*
3. **`base` is built from an event count, not a rate.** `mu = median(kde * len(data))` has no time-span term, so f0 and f1
   are only comparable when fitted on data with the same time span. In `online`, f1 is refitted on short windows
   (`skip` of `ntt` steps) while f0 uses a whole baseline, so f1's `base` is scaled by window length. *By inspection.*
   **Handled in the pipeline for f0 vs the test data:** the time unit is the baseline duration (`geo.py`), so baseline and monitoring share one scale.
   The f1-window effect is inherent to `detect.online` and not corrected.
4. **Events with no earlier neighbour within `radius` are localised against event 0.** `find_index` returns `argmin` of an all-`inf`
   row = 0, so their "time since neighbour" is time since the first event. *Verified on a copy of the function.*
5. **Online detection cannot see a burst shorter than one refit batch.** `measure` for new events comes from f1 fitted on the
   *previous* batch (`ntt // n_update` grid steps, about 36 days with the defaults over 365 days). In the stand-in tests a
   20-day burst was invisible and a 150-day swarm was found. *Observed with the stand-in scorer; the mechanism is in `detect.online`.*
6. **Region lock-in.** Once a false alarm sets `omega`/`tau`, f1 is refitted only inside that region and after `tau`.
   With the (purely local) stand-in, 4 of 10 seeds locked onto a false alarm in the busiest area. The real f1 has a global
   `base` term and may behave differently. *Observed with the stand-in only.*

## Robustness

7. `online(n_update > ntt)` gives `skip = 0` and `ZeroDivisionError` at `i % skip`. *Verified.* Defaults (`ntt=100, n_update=10`) are fine.
8. `find_index` builds two dense `n x n` float64 matrices: about 0.06 GB at 2,000 events, 0.4 GB at 5,000, **6.4 GB at 20,000**.
   The pipeline caps events (`max_baseline_events`, `max_monitor_events`, default 3,000) by raising one shared magnitude cut-off.
9. `w()` takes `sqrt` of `min(x, 1-x)`; coordinates outside [0, 1] give NaN. `geo.py` clips space to [0, 1] (events outside the region box are filtered earlier).
10. There is no alarm threshold. `calibrate()` needs a list of pre-change datasets and is not wired in; the portal shows the raw
    statistic and `tau`, not a decision. Pick a threshold from calibration on baseline-period data before treating any value as an alarm.
11. `fit_kwds` of `lr=0` (as in `demo.ipynb`'s online section) means online refits only change `base`. That is the default here (`--update-lr 0`).

## `demo.ipynb`

Included unchanged under `analysis/notebooks/`. It imports `model.score`, `model.detect`, `model.simulator` (the version with a
`gp=` background argument) and `utils.plot.visualize`; none of those exist in this repository (only `simulator_old.py` was provided).
To run it, either fix the imports to `services.change_detection.*` or copy the notebook next to your original `model/` package. Its cell 11
fits f1 on `data_pre` (not `data_post`) in the offline section; that looks like a copy-paste slip, so check it before trusting the offline numbers.
