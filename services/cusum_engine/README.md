# CUSUM engine

Python implementation of the spatio-temporal CUSUM detector (`engine.py`), USGS access (`usgs.py`),
the diagnostic map (`plotting.py`) and the CLI (`cli.py`).

```bash
python -m services.cusum_engine                                  # past 30 days, all quakes
python -m services.cusum_engine --feed 4.5_month --h 3.0
python -m services.cusum_engine --start 2024-01-01 --end 2025-12-31 --min-mag 5.5
python -m services.cusum_engine --input saved.geojson --timestep 12h --no-map
```

| Flag | Default | Meaning |
| --- | --- | --- |
| `--feed` | `all_month` | USGS summary feed (`all_day`, `all_week`, `all_month`, `4.5_month`, ...) |
| `--start/--end/--min-mag` | none / none / `5.0` | Historical FDSN query instead of a feed (same query as the website) |
| `--input` | none | Saved USGS GeoJSON file instead of the network |
| `--grid` | `2.0` | Grid cell size in degrees |
| `--timestep` | `1D` | Temporal bin (`1D`, `12h`, `6h`; `12H` is accepted too) |
| `--k` / `--h` | `0.5` / `3.5` | Slack and threshold, in multiples of the cell's sigma |
| `--min-events` | `4` | Minimum events for a cell to be tested |
| `--output` / `--map-output` | `data/outputs/...` | CSV and PNG paths (`--no-map` skips the PNG) |

Exit codes: `0` success, `1` data fetch or read failure, `2` invalid arguments.

Algorithm (unchanged from the original draft):
`E = 10^(1.5 M)` per event, summed per cell per time step; `S_t = max(0, S_{t-1} + X_t - mu_0 - k)` with
`mu_0` the cell's mean and `sigma_0` its sample standard deviation, `k = k_factor * sigma_0`,
`h = h_factor * sigma_0`; alarm when `S_t > h`.
