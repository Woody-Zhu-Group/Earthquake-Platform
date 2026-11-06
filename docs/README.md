# docs/

Built GitHub Pages entrypoint, generated from `website/` (plus `shared/regions.json`) by `npm run build`.
Do not edit by hand: commit `website/` source and `docs/` output together (CI fails if they differ).

`docs/data/` is where detector results go: copy the output folder of
`python -m services.change_detection` here (`index.json` + `cusum_<region>.json`) and commit it; the page loads it on start.

Enable Pages with **Settings -> Pages -> Deploy from a branch -> `main` / `/docs`**.
