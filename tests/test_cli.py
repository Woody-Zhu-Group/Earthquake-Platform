import json

import pandas as pd

import services.change_detection.cli as cli
from tests.helpers import AS_OF, catalogue
from tests.standin import StandInScore


def test_parser_defaults_to_all_four_regions_and_validates_ids():
    args = cli.build_parser().parse_args([])
    assert args.region is None
    assert cli.build_parser().parse_args(["--region", "japan", "--region", "california"]).region == ["japan", "california"]


def test_writes_one_file_per_region_plus_an_index_and_survives_a_failing_region(tmp_path):
    cat = catalogue(False)
    from services.change_detection import pipeline
    from services.change_detection.detect import SpatioTemporalDetector

    real = pipeline.run_region

    def fake_run_region(region, as_of, cfg, **kw):
        if region.id == "japan":
            raise ValueError("Japan: only 3 baseline events")
        return real(region, AS_OF, cfg, fetch=lambda r, s, e, m: cat[(cat["lon"] > region.bbox[0]) & (cat["lon"] < region.bbox[2])],
                    score_cls=StandInScore, detector_cls=SpatioTemporalDetector)

    cli.run_region = fake_run_region
    try:
        code = cli.main(["--region", "california", "--region", "japan", "--out-dir", str(tmp_path), "--ntt", "20",
                         "--K", "2", "--n-update", "4", "--quiet"])
    finally:
        cli.run_region = real
    assert code == 0
    index = json.loads((tmp_path / "index.json").read_text())["regions"]
    assert [(e["id"], e["status"]) for e in index] == [("california", "ok"), ("japan", "error")]
    assert "baseline events" in index[1]["error"]
    result = json.loads((tmp_path / "cusum_california.json").read_text())
    assert result["region"]["id"] == "california" and (tmp_path / "cusum_california_stat.csv").exists()
    assert pd.Timestamp(index[0]["monitor_end"]).year == 2025
