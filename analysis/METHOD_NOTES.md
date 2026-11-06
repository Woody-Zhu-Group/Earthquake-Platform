# Method notes: regions, "normal", and what the portal shows

## How "normal" is defined

Each region (`shared/regions.json`) gets its own detector run. f0 is fitted on that region's own **long-term baseline**
(default 10 years) and the detector then runs *online* over the most recent **monitoring period** (default 365 days). A region that is
always busy (California) therefore has a high normal rate and is not flagged for being busy; only a departure from its own history counts.
`tests/test_pipeline.py::test_the_regional_baseline_is_what_keeps_a_busy_region_from_alarming` shows the effect with the stand-in
scorer: swap in a baseline 10x too quiet and the peak statistic rises 5-15x on identical monitoring data.

## Catalogue rules that make rates comparable

* **One magnitude cut-off for both periods.** Raised in 0.1 steps from the region's `min_mag` until the baseline and monitoring
  periods both fit under their event caps. The effective cut-off is stored in the result (`meta.min_mag`).
* **One catalogue per region.** California, the Americas and Indonesia use USGS ComCat; Japan uses the JMA unified hypocenter
  catalogue only (agency J, natural events), never mixed with USGS.
* **Detection ends where the data ends.** The JMA bulletin is published per year and lags; the Japan panel monitors up to the
  newest JMA data actually found, not "today". The page for the file list showed 2024 as the newest year when checked, so on a given
  day Japan's monitoring window can be well behind the other panels. The panels share one time cursor and each simply stops at its own end.
* **Completeness is not modelled.** Catalogues are incomplete just after large shocks and in remote areas; changes in network coverage can look like change.

## Choices that are mine, not the lab's

* Region boxes are rectangles and are editable in `shared/regions.json`. "Central & South America" is a tall box (76 degrees)
  and "Sumatra / Indonesia" a wide one (49 degrees); the detector's square is `max(width, height)` degrees, so `radius = 0.05` is
  about 3.8 degrees (about 420 km) for the Americas but 0.6 degrees for California.
* Baseline contamination: a 10-year baseline can contain sequences such as Ridgecrest 2019, Kumamoto 2016 or Noto 2024. They
  raise the "normal" rate. Shorten `baseline_years` or move `as_of` if that matters.
* The kernel layers are display tools, not part of the detector: they smooth events and the detector's region omega for viewing.

## What the portal does not show

No significance level, no false-alarm rate, no forecast. See `ALGORITHM_NOTES.md` #10.
