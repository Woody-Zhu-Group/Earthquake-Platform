# data/

`outputs/` receives the CLI's generated files (`cusum_anomalies.csv`, `cusum_spatial_map.png`) and is
gitignored apart from `.gitkeep`. This project reads live USGS data and stores no source datasets;
use `--input quakes.geojson` to analyse a saved USGS GeoJSON file offline.
