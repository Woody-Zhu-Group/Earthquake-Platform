# Change detection service

`score.py`, `detect.py`, `simulator_old.py` are the lab's algorithm (three small documented edits, see `analysis/ALGORITHM_NOTES.md`).
The rest prepares data and writes portal files.

| File | Role |
| --- | --- |
| `geo.py` | region box -> unit square; time unit = baseline duration; shared magnitude cut-off |
| `pipeline.py` | `run_region`: fetch, split baseline/monitoring, fit f0 on the baseline, `SpatioTemporalDetector.online`, build result JSON |
| `cli.py` | `python -m services.change_detection` |
| `synthetic.py` | `demo.ipynb`'s simulator as a demo "region" (`--region synthetic`) |

```bash
pip install -r requirements.txt
python -m services.change_detection --as-of 2025-12-31                 # all four regions
python -m services.change_detection --region california --region americas
python -m services.change_detection --region japan --jma-file ~/Downloads/h2024.zip   # use a manually downloaded JMA file
python -m services.change_detection --region synthetic --epochs 50     # no network; demo.ipynb simulator
```

Output (default `data/outputs/`): `cusum_<region>.json` (portal file), `cusum_<region>_stat.csv` (time, tau, statistic) and `index.json`.
A region that fails (too few events, no data) is recorded in `index.json` and the others still run; exit code is `1` only if all fail, `3` if PyTorch is missing.
Copy the folder to `docs/data/` to publish.

Per region (`shared/regions.json`): `catalog` (`usgs`/`jma`), `bbox`, starting `min_mag`, `baseline_years` (default 10), `monitor_days` (default 365).
Useful flags: `--baseline-years`, `--monitor-days`, `--max-baseline-events`, `--ntt`, `--radius`, `--epochs`, `--update-lr`, `--seed`.
Runtime is dominated by fitting f0 (`--epochs`, default 400) on up to 3,000 baseline events per region, on CPU.
