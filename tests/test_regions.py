import json

import pytest

from shared.regions import REGIONS_FILE, Region, load_regions


def test_the_four_requested_regions_exist():
    regions = load_regions()
    assert list(regions) == ["california", "japan", "americas", "indonesia"]
    assert regions["japan"].catalog == "jma"
    assert all(regions[r].catalog == "usgs" for r in ("california", "americas", "indonesia"))


def test_regions_cover_the_expected_places():
    r = load_regions()
    inside = lambda reg, lon, lat: reg.bbox[0] <= lon <= reg.bbox[2] and reg.bbox[1] <= lat <= reg.bbox[3]
    assert inside(r["california"], -118.2, 34.05) and inside(r["california"], -124.2, 40.5)
    assert inside(r["japan"], 139.7, 35.7) and inside(r["japan"], 142.8, 38.3) and inside(r["japan"], 129.9, 33.6)
    assert inside(r["americas"], -70.7, -33.4) and inside(r["americas"], -90.5, 14.6) and inside(r["americas"], -74.1, 4.7)
    assert inside(r["indonesia"], 95.3, 5.5) and inside(r["indonesia"], 106.8, -6.2) and inside(r["indonesia"], 119.9, -0.9)


def test_regions_do_not_overlap_each_other():
    r = list(load_regions().values())
    for i, a in enumerate(r):
        for b in r[i + 1:]:
            disjoint = a.bbox[2] <= b.bbox[0] or b.bbox[2] <= a.bbox[0] or a.bbox[3] <= b.bbox[1] or b.bbox[3] <= a.bbox[1]
            assert disjoint, f"{a.id} overlaps {b.id}"


def test_invalid_region_is_rejected():
    with pytest.raises(ValueError):
        Region("x", "x", (10, 0, 5, 1), "usgs", 4.0, 10, 365)
    with pytest.raises(ValueError):
        Region("x", "x", (0, 0, 1, 1), "isc", 4.0, 10, 365)


def test_regions_json_is_valid_for_the_website_too():
    raw = json.loads(REGIONS_FILE.read_text())
    assert {r["id"] for r in raw["regions"]} == {"california", "japan", "americas", "indonesia"}
