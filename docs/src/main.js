import { fetchHistorical, fetchSummaryFeed, fetchTectonicPlates, FDSN_LIMIT } from "./api.js";
import { energyProxy } from "./cusum.js";
import { ScoreModel } from "./score.js";
import { SpatioTemporalDetector } from "./detect.js";
import { EVENT_RAMP, ZONE_RAMP } from "./kernels.js";
import { createKernelLayer } from "./kernel-layer.js";
import { createTimeline, wheelToUnits } from "./timeline.js";

const $ = (id) => document.getElementById(id);
const DAY_MS = 86_400_000;
const NTT = 150;               // detector time grid (states are looked up while scrubbing, never recomputed)
const K_ROUNDS = 3;            // inner/outer rounds per grid point
const N_UPDATE = 10;           // f1 refits along the timeline
const MIN_EVENTS_FOR_MODEL = 60;
const MAX_MARKERS = 2500;      // individual markers drawn at once (kernel layers use every event)
const ZONE_CONTOUR_LEVEL = 0.3; // smoothed-zone boundary = 30 % of the peak of the smoothed surface
const MEASURE_EPS = 1e-5;

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const tick = () => new Promise((r) => setTimeout(r, 0));
const clamp01 = (v) => Math.min(1, Math.max(0, v));

// ---- map -------------------------------------------------------------------
const map = L.map("map", { center: [20, 0], zoom: 3, worldCopyJump: true, zoomControl: false });
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  maxZoom: 19,
}).addTo(map);
L.control.zoom({ position: "bottomright" }).addTo(map);

const quakeLayer = L.layerGroup().addTo(map);
// kernel canvases live in their own pane, below markers and tectonic lines but above the tiles
map.createPane("kernelPane").style.zIndex = 350;
const eventKernel = createKernelLayer(map, { ramp: EVENT_RAMP, pane: "kernelPane", zIndex: 1 });
const zoneKernel = createKernelLayer(map, { ramp: ZONE_RAMP, pane: "kernelPane", zIndex: 2 });
eventKernel.addTo(map);
zoneKernel.addTo(map);
let tectonicLayer = null;

// ---- state -----------------------------------------------------------------
let events = [];
let minTimeMs = 0;
let maxTimeMs = 0;
let isPlaying = false;
let playTimer = null;
let loadToken = 0;
let detToken = 0;
let loadWarning = null;
let detection = null; // { ttMs, tauMs, statList, measure, baselineEndMs, baselineStatMax }
let renderQueued = false;

const timeline = createTimeline({
  canvas: $("timeline-canvas"),
  getFraction: () => parseFloat($("time-slider").value) / 1000,
  setFraction: (f) => setFraction(f),
});

// ---- helpers ---------------------------------------------------------------
function showStatus(msg, kind = "loading") {
  const el = $("status-msg");
  el.className = `status-msg ${kind}`;
  el.textContent = msg;
}
function restoreStatus() {
  if (loadWarning) showStatus(loadWarning, "warn");
  else $("status-msg").className = "status-msg";
}
const iso = (ms) => new Date(ms).toISOString().replace("T", " ").slice(0, 16);

function setFraction(f) {
  stopPlayback();
  $("time-slider").value = Math.round(clamp01(f) * 1000);
  scheduleRender();
}
const getFraction = () => parseFloat($("time-slider").value) / 1000;

function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => { renderQueued = false; processModel(); });
}

// ---- score-based CUSUM detection -------------------------------------------
// Models and the whole online pass are computed once per load / parameter change. Scrubbing only looks up the
// stored state (tau, statistic) for the current time and re-draws the kernels.
async function runDetection() {
  const token = ++detToken;
  detection = null;
  if (events.length < MIN_EVENTS_FOR_MODEL) {
    if (events.length > 0) showStatus(`Need at least ${MIN_EVENTS_FOR_MODEL} events to fit the score models (got ${events.length}).`, "warn");
    scheduleRender();
    return;
  }
  showStatus("Fitting score models and running the CUSUM pass…");
  await tick();
  if (token !== detToken) return;

  const baselineFrac = parseFloat($("baseline-slider").value) / 100;
  const scoreRadiusDeg = parseFloat($("score-radius-slider").value);
  const zoneRadiusDeg = parseFloat($("zone-radius-slider").value);

  // normalise to the unit square with one isotropic scale; time so that the baseline period spans [0, 1]
  let lonMin = Infinity, lonMax = -Infinity, latMin = Infinity, latMax = -Infinity;
  for (const e of events) {
    lonMin = Math.min(lonMin, e.lon); lonMax = Math.max(lonMax, e.lon);
    latMin = Math.min(latMin, e.lat); latMax = Math.max(latMax, e.lat);
  }
  const scale = Math.max(lonMax - lonMin, latMax - latMin, 1e-6) * 1.0001;
  let baselineEndMs = minTimeMs + baselineFrac * (maxTimeMs - minTimeMs);
  let nBase = events.filter((e) => e.timeMs < baselineEndMs).length;
  if (nBase < 30) { // too little to train on: take the first 30 events as the baseline
    nBase = Math.min(30, events.length);
    baselineEndMs = events[nBase - 1].timeMs + 1;
  }
  const baselineSpanMs = Math.max(baselineEndMs - minTimeMs, 1);

  const flat = new Float64Array(events.length * 3);
  events.forEach((e, i) => {
    flat[3 * i] = (e.timeMs - minTimeMs) / baselineSpanMs;
    flat[3 * i + 1] = (e.lon - lonMin) / scale;
    flat[3 * i + 2] = (e.lat - latMin) / scale;
  });

  // score.py's demo trains 400 epochs; this budget keeps ~2500 optimiser steps (about 3 s) whatever the catalog size
  const baseEpochs = Math.max(20, Math.min(200, Math.round((2500 * 256) / nBase)));
  const f0 = new ScoreModel({ ndim: 3, radius: scoreRadiusDeg / scale, seed: 1 });
  const f1 = new ScoreModel({ ndim: 3, radius: scoreRadiusDeg / scale, seed: 2 });
  f0.fit(flat.subarray(0, nBase * 3), { nEpochs: baseEpochs, batchSize: 256, lr: 1e-3, sigma: 0.1 });
  await tick();
  if (token !== detToken) return;

  const det = new SpatioTemporalDetector(f0, f1);
  const res = det.online(flat, {
    ntt: NTT, K: K_ROUNDS, nUpdate: N_UPDATE, radius: zoneRadiusDeg / scale, useGrid: false,
    fitKwds: { nEpochs: 40, batchSize: 256, lr: 1e-3, sigma: 0.1 },
  });
  if (token !== detToken) return;

  const toMs = (t) => minTimeMs + t * baselineSpanMs;
  const ttMs = res.tt.map(toMs);
  let baselineStatMax = 0;
  res.statList.forEach((s, i) => { if (ttMs[i] <= baselineEndMs && s > baselineStatMax) baselineStatMax = s; });
  detection = {
    ttMs, tauMs: res.tauList.map(toMs), statList: res.statList, measure: res.measure, baselineEndMs, baselineStatMax,
  };
  restoreStatus();
  scheduleRender();
}

/** Absolute threshold h = multiplier x the largest statistic seen during the baseline period. */
function currentThreshold() {
  if (!detection) return Infinity;
  const mult = parseFloat($("h-slider").value);
  return mult * Math.max(detection.baselineStatMax, 1e-9);
}

function stepIndexAt(ms) {
  if (!detection) return -1;
  const tt = detection.ttMs;
  let lo = 0, hi = tt.length - 1, ans = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (tt[mid] <= ms) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
  return ans;
}

// ---- rendering -------------------------------------------------------------
function processModel() {
  quakeLayer.clearLayers();
  if (events.length === 0) {
    $("stat-active-events").textContent = "0";
    $("stat-anomalies").textContent = "0";
    $("stat-cusum").textContent = "–";
    $("stat-tau").textContent = "–";
    $("time-display-text").innerHTML = "<span>Start: --</span><span>End: --</span>";
    eventKernel.setData([], null); zoneKernel.setData([], null);
    timeline.draw({ minMs: 0, maxMs: 0, eventTimes: [] });
    return;
  }

  const endMs = minTimeMs + getFraction() * (maxTimeMs - minTimeMs);
  const windowMs = parseFloat($("window-slider").value) * DAY_MS;
  const startMs = endMs - windowMs;
  $("time-display-text").innerHTML = `<span><b>Start:</b> ${iso(startMs)}</span><span><b>End: </b> ${iso(endMs)}</span>`;

  const active = events.filter((e) => e.timeMs >= startMs && e.timeMs <= endMs);
  $("stat-active-events").textContent = active.length;

  // individual markers (capped: the kernels below always use every active event)
  if ($("toggle-quakes").checked) {
    for (const ev of active.slice(-MAX_MARKERS)) {
      const energy = energyProxy(ev.mag);
      L.circleMarker([ev.lat, ev.lon], {
        radius: Math.max(3, ev.mag * 2.2), fillColor: "#0284c7", color: "#0f172a", weight: 1, fillOpacity: 0.7,
      })
        .bindPopup(
          `<div style="font-size:.85rem;color:#0f172a;">
             <strong style="color:#0284c7;">${escapeHtml(ev.place)}</strong><br/>
             <b>Magnitude:</b> M ${ev.mag}<br/>
             <b>Depth:</b> ${ev.depth == null ? "n/a" : `${ev.depth} km`}<br/>
             <b>Relative energy (10<sup>1.5M</sup>):</b> ${energy.toExponential(2)}<br/>
             <b>Timestamp:</b> ${new Date(ev.timeMs).toUTCString()}
           </div>`
        )
        .addTo(quakeLayer);
    }
  }

  // event kernel: Gaussian kernel density of the events in the window
  if ($("toggle-event-heatmap").checked && active.length > 0) {
    const byEnergy = $("event-weight-select").value === "energy";
    eventKernel.setData(
      active.map((e) => ({ lat: e.lat, lon: e.lon, w: byEnergy ? Math.max(0.1, 1.5 * e.mag) : 1 })),
      { bandwidthKm: parseFloat($("event-bw-slider").value), opacity: 0.9 },
    );
  } else {
    eventKernel.setData([], null);
  }

  // CUSUM state at this time
  const h = currentThreshold();
  const i = stepIndexAt(endMs);
  let zones = 0;
  if (detection && i >= 0) {
    const stat = detection.statList[i], tauMs = detection.tauMs[i];
    const alarm = stat > h;
    $("stat-cusum").textContent = `${(stat / h).toFixed(2)} × h`;
    $("stat-cusum").parentElement.classList.toggle("alert", alarm);
    $("stat-tau").textContent = alarm ? iso(tauMs).slice(0, 10) : "–";

    // zone kernel: smooth the anomaly measure of the events in the estimated change region [tau, t)
    if ($("toggle-anomalies").checked || $("toggle-cusum-heatmap").checked) {
      const pts = [];
      const tEnd = detection.ttMs[i];
      for (let k = 0; k < events.length && events[k].timeMs < tEnd; k++) {
        if (events[k].timeMs >= tauMs && detection.measure[k] > MEASURE_EPS) {
          pts.push({ lat: events[k].lat, lon: events[k].lon, w: detection.measure[k] });
        }
      }
      zoneKernel.setData(pts, {
        bandwidthKm: parseFloat($("zone-bw-slider").value),
        opacity: ($("toggle-cusum-heatmap").checked ? 1 : 0) * (alarm ? 1 : 0.35),
        level: $("toggle-anomalies").checked && alarm ? ZONE_CONTOUR_LEVEL : null,
        lineColor: "#dc2626",
      });
      zones = alarm ? zoneKernel.getInfo().regions : 0;
    } else {
      zoneKernel.setData([], null);
    }
  } else {
    zoneKernel.setData([], null);
    $("stat-cusum").textContent = "–";
    $("stat-tau").textContent = "–";
    $("stat-cusum").parentElement.classList.remove("alert");
  }
  $("stat-anomalies").textContent = zones;

  timeline.draw({
    minMs: minTimeMs, maxMs: maxTimeMs, eventTimes: events.map((e) => e.timeMs),
    steps: detection ? { tt: detection.ttMs, ratio: detection.statList.map((s) => s / h) } : null,
    baselineEndMs: detection ? detection.baselineEndMs : minTimeMs,
    endMs, windowMs,
  });
}

// ---- playback --------------------------------------------------------------
function setPlayButton(playing) {
  $("play-btn-icon").textContent = playing ? "⏸" : "▶";
  $("play-btn-text").textContent = playing ? "Pause" : "Play";
}

function stopPlayback() {
  isPlaying = false;
  if (playTimer) clearTimeout(playTimer);
  playTimer = null;
  setPlayButton(false);
}

function runPlaybackStep() {
  if (!isPlaying) return;
  const slider = $("time-slider");
  const next = parseFloat(slider.value) + 2 * parseFloat($("speed-select").value);
  if (next >= 1000) { slider.value = 1000; processModel(); stopPlayback(); return; }
  slider.value = next;
  processModel();
  playTimer = setTimeout(runPlaybackStep, 50);
}

function startPlayback() {
  if (isPlaying || events.length === 0) return;
  const slider = $("time-slider");
  if (parseFloat(slider.value) >= 1000) slider.value = 0;
  isPlaying = true;
  setPlayButton(true);
  runPlaybackStep();
}

function stepFrame(delta) { setFraction(getFraction() + delta / 1000); }

// ---- scroll / keyboard scrubbing -------------------------------------------
// Wheel over the timeline strip or the playbar scrubs time. Over the map, Shift+wheel (or a horizontal
// trackpad swipe) scrubs; plain wheel still zooms. Capture phase so Leaflet's zoom handler never sees it.
map.getContainer().addEventListener("wheel", (e) => {
  const horizontal = Math.abs(e.deltaX) > Math.abs(e.deltaY);
  if (!e.shiftKey && !horizontal) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  setFraction(getFraction() + wheelToUnits(e) / 1000);
}, { capture: true, passive: false });

$("playbar").addEventListener("wheel", (e) => {
  if (e.target.closest("select")) return;
  e.preventDefault();
  setFraction(getFraction() + wheelToUnits(e) / 1000);
}, { passive: false });

document.addEventListener("keydown", (e) => {
  if (e.target.closest("input[type=date], input[type=number], input[type=range], select, textarea")) return;
  const big = e.shiftKey ? 10 : 1;
  if (e.key === "ArrowLeft") { e.preventDefault(); setFraction(getFraction() - (big * 5) / 1000); }
  else if (e.key === "ArrowRight") { e.preventDefault(); setFraction(getFraction() + (big * 5) / 1000); }
  else if (e.key === "Home") { e.preventDefault(); setFraction(0); }
  else if (e.key === "End") { e.preventDefault(); setFraction(1); }
  else if (e.key === " " && !e.target.closest("button")) { e.preventDefault(); isPlaying ? stopPlayback() : startPlayback(); }
});

// ---- data loading ----------------------------------------------------------
async function loadData() {
  stopPlayback();
  const token = ++loadToken;
  ++detToken; // cancel any detection still running on the old data
  const mode = $("data-mode-select").value;
  let loaded = [];
  loadWarning = null;
  try {
    if (mode === "historical") {
      const start = $("hist-start").value, end = $("hist-end").value, minMag = $("hist-min-mag").value;
      showStatus(`Querying USGS Database (${start} to ${end}, M >= ${minMag})...`);
      loaded = await fetchHistorical(start, end, minMag);
    } else {
      const feed = $("feed-select").value;
      showStatus(`Fetching real-time USGS feed (${feed})...`);
      loaded = await fetchSummaryFeed(feed);
    }
    if (token !== loadToken) return;
    if (loaded.length >= FDSN_LIMIT) loadWarning = "Warning: result hit the 20,000-event USGS limit. Narrow the range or raise the minimum magnitude.";
    else if (loaded.length === 0) loadWarning = "USGS returned no events for this request.";
  } catch (err) {
    if (token !== loadToken) return;
    showStatus(`USGS request failed: ${err.message}`, "error");
    loaded = [];
  }

  events = loaded;
  detection = null;
  if (events.length > 0) {
    minTimeMs = events.reduce((m, e) => Math.min(m, e.timeMs), Infinity);
    maxTimeMs = events.reduce((m, e) => Math.max(m, e.timeMs), -Infinity);
    $("time-slider").value = 1000;
  } else {
    minTimeMs = maxTimeMs = 0;
  }
  processModel();
  await runDetection();
  if (events.length === 0 && loadWarning) showStatus(loadWarning, "warn");
}

// ---- tectonic plates -------------------------------------------------------
async function loadTectonicPlates() {
  try {
    tectonicLayer = L.geoJSON(await fetchTectonicPlates(), { style: { color: "#d97706", weight: 2, opacity: 0.85 } });
    if ($("toggle-tectonic").checked) tectonicLayer.addTo(map);
  } catch (err) {
    console.warn("Could not load tectonic plate boundaries", err);
  }
}

// ---- events ----------------------------------------------------------------
const rerender = () => scheduleRender();
let redetectTimer = null;
const redetect = () => { clearTimeout(redetectTimer); redetectTimer = setTimeout(runDetection, 450); };
window.addEventListener("resize", () => timeline.draw());

$("play-pause-btn").addEventListener("click", () => (isPlaying ? stopPlayback() : startPlayback()));
$("step-prev-btn").addEventListener("click", () => stepFrame(-10));
$("step-next-btn").addEventListener("click", () => stepFrame(10));
$("time-slider").addEventListener("input", () => { stopPlayback(); rerender(); });

$("data-mode-select").addEventListener("change", (e) => {
  const hist = e.target.value === "historical";
  $("historical-controls").style.display = hist ? "flex" : "none";
  $("realtime-controls").style.display = hist ? "none" : "flex";
  loadData();
});
$("fetch-hist-btn").addEventListener("click", loadData);
$("feed-select").addEventListener("change", loadData);

const bind = (id, labelId, fmt, after) => $(id).addEventListener("input", (e) => { $(labelId).textContent = fmt(e.target.value); after(); });
bind("window-slider", "window-val", (v) => `${v} Days`, rerender);
bind("h-slider", "h-val", (v) => `${Number(v).toFixed(2)} × baseline max`, rerender);
bind("event-bw-slider", "event-bw-val", (v) => `${v} km`, rerender);
bind("zone-bw-slider", "zone-bw-val", (v) => `${v} km`, rerender);
bind("baseline-slider", "baseline-val", (v) => `${v} %`, redetect);
bind("score-radius-slider", "score-radius-val", (v) => `${Number(v).toFixed(1)}°`, redetect);
bind("zone-radius-slider", "zone-radius-val", (v) => `${Number(v).toFixed(1)}°`, redetect);
$("event-weight-select").addEventListener("change", rerender);
for (const id of ["toggle-quakes", "toggle-event-heatmap", "toggle-cusum-heatmap", "toggle-anomalies"]) $(id).addEventListener("change", rerender);
$("toggle-tectonic").addEventListener("change", (e) => {
  if (!tectonicLayer) return;
  if (e.target.checked) map.addLayer(tectonicLayer); else map.removeLayer(tectonicLayer);
});

loadTectonicPlates();
loadData();
