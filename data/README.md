# data/

* `outputs/`: default output folder of `python -m services.change_detection` (gitignored apart from `.gitkeep`).
* `cache/jma/`: downloaded JMA yearly files `h<year>.zip` (gitignored). Delete a file to force a re-download.

No source catalogues are stored: USGS is queried live and JMA is downloaded on demand (or pass `--jma-file`).
