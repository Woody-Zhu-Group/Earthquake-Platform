"""``python -m services.change_detection --region california``: fetch, define normal, monitor, write portal JSON."""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import pandas as pd

from services.data_query import JmaFetchError, UsgsFetchError
from shared.paths import output_dir
from shared.regions import load_regions

from .pipeline import DetectionConfig, run_region, stat_csv, write_result


def build_parser() -> argparse.ArgumentParser:
    regions = load_regions()
    p = argparse.ArgumentParser(description="Per-region score-matching CUSUM on earthquake catalogues")
    p.add_argument("--region", action="append", choices=[*regions, "synthetic"],
                   help="region id (repeat for several); default: all four regions")
    p.add_argument("--as-of", help="end of the monitoring period, YYYY-MM-DD (default: today, UTC)")
    p.add_argument("--baseline-years", type=float, help="override the region's long-term baseline length")
    p.add_argument("--monitor-days", type=float, help="override the region's monitoring length")
    p.add_argument("--jma-file", help="local JMA hypocenter file (.zip or text) instead of downloading")
    d = DetectionConfig()
    p.add_argument("--max-baseline-events", type=int, default=d.max_baseline_events)
    p.add_argument("--max-monitor-events", type=int, default=d.max_monitor_events)
    p.add_argument("--ntt", type=int, default=d.ntt)
    p.add_argument("--K", type=int, default=d.K)
    p.add_argument("--radius", type=float, default=d.radius, help="detector radius, unit-square coordinates")
    p.add_argument("--score-radius", type=float, default=d.score_radius)
    p.add_argument("--n-update", type=int, default=d.n_update)
    p.add_argument("--epochs", type=int, default=d.n_epochs, help="epochs for fitting f0 on the baseline")
    p.add_argument("--lr", type=float, default=d.lr)
    p.add_argument("--update-lr", type=float, default=d.update_lr)
    p.add_argument("--seed", type=int, default=0)
    p.add_argument("--out-dir", help="output folder (default: <output dir>)")
    p.add_argument("--quiet", action="store_true")
    return p


def write_index(out: Path, entries: list) -> None:
    (out / "index.json").write_text(json.dumps({"regions": entries}, indent=1), encoding="utf-8")


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    regions = load_regions()
    out = Path(args.out_dir) if args.out_dir else output_dir()
    out.mkdir(parents=True, exist_ok=True)
    cfg = DetectionConfig(max_baseline_events=args.max_baseline_events, max_monitor_events=args.max_monitor_events,
                          ntt=args.ntt, K=args.K, radius=args.radius, score_radius=args.score_radius,
                          n_update=args.n_update, n_epochs=args.epochs, lr=args.lr, update_lr=args.update_lr,
                          seed=args.seed)
    wanted = args.region or list(regions)
    entries, failures = [], 0
    for rid in wanted:
        print(f"\n=== {rid} ===")
        try:
            if rid == "synthetic":
                from .synthetic import SYNTHETIC, synthetic_events
                events, as_of = synthetic_events(seed=args.seed)
                region = SYNTHETIC
                result = run_region(region, as_of, cfg, fetch=lambda r, s, e, m: events, progress=not args.quiet)
            else:
                region = regions[rid]
                result = run_region(region, args.as_of, cfg, baseline_years=args.baseline_years,
                                    monitor_days=args.monitor_days, jma_file=args.jma_file, progress=not args.quiet)
        except ImportError as exc:
            print(f"[!] The score model needs PyTorch, SciPy and tqdm: {exc}\n    pip install -r requirements.txt")
            return 3
        except (UsgsFetchError, JmaFetchError, ValueError, OSError) as exc:
            print(f"[!] {rid}: {exc}")
            failures += 1
            entries.append({"id": rid, "name": regions[rid].name if rid in regions else rid, "status": "error",
                            "error": str(exc)})
            continue
        write_result(result, out / f"cusum_{rid}.json")
        stat_csv(result).to_csv(out / f"cusum_{rid}_stat.csv", index=False)
        t = result["time"]
        print(f"[+] {result['meta']['n_baseline']} baseline / {result['meta']['n_monitor']} monitoring events "
              f"at M>={result['meta']['min_mag']}; peak CUSUM statistic {max(result['stat']):.4g}")
        entries.append({"id": rid, "name": result["region"]["name"], "status": "ok", "file": f"cusum_{rid}.json",
                        "monitor_start": pd.Timestamp(t["monitor_start_ms"], unit="ms").isoformat(),
                        "monitor_end": pd.Timestamp(t["monitor_end_ms"], unit="ms").isoformat(),
                        "peak_stat": max(result["stat"])})
    write_index(out, entries)
    print(f"\n[+] Wrote {out}/index.json. Copy the folder to docs/data/ or load the files in the portal.")
    return 1 if failures == len(wanted) else 0


if __name__ == "__main__":
    sys.exit(main())
