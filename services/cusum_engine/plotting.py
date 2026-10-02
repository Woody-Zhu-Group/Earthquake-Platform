"""Diagnostic map of earthquakes and CUSUM anomaly zones."""
from __future__ import annotations

from pathlib import Path

import matplotlib

matplotlib.use("Agg")  # headless-safe: the engine only writes files
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402


def generate_spatial_plot(df, anomalies_df, output_path="cusum_spatial_map.png") -> Path:
    """Save a scatter map of epicentres with dashed rings on anomalous grid cells."""
    output_path = Path(output_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    fig, ax = plt.subplots(figsize=(14, 8))
    # Negative magnitudes exist in USGS data; a negative base to a fractional power is NaN.
    sizes = np.clip(df["mag"].to_numpy(dtype=float), 0, None) ** 2.5 * 1.8 + 4
    scatter = ax.scatter(
        df["lon"], df["lat"], c=df["mag"], cmap="YlOrRd", s=sizes,
        alpha=0.5, edgecolors="none", label="Earthquake Events",
    )
    fig.colorbar(scatter, ax=ax, label="Magnitude (M)")

    if not anomalies_df.empty:
        zones = anomalies_df[["grid_lon", "grid_lat"]].drop_duplicates()
        ax.scatter(
            zones["grid_lon"], zones["grid_lat"], s=350, facecolors="none",
            edgecolors="cyan", linewidth=2.5, linestyle="--", label="CUSUM Anomaly Zone",
        )

    ax.set_title("Spatio-Temporal CUSUM Earthquake Swarm & Energy Anomalies", fontsize=14, fontweight="bold")
    ax.set_xlabel("Longitude (°)")
    ax.set_ylabel("Latitude (°)")
    ax.grid(True, linestyle=":", alpha=0.6)
    ax.legend(loc="lower left")
    fig.tight_layout()
    fig.savefig(output_path, dpi=300)
    plt.close(fig)
    print(f"[+] Diagnostic map saved to '{output_path}'.")
    return output_path
