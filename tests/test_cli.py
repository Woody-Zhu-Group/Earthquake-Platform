import json
from pathlib import Path

from services.cusum_engine.cli import main

FIXTURES = Path(__file__).parent / "fixtures"


def to_geojson(events):
    return {"features": [
        {"id": e["id"], "properties": {"mag": e["mag"], "time": e["time_ms"], "place": "p", "title": "t"},
         "geometry": {"coordinates": [e["lon"], e["lat"], 10.0]}}
        for e in events]}


def test_offline_run_writes_csv_and_map(tmp_path, capsys):
    events = json.loads((FIXTURES / "synthetic_events.json").read_text())
    src = tmp_path / "quakes.geojson"
    src.write_text(json.dumps(to_geojson(events)))
    csv, png = tmp_path / "out.csv", tmp_path / "map.png"
    code = main(["--input", str(src), "--output", str(csv), "--map-output", str(png), "--timestep", "12H"])
    assert code == 0
    assert csv.exists() and png.stat().st_size > 0
    assert "[ALERT]" in capsys.readouterr().out


def test_bad_time_step_is_a_clean_error(tmp_path, capsys):
    events = json.loads((FIXTURES / "synthetic_events.json").read_text())
    src = tmp_path / "q.geojson"
    src.write_text(json.dumps(to_geojson(events)))
    assert main(["--input", str(src), "--timestep", "fortnight", "--no-map"]) == 2


def test_start_without_end_is_rejected():
    assert main(["--start", "2024-01-01"]) == 2
