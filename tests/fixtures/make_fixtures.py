"""Write stand-in detector results for the website tests and for trying the portal UI without running PyTorch.

    python -m tests.fixtures.make_fixtures

Output is flagged ``"standin": true`` and the portal shows a banner. It is NOT output of the score model.
"""
import json

import tests.conftest  # noqa: F401  (stubs torch/tqdm when they are not installed)
from pathlib import Path

from services.change_detection.detect import SpatioTemporalDetector
from services.change_detection.pipeline import DetectionConfig, run_region, write_result
from services.data_query import filter_bbox
from shared.regions import load_regions
from tests.helpers import AS_OF, catalogue
from tests.standin import StandInScore

HERE = Path(__file__).parent


def main() -> None:
    region = load_regions()["california"]
    cat = filter_bbox(catalogue(burst=True, seed=0), region.bbox)
    cfg = DetectionConfig(ntt=60, K=3, n_update=8)
    result = run_region(region, AS_OF, cfg, fetch=lambda r, s, e, m: cat, score_cls=StandInScore,
                        detector_cls=SpatioTemporalDetector)
    write_result(result, HERE / "standin_california.json")
    (HERE / "standin_index.json").write_text(json.dumps({"regions": [
        {"id": "california", "name": region.name, "status": "ok", "file": "standin_california.json"},
        {"id": "japan", "name": "Japan and surroundings", "status": "error", "error": "no data (fixture)"}]}))
    print("wrote", len(json.dumps(result)) // 1024, "KB;", len(result["events"]), "events; peak", max(result["stat"]))


if __name__ == "__main__":
    main()
