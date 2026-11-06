import io
import zipfile

import pandas as pd
import pytest

from services.data_query.jma import parse_hypocenter_bytes, parse_magnitude, read_zip_bytes


def record(agency="J", when=(2024, 1, 1, 16, 10), sec="0000", lat=(37, "2200"), lon=(137, "1900"), depth="01000",
           mag="76", subsidiary="1", region="NOTO PENINSULA ".ljust(24)):
    """Build a 96-byte hypocenter record following the JMA column spec (offsets are 1-based in the spec)."""
    buf = bytearray(b" " * 96)

    def put(first_col, text):
        raw = text.encode("ascii")
        buf[first_col - 1:first_col - 1 + len(raw)] = raw

    put(1, agency)
    put(2, f"{when[0]:04d}{when[1]:02d}{when[2]:02d}{when[3]:02d}{when[4]:02d}")
    put(14, sec)
    put(22, f"{lat[0]:3d}")
    put(25, lat[1])
    put(33, f"{lon[0]:4d}")
    put(37, lon[1])
    put(45, depth)
    put(53, mag)
    put(61, subsidiary)
    put(69, region)
    put(93, "123")
    put(96, "K")
    assert len(buf) == 96
    return bytes(buf)


def test_parses_time_position_depth_and_magnitude():
    df = parse_hypocenter_bytes(record(sec="4618") + b"\n")
    row = df.iloc[0]
    assert row["time"] == pd.Timestamp("2024-01-01 07:10:46.18")      # 16:10 JST -> 07:10 UTC
    assert row["lat"] == pytest.approx(37 + 22 / 60)
    assert row["lon"] == pytest.approx(137 + 19 / 60)
    assert row["mag"] == 7.6 and row["depth"] == pytest.approx(10.0)


@pytest.mark.parametrize("raw,expected", [(b"45", 4.5), (b"-1", -0.1), (b"-9", -0.9), (b"A0", -1.0), (b"A9", -1.9),
                                           (b"B0", -2.0), (b"C0", -3.0), (b" 5", 0.5), (b"  ", None)])
def test_magnitude_encoding(raw, expected):
    assert parse_magnitude(raw) == expected


def test_jst_midnight_rolls_the_date_back():
    df = parse_hypocenter_bytes(record(when=(2024, 3, 1, 5, 30)) + b"\n")
    assert df.iloc[0]["time"] == pd.Timestamp("2024-02-29 20:30:00")


def test_blank_decimals_in_fixed_hypocentres_count_as_zero():
    df = parse_hypocenter_bytes(record(lat=(35, "30  "), lon=(139, "45  "), depth="010  ") + b"\n")
    assert df.iloc[0]["lat"] == pytest.approx(35 + 30 / 60)
    assert df.iloc[0]["depth"] == 10.0


def test_filters_agency_event_type_magnitude_and_bbox():
    blob = b"\n".join([
        record(),                                 # kept
        record(agency="U"),                       # USGS solution, dropped
        record(subsidiary="3"),                   # artificial, dropped
        record(subsidiary="4"),                   # eruption, dropped
        record(subsidiary="5"),                   # low-frequency, dropped
        record(mag="20"),                         # M2.0 below cut
        record(lon=(150, "0000")),                # outside bbox
    ]) + b"\n"
    df = parse_hypocenter_bytes(blob, bbox=(122, 24, 146, 46), min_mag=3.0)
    assert len(df) == 1


def test_multibyte_region_names_do_not_shift_columns():
    line = record()
    jp = "能登半島".encode("shift_jis")
    line = line[:68] + jp + b" " * (24 - len(jp)) + line[92:]
    assert len(line) == 96
    assert len(parse_hypocenter_bytes(line + b"\n")) == 1


def test_malformed_lines_are_skipped_not_fatal():
    blob = b"J garbage\n" + record() + b"\n" + b"J" + b"x" * 95 + b"\n"
    assert len(parse_hypocenter_bytes(blob)) == 1


def test_zip_reader_concatenates_members():
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("h2024a", record() + b"\n")
        zf.writestr("h2024b", record(when=(2024, 2, 2, 12, 0)) + b"\n")
    assert len(parse_hypocenter_bytes(read_zip_bytes(buf.getvalue()))) == 2
