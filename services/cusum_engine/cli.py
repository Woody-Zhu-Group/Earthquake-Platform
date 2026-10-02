"""Command line interface: ``python -m services.cusum_engine``."""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from shared.paths import output_dir

from .engine import run_spatio_temporal_cusum
from .usgs import UsgsFetchError, features_to_dataframe, fetch_usgs_historical, fetch_usgs_summary


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="Spatio-Temporal CUSUM Earthquake Anomaly Detector")
    src = p.add_argument_group("data source (default: --feed)")
    src.add_argument("--feed", default="all_month", help="USGS feed (all_day, all_week, all_month, 4.5_month)")
    src.add_argument("--start", help="Historical query start date YYYY-MM-DD (uses the FDSN API)")
    src.add_argument("--end", help="Historical query end date YYYY-MM-DD")
    src.add_argument("--min-mag", type=float, default=5.0, help="Historical minimum magnitude (default: 5.0)")
    src.add_argument("--input", help="Read a saved USGS GeoJSON file instead of the network")
    p.add_argument("--grid", type=float, default=2.0, help="Grid size in degrees (default: 2.0)")
    p.add_argument("--timestep", default="1D", help="Temporal binning step (1D, 12h, 6h)")
    p.add_argument("--k", type=float, default=0.5, help="Slack factor k (multiplied by std dev)")
    p.add_argument("--h", type=float, default=3.5, help="Threshold factor h (multiplied by std dev)")
    p.add_argument("--min-events", type=int, default=4, help="Minimum events per grid cell (default: 4)")
    p.add_argument("--output", help="CSV export path (default: <output dir>/cusum_anomalies.csv)")
    p.add_argument("--map-output", help="Map PNG path (default: <output dir>/cusum_spatial_map.png)")
    p.add_argument("--no-map", action="store_true", help="Skip the diagnostic map")
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    out = output_dir()
    csv_path = Path(args.output) if args.output else out / "cusum_anomalies.csv"
    map_path = Path(args.map_output) if args.map_output else out / "cusum_spatial_map.png"

    # 1. Fetch
    try:
        if args.input:
            df = features_to_dataframe(json.loads(Path(args.input).read_text(encoding="utf-8")))
        elif args.start or args.end:
            if not (args.start and args.end):
                print("[!] --start and --end must be given together.")
                return 2
            df = fetch_usgs_historical(args.start, args.end, args.min_mag)
        else:
            df = fetch_usgs_summary(args.feed)
    except (UsgsFetchError, ValueError, OSError) as exc:
        print(f"[!] {exc}")
        return 1

    if df.empty:
        print("[INFO] USGS returned no usable seismic events for this request.")
        return 0
    print(
        f"[+] Successfully loaded {len(df)} seismic events from "
        f"{df['time'].min().strftime('%Y-%m-%d')} to {df['time'].max().strftime('%Y-%m-%d')}."
    )

    # 2. Compute CUSUM
    try:
        anomalies_df, _grid_df = run_spatio_temporal_cusum(
            df, grid_deg=args.grid, time_step=args.timestep,
            k_factor=args.k, h_factor=args.h, min_events=args.min_events,
        )
    except ValueError as exc:
        print(f"[!] {exc}")
        return 2

    # 3. Report
    if not anomalies_df.empty:
        print(f"\n[ALERT] Detected {len(anomalies_df)} spatial CUSUM anomalies exceeding threshold h={args.h}*std!")
        print(anomalies_df[["grid_lat", "grid_lon", "timestamp", "cusum_score", "max_mag"]].head(10).to_string(index=False))
        csv_path.parent.mkdir(parents=True, exist_ok=True)
        anomalies_df.to_csv(csv_path, index=False)
        print(f"\n[+] Full anomaly report exported to '{csv_path}'.")
    else:
        print("\n[INFO] No CUSUM anomalies detected matching current criteria.")

    # 4. Visualisation
    if not args.no_map:
        try:
            from .plotting import generate_spatial_plot

            generate_spatial_plot(df, anomalies_df, map_path)
        except Exception as exc:  # plotting must never hide the analysis results
            print(f"[!] Could not generate map image: {exc}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
