// Leaflet layer: draws a kernel-smoothed surface (and optionally a contour) for a set of geographic points.
// Uses the global `L` (Leaflet is loaded from a <script> tag in index.html).
import { contourSegments, countRegions, kernelGrid, rampColor } from "./kernels.js";

const CELL = 4; // screen pixels per kernel-grid cell

export function createKernelLayer(map, { ramp, pane = "overlayPane", zIndex = 400 } = {}) {
  const KernelLayer = L.Layer.extend({
    onAdd(m) {
      this._map = m;
      this._canvas = L.DomUtil.create("canvas", "kernel-layer");
      this._canvas.style.pointerEvents = "none";
      this._canvas.style.zIndex = String(zIndex);
      m.getPane(pane).appendChild(this._canvas);
      this._small = document.createElement("canvas"); // one pixel per kernel-grid cell, upscaled with smoothing
      m.on("moveend zoomend resize", this.redraw, this);
      this.redraw();
    },
    onRemove(m) {
      m.off("moveend zoomend resize", this.redraw, this);
      this._canvas.remove();
    },
    /**
     * @param {{lat:number, lon:number, w:number}[]} points
     * @param {{bandwidthKm:number, normalizeTo?:number, opacity?:number, level?:number}} opts
     *   normalizeTo: value mapped to the top of the ramp (default: the frame's own maximum)
     *   level:       contour level as a fraction of the maximum, or null for no contour
     */
    setData(points, opts) { this._points = points; this._opts = opts; this.redraw(); },
    /** Result of the last draw: { max, regions, level } */
    getInfo() { return this._info || { max: 0, regions: 0, level: 0 }; },

    redraw() {
      const m = this._map;
      if (!m || !this._canvas) return;
      const size = m.getSize();
      const topLeft = m.containerPointToLayerPoint([0, 0]);
      L.DomUtil.setPosition(this._canvas, topLeft);
      this._canvas.width = size.x; this._canvas.height = size.y;
      const ctx = this._canvas.getContext("2d");
      ctx.clearRect(0, 0, size.x, size.y);
      this._info = { max: 0, regions: 0, level: 0 };
      if (!this._points || this._points.length === 0 || !this._opts) return;

      const { bandwidthKm, normalizeTo, opacity = 1, level = null, dashed = false, lineColor = "#dc2626" } = this._opts;
      const c = m.getCenter();
      const p1 = m.latLngToContainerPoint(c), p2 = m.latLngToContainerPoint(L.latLng(c.lat + bandwidthKm / 111.32, c.lng));
      const sigma = Math.max(3, Math.abs(p1.y - p2.y));
      const pts = [];
      for (const p of this._points) {
        const q = m.latLngToContainerPoint([p.lat, p.lon]);
        pts.push({ x: q.x, y: q.y, w: p.w });
      }
      const { grid, cols, rows, max } = kernelGrid(pts, { width: size.x, height: size.y, cell: CELL, sigma });
      this._info.max = max;
      if (max <= 0) return;

      const top = normalizeTo || max;
      const img = new ImageData(cols, rows);
      for (let k = 0; k < grid.length; k++) {
        const [r, g, b, a] = rampColor(ramp, Math.min(1, grid[k] / top));
        img.data[4 * k] = r; img.data[4 * k + 1] = g; img.data[4 * k + 2] = b; img.data[4 * k + 3] = Math.round(255 * a * opacity);
      }
      this._small.width = cols; this._small.height = rows;
      this._small.getContext("2d").putImageData(img, 0, 0);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(this._small, 0, 0, cols, rows, 0, 0, cols * CELL, rows * CELL);

      if (level != null) {
        const lv = level * max;
        this._info.level = lv;
        this._info.regions = countRegions(grid, cols, rows, lv);
        ctx.strokeStyle = lineColor; ctx.lineWidth = 2; ctx.setLineDash(dashed ? [6, 6] : []);
        ctx.beginPath();
        for (const [x1, y1, x2, y2] of contourSegments(grid, cols, rows, lv)) {
          ctx.moveTo((x1 + 0.5) * CELL, (y1 + 0.5) * CELL); ctx.lineTo((x2 + 0.5) * CELL, (y2 + 0.5) * CELL);
        }
        ctx.stroke();
      }
    },
  });
  return new KernelLayer();
}
