"""Map a regional catalogue onto the unit cube ``detect.py`` / ``score.py`` expect.

* Space: the region's bounding box is centred in a square of side ``max(width, height)`` degrees and scaled to
  [0, 1]^2 (``ScoreModel.w`` takes ``sqrt(min(x, 1 - x))``, so coordinates outside [0, 1] would give NaN).
  One scale for both axes means a detector radius is the same number of degrees east-west and north-south;
  degrees are not equal-area, so a radius is narrower in km at high latitude.
* Time: the unit of time is the **baseline duration**; the baseline occupies [0, 1] and the monitoring period
  follows at [1, 1 + monitor/baseline]. ``ScoreModel.fit`` initialises its background level from an event *count*,
  not a rate, so the baseline and monitoring data must share one time scale for f0 to describe "normal".
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd

KM_PER_DEG = 111.19


def harmonize_min_mag(base_mags, monitor_mags, min_mag, max_baseline, max_monitor, step=0.1) -> float:
    """Smallest magnitude cut-off >= ``min_mag`` that keeps both periods within their event caps.

    Both periods must share one cut-off or their rates are not comparable. Caps exist because
    ``ScoreModel.find_index`` allocates dense n x n matrices (about 6 GB at n = 20,000).
    """
    base, mon = np.asarray(base_mags, float), np.asarray(monitor_mags, float)
    mc = round(float(min_mag), 1)
    top = max(base.max(initial=mc), mon.max(initial=mc))
    while mc <= top and ((base >= mc).sum() > max_baseline or (mon >= mc).sum() > max_monitor):
        mc = round(mc + step, 1)
    return mc


def _ms(series: pd.Series) -> np.ndarray:
    return series.astype("datetime64[ms]").astype("int64").to_numpy()


@dataclass(frozen=True)
class UnitSquare:
    lon_center: float
    lat_center: float
    side_deg: float
    origin_ms: int      # time 0 (start of the baseline)
    unit_ms: int        # one time unit = baseline duration

    @classmethod
    def for_region(cls, bbox, origin_ms: int, unit_ms: int) -> "UnitSquare":
        west, south, east, north = bbox
        if unit_ms <= 0:
            raise ValueError("baseline duration must be positive")
        return cls((west + east) / 2, (south + north) / 2, max(east - west, north - south), int(origin_ms), int(unit_ms))

    def to_unit(self, df: pd.DataFrame) -> np.ndarray:
        """[n, 3] array of (t, x, y); time-sorted input expected. Space is clipped to [0, 1], time is not."""
        t = (_ms(df["time"]) - self.origin_ms) / self.unit_ms
        x = (df["lon"].to_numpy(float) - self.lon_center) / self.side_deg + 0.5
        y = (df["lat"].to_numpy(float) - self.lat_center) / self.side_deg + 0.5
        return np.stack([t, np.clip(x, 0, 1), np.clip(y, 0, 1)], axis=1)

    def time_to_ms(self, t) -> np.ndarray:
        return self.origin_ms + np.asarray(t, dtype=float) * self.unit_ms

    def xy_to_lonlat(self, xy) -> np.ndarray:
        xy = np.asarray(xy, dtype=float).reshape(-1, 2)
        return np.stack([(xy[:, 0] - 0.5) * self.side_deg + self.lon_center,
                         (xy[:, 1] - 0.5) * self.side_deg + self.lat_center], axis=1)

    def radius_deg(self, radius: float) -> float:
        return float(radius * self.side_deg)

    def radius_km(self, radius: float) -> float:
        return self.radius_deg(radius) * KM_PER_DEG

    def bounds(self) -> dict:
        h = self.side_deg / 2
        return {"west": self.lon_center - h, "east": self.lon_center + h,
                "south": self.lat_center - h, "north": self.lat_center + h}
