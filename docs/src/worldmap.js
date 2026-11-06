// The single world map: global events everywhere, detector regions as clickable boxes, and (for regions with
// results) the CUSUM anomaly zones. Clicking a region zooms in and shows that region's detector state.
import { chooseGrid, densityToRGBA, kernelDensityGrid } from "./kernel.js";
import { clamp, histogram, timeToX, xToTime } from "./timeline.js";
import { DAY_MS, escapeHtml, fmtDate, fmtDateTime } from "./util.js";

const MAX_MARKERS = 800;
const WORLD = [[-60, -180], [78, 180]];
const REGION_COLORS = ["#e879f9", "#38bdf8", "#facc15", "#4ade80", "#fb923c", "#f87171"];
const sci = (v) => (v === 0 ? "0" : Math.abs(v) >= 1e4 || Math.abs(v) < 0.01 ? v.toExponential(2) : v.toFixed(2));

export class WorldMap {
  /** @param {{regions:object[], els:{map,info,strip,notice,back}, onSelect:(id:string|null)=>void,
   *           onScrub:(ms:number)=>void, onWheel:(e:WheelEvent,where:string)=>void, tectonic?:object}} o */
  constructor({ regions, els, onSelect, onScrub, onWheel, tectonic = null }) {
    this.regions = regions;
    this.els = els;
    this.onSelect = onSelect;
    this.selected = null;
    this.rects = new Map();
    this.overlays = {}; this.canvases = {};
    this.lastCursor = null; this.lastCtx = null;
    this.tectonicLayer = tectonic ? this._plates(tectonic) : null;

    this.map = L.map(els.map, { zoomControl: false, worldCopyJump: false, attributionControl: false, minZoom: 2,
      maxBounds: [[-85, -180], [85, 180]], maxBoundsViscosity: 1 });
    L.control.zoom({ position: "bottomright" }).addTo(this.map);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 18, noWrap: true }).addTo(this.map);
    this.showWorld();
    this.markers = L.layerGroup().addTo(this.map);
    this.zonePts = L.layerGroup().addTo(this.map);

    for (const r of regions) {
      const [w, s, e, n] = r.bbox;
      const rect = L.rectangle([[s, w], [n, e]], { weight: 2, fillOpacity: 0.03, interactive: true, bubblingMouseEvents: false });
      rect.bindTooltip?.(escapeHtml(r.name), { sticky: true });
      rect.on?.("click", () => onSelect(this.selected === r.id ? null : r.id));
      rect.addTo(this.map);
      this.rects.set(r.id, rect);
    }
    this.styleRects({});
    this.map.on("moveend zoomend", () => this.lastCtx && this.render(this.lastCursor, this.lastCtx));

    els.back.addEventListener("click", () => onSelect(null));
    els.info.addEventListener("click", (ev) => {
      const el = ev.target?.closest?.("[data-region]");
      if (el) onSelect(el.dataset.region);
    });
    els.map.addEventListener("wheel", (ev) => onWheel(ev, "map"), { capture: true, passive: false });
    els.strip.addEventListener("wheel", (ev) => onWheel(ev, "strip"), { passive: false });
    const seek = (ev) => { const r = this.lastCtx?.range; if (r) onScrub(xToTime(ev.clientX - els.strip.getBoundingClientRect().left, els.strip.clientWidth, r.t0, r.t1)); };
    els.strip.addEventListener("pointerdown", (ev) => { els.strip.setPointerCapture(ev.pointerId); this.dragging = true; seek(ev); });
    els.strip.addEventListener("pointermove", (ev) => { if (this.dragging) seek(ev); });
    const stop = () => { this.dragging = false; };
    els.strip.addEventListener("pointerup", stop);
    els.strip.addEventListener("pointercancel", stop);
  }

  _plates(data) { return L.geoJSON(data, { style: { color: "#d97706", weight: 1.5, opacity: 0.8 }, interactive: false }); }
  setTectonicData(data) { this.tectonicLayer = this._plates(data); }
  setTectonic(on) { if (!this.tectonicLayer) return; if (on) this.tectonicLayer.addTo(this.map); else this.map.removeLayer(this.tectonicLayer); }
  setNotice(text) { this.els.notice.textContent = text; this.els.notice.style.display = text ? "block" : "none"; }
  invalidate() { this.map.invalidateSize(); if (this.lastCtx) this.render(this.lastCursor, this.lastCtx); }

  showWorld() { this.map.fitBounds(WORLD); }

  /** Zoom to a region (or back out to the world when id is null). */
  select(id, result = null) {
    this.selected = id;
    this.els.back.style.display = id ? "inline-block" : "none";
    if (!id) { this.showWorld(); return; }
    const r = this.regions.find((x) => x.id === id);
    const f = result?.doc.frame;
    const b = f ? [[f.south, f.west], [f.north, f.east]] : [[r.bbox[1], r.bbox[0]], [r.bbox[3], r.bbox[2]]];
    this.map.fitBounds(b, { padding: [16, 16] });
  }

  styleRects(results) {
    this.regions.forEach((r, i) => {
      const ok = results.has?.(r.id);
      const on = this.selected === r.id;
      this.rects.get(r.id).setStyle?.({ color: ok ? REGION_COLORS[i % REGION_COLORS.length] : "#64748b", dashArray: ok ? null : "4 4",
        weight: on ? 3 : 2, fillOpacity: on ? 0 : 0.04 });
    });
  }

  _paddedBounds() {
    const b = this.map.getBounds().pad(0.25);
    return { west: Math.max(-180, b.getWest()), east: Math.min(180, b.getEast()),
             south: Math.max(-80, b.getSouth()), north: Math.min(80, b.getNorth()) };
  }

  _overlay(key, points, k, ramp, bounds, zIndex) {
    const existing = this.overlays[key];
    if (!points.length || bounds.east <= bounds.west || bounds.north <= bounds.south) {
      if (existing) { this.map.removeLayer(existing); delete this.overlays[key]; }
      return null;
    }
    const g = chooseGrid(bounds, k.bwKm, k.kernel);
    const values = kernelDensityGrid({ points, bounds, nx: g.nx, ny: g.ny, bandwidthKm: g.bandwidthKm, kernel: k.kernel });
    const canvas = (this.canvases[key] ||= document.createElement("canvas"));
    canvas.width = g.nx; canvas.height = g.ny;
    canvas.getContext("2d").putImageData(new ImageData(densityToRGBA(values, { ramp, bandwidthKm: g.bandwidthKm, kernel: k.kernel, saturation: k.sat }), g.nx, g.ny), 0, 0);
    const url = canvas.toDataURL();
    const lb = [[bounds.south, bounds.west], [bounds.north, bounds.east]];
    if (existing) { existing.setUrl(url); existing.setBounds(lb); }
    else this.overlays[key] = L.imageOverlay(url, lb, { interactive: false, zIndex }).addTo(this.map);
    return g.bandwidthKm;
  }

  /**
   * @param {number} cursorMs
   * @param {{S:object, range:{t0:number,t1:number}, events:object[], results:Map, selected:string|null}} ctx
   * S = sidebar settings; events = already filtered to the window.
   */
  render(cursorMs, ctx) {
    this.lastCursor = cursorMs; this.lastCtx = ctx;
    const { S, range, events, results } = ctx;
    this.markers.clearLayers(); this.zonePts.clearLayers();
    this.styleRects(results);
    const now = clamp(cursorMs, range.t0, range.t1);

    // detector state per region with results, at this time
    const states = this.regions.filter((r) => results.has(r.id)).map((r) => ({ r, res: results.get(r.id), st: results.get(r.id).stateAt(now) }));
    const bounds = this._paddedBounds();

    const evPts = events.map((e) => ({ lon: e.lon, lat: e.lat, w: S.eventWeight === "magnitude" ? Math.max(e.mag, 0) / 5 : 1 }));
    const bwEv = this._overlay("events", S.showEvents ? evPts : [], S.events, "events", bounds, 210);
    const zonePts = states.flatMap((x) => x.st.zone);
    const bwZone = this._overlay("zones", S.showZones ? zonePts : [], S.zones, "zones", bounds, 220);
    const base = S.showBaseline ? states.flatMap((x) => x.res.baselinePoints(S.windowMs)) : [];
    this._overlay("baseline", base, S.events, "baseline", bounds, 200);

    if (S.showMarkers && events.length <= MAX_MARKERS) {
      for (const e of events) {
        const measured = e.measure != null && e.measure > 0;
        L.circleMarker([e.lat, e.lon], { radius: Math.max(3, e.mag * 1.8), fillColor: "#0284c7", fillOpacity: 0.7,
          color: measured ? "#f59e0b" : "#0f172a", weight: measured ? 2 : 1 })
          .bindPopup(`<div style="color:#0f172a;font-size:.85rem"><strong>${escapeHtml(e.place || this.regions.find((r) => r.id === e.regionId)?.name || "Event")}</strong><br>
            M ${e.mag}<br>${fmtDateTime(e.timeMs)}
            ${e.measure != null ? `<br>Anomaly measure ψ₀−ψ₁: ${sci(e.measure)}` : ""}</div>`).addTo(this.markers);
      }
    }
    if (S.showZonePoints) for (const p of zonePts.slice(0, 1500)) L.circleMarker([p.lat, p.lon], { radius: 2, color: "#a855f7", weight: 1, fillOpacity: 0.6, interactive: false }).addTo(this.zonePts);

    this._info(now, range, events, states, results, [bwEv && `events h≈${Math.round(bwEv)} km`, bwZone && `zones h≈${Math.round(bwZone)} km`].filter(Boolean));
    this.drawStrip(cursorMs, ctx, states);
  }

  _info(now, range, events, states, results, bw) {
    const chip = (label, value, cls = "") => `<span class="chip ${cls}"><b>${label}</b> ${value}</span>`;
    const sel = this.selected && this.regions.find((r) => r.id === this.selected);
    const out = [];
    if (sel) {
      const x = states.find((s) => s.r.id === sel.id);
      out.push(chip("Region", escapeHtml(sel.name), "title"));
      out.push(chip("Window", `${events.filter((e) => e.regionId === sel.id).length} events`));
      if (x) {
        const m = x.res.doc.meta;
        out.push(chip("CUSUM", `${sci(x.st.stat)} <i>/ peak ${sci(x.res.maxStat)}</i>`, x.st.stat > 0 ? "alert" : ""));
        out.push(chip("τ", x.st.tauMs ? fmtDate(x.st.tauMs) : "–"));
        out.push(chip("Region ω", `${x.st.zone.length} pts`));
        out.push(chip("Normal", `${m.n_baseline} ev / ${Math.round(x.res.baselineMs / (365.25 * DAY_MS))} y, M≥${m.min_mag}`));
        if (x.res.standin) out.push(chip("", "STAND-IN scorer", "dim"));
      } else out.push(chip("", `no detector results yet: python -m services.change_detection --region ${sel.id}`, "dim"));
    } else {
      out.push(chip("World", `${events.length} events`));
      this.regions.forEach((r, i) => {
        const x = states.find((s) => s.r.id === r.id);
        out.push(`<button class="chip region-chip${x ? "" : " off"}" data-region="${escapeHtml(r.id)}" style="border-color:${x ? REGION_COLORS[i % REGION_COLORS.length] : "#475569"}">
          <b>${escapeHtml(r.name)}</b> ${x ? `CUSUM ${sci(x.st.stat)}` : "no results"}</button>`);
      });
      out.push(chip("", "click a region box to zoom in", "dim"));
    }
    if (bw.length) out.push(chip("Kernel", bw.join(" · ")));
    this.els.info.innerHTML = out.join("");
  }

  drawStrip(cursorMs, ctx, states) {
    const c = this.els.strip, dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth, h = c.clientHeight || 72;
    if (!w) return;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
    const g = c.getContext("2d");
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    g.fillStyle = "#0b1220"; g.fillRect(0, 0, w, h);
    const { S, range: r, allTimes, results } = ctx;
    const X = (t) => timeToX(t, w, r.t0, r.t1);
    const sel = this.selected;
    const times = sel ? (results.get(sel)?.eventTimes ?? []) : allTimes;
    const bins = Math.max(20, Math.floor(w / 6));
    const counts = histogram(times, r.t0, r.t1, bins), peak = Math.max(1, ...counts);
    g.fillStyle = "#1d4ed8";
    counts.forEach((n, i) => { const bh = (n / peak) * (h - 18); g.fillRect((i * w) / bins, h - 12 - bh, w / bins - 1, bh); });

    // CUSUM statistic: the selected region's, or every region's (each normalised to its own peak)
    for (const { r: reg, res } of states ?? []) {
      if (sel && reg.id !== sel) continue;
      if (!(res.maxStat > 0)) continue;
      const d = res.doc;
      g.strokeStyle = REGION_COLORS[this.regions.indexOf(reg) % REGION_COLORS.length]; g.lineWidth = 1.5; g.beginPath();
      d.tt_ms.forEach((t, i) => { const x = X(t), y = h - 12 - (d.stat[i] / res.maxStat) * (h - 20); i ? g.lineTo(x, y) : g.moveTo(x, y); });
      g.stroke();
    }
    const now = clamp(cursorMs, r.t0, r.t1);
    const x0 = X(Math.max(r.t0, now - S.windowMs));
    g.fillStyle = "rgba(56,189,248,0.18)"; g.fillRect(x0, 0, Math.max(2, X(now) - x0), h - 12);
    const st = sel && results.get(sel) ? results.get(sel).stateAt(now) : null;
    if (st?.tauMs) { g.strokeStyle = "#f59e0b"; g.setLineDash([3, 3]); g.beginPath(); g.moveTo(X(st.tauMs), 0); g.lineTo(X(st.tauMs), h - 12); g.stroke(); g.setLineDash([]); }
    g.strokeStyle = "#f8fafc"; g.lineWidth = 2; g.beginPath(); g.moveTo(X(now), 0); g.lineTo(X(now), h - 12); g.stroke();
    g.fillStyle = "#94a3b8"; g.font = "10px sans-serif";
    g.fillText(fmtDate(r.t0), 4, h - 2); g.textAlign = "right"; g.fillText(fmtDate(r.t1), w - 4, h - 2); g.textAlign = "left";
  }
}
