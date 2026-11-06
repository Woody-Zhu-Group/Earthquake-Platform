import { fetchGlobalEventsLive, fetchTectonicPlates, getJson, loadRegionConfig } from "./api.js";
import { buildGlobalEvents, globalRange, timesOf, visibleEvents } from "./events.js";
import { KERNELS } from "./kernel.js";
import { RegionResult } from "./results.js";
import { WorldMap } from "./worldmap.js";
import { clamp, scrollCursor, wheelToFraction } from "./timeline.js";
import { DAY_MS, fmtDateTime } from "./util.js";

const $ = (id) => document.getElementById(id);
const PLAY_SECONDS = 30; // one full pass at 1x

const state = { world: null, regions: [], results: new Map(), live: [], events: [], times: [], selected: null,
  cursor: 0, range: { t0: 0, t1: 1 }, playing: false, lastFrame: 0, raf: 0, pending: false };

// ---- status -----------------------------------------------------------------
function status(msg, kind = "info") {
  const el = $("status-msg");
  el.className = msg ? `status-msg ${kind}` : "status-msg";
  el.textContent = msg;
}

// ---- settings from the sidebar ---------------------------------------------
function settings() {
  return {
    windowMs: Number($("window-slider").value) * DAY_MS,
    events: { kernel: $("ev-kernel").value, bwKm: Number($("ev-bw").value), sat: Number($("ev-sat").value) },
    zones: { kernel: $("zn-kernel").value, bwKm: Number($("zn-bw").value), sat: Number($("zn-sat").value) },
    eventWeight: $("ev-weight").value,
    showEvents: $("show-events").checked, showZones: $("show-zones").checked, showBaseline: $("show-baseline").checked,
    showMarkers: $("show-markers").checked, showZonePoints: $("show-zonepts").checked,
    minMag: Number($("min-mag").value), zoneStyle: $("zone-style").value,
  };
}

function renderAll() {
  state.pending = false;
  const S = settings();
  const start = state.cursor - S.windowMs;
  const events = visibleEvents(state.events, state.times, start, state.cursor, { minMag: S.minMag, selectedId: state.selected });
  state.world?.render(state.cursor, { S, range: state.range, events, results: state.results, allTimes: state.times });
  $("time-display").innerHTML = `<span><b>Window start:</b> ${fmtDateTime(start)}</span><br><span><b>Cursor:</b> ${fmtDateTime(state.cursor)}</span>`;
  const span = state.range.t1 - state.range.t0;
  $("time-slider").value = span > 0 ? Math.round(((state.cursor - state.range.t0) / span) * 10000) : 10000;
}

function scheduleRender() {
  if (state.pending) return;
  state.pending = true;
  requestAnimationFrame(renderAll);
}

// ---- time model -------------------------------------------------------------
function updateRange() {
  state.range = globalRange(state.results);
  state.cursor = clamp(state.cursor || state.range.t1, state.range.t0, state.range.t1);
}

/** Rebuild the pooled event list (region events + live events outside the regions that have detector results). */
function rebuildEvents() {
  state.events = buildGlobalEvents(state.regions, state.results, state.live);
  state.times = timesOf(state.events);
}

function setCursor(ms) {
  state.cursor = clamp(ms, state.range.t0, state.range.t1);
  scheduleRender();
}

function scrollBy(fraction) { setCursor(scrollCursor(state.cursor, fraction, state.range.t0, state.range.t1)); }

function onWheel(ev, where) {
  if (where === "map" && !(ev.shiftKey || $("wheel-map").checked)) return;   // plain wheel on a map keeps zooming it
  ev.preventDefault();
  ev.stopPropagation();
  stopPlayback();
  scrollBy(wheelToFraction(ev));
}

// ---- playback ---------------------------------------------------------------
function frame(now) {
  if (!state.playing) return;
  const dt = now - state.lastFrame;
  state.lastFrame = now;
  const span = state.range.t1 - state.range.t0;
  const next = state.cursor + (span / (PLAY_SECONDS * 1000)) * dt * Number($("speed").value);
  if (next >= state.range.t1) { setCursor(state.range.t1); stopPlayback(); return; }
  setCursor(next);
  state.raf = requestAnimationFrame(frame);
}

function startPlayback() {
  if (state.playing) return;
  if (state.cursor >= state.range.t1) state.cursor = state.range.t0;
  state.playing = true;
  state.lastFrame = performance.now();
  $("play-btn").textContent = "⏸ Pause";
  state.raf = requestAnimationFrame(frame);
}

function stopPlayback() {
  state.playing = false;
  cancelAnimationFrame(state.raf);
  $("play-btn").textContent = "▶ Play";
}

// ---- data -------------------------------------------------------------------
function attachResult(doc, source) {
  const result = new RegionResult(doc);
  const id = result.doc.region.id;
  if (!state.regions.some((r) => r.id === id)) throw new Error(`${source}: no region "${id}" on the map`);
  state.results.set(id, result);
  return result;
}

async function loadAutoResults() {
  let index;
  try { index = await getJson("./data/index.json"); } catch { return 0; }   // no data folder published: fine
  let loaded = 0;
  for (const entry of index.regions ?? []) {
    if (entry.status !== "ok") { if (entry.status === "error") status(`${entry.name}: ${entry.error}`, "warn"); continue; }
    try { attachResult(await getJson(`./data/${entry.file}`), entry.file); loaded++; }
    catch (err) { status(`${entry.file}: ${err.message}`, "error"); }
  }
  return loaded;
}

/** Worldwide events from USGS for the monitoring period. Detector regions keep their own (catalogue) events. */
async function fillLive() {
  const { t0, t1 } = state.range;
  try {
    state.live = await fetchGlobalEventsLive(t0, t1, 4.5);
    rebuildEvents();
  } catch (err) {
    world().setNotice(`Could not load worldwide events (${err.message}). Showing events inside detector regions only.`);
  }
}

const world = () => state.world;

async function loadFiles(files) {
  const problems = [];
  for (const file of files) {
    try {
      const doc = JSON.parse(await file.text());
      if (Array.isArray(doc.regions) && !doc.events) continue;                 // an index.json: nothing to attach
      attachResult(doc, file.name);
    } catch (err) { problems.push(`${file.name}: ${err.message}`); }
  }
  updateRange();
  rebuildEvents();
  state.cursor = state.range.t1;
  problems.length ? status(problems.join("\n"), "error") : status("");
  scheduleRender();
}

// ---- region selection --------------------------------------------------------
function selectRegion(id) {
  state.selected = id;
  const result = id ? state.results.get(id) : null;
  state.world.select(id, result);
  const region = state.regions.find((r) => r.id === id);
  state.world.setNotice(result?.standin ? "Stand-in scorer output (test fixture): not the score-matching model."
    : id && !result ? `No detector results for ${region.name} yet.` : "");
  scheduleRender();
}

// ---- wiring -----------------------------------------------------------------
function bindControls() {
  for (const id of ["ev-kernel", "zn-kernel"]) {
    $(id).innerHTML = Object.entries(KERNELS).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join("");
  }
  $("zn-kernel").value = "gaussian";
  const label = (id, valId, fmt) => $(id).addEventListener("input", () => { $(valId).textContent = fmt($(id).value); });
  label("window-slider", "window-val", (v) => `${v} days`);
  label("ev-bw", "ev-bw-val", (v) => `${v} km`);
  label("zn-bw", "zn-bw-val", (v) => `${v} km`);
  label("ev-sat", "ev-sat-val", (v) => v);
  label("zn-sat", "zn-sat-val", (v) => v);
  label("min-mag", "min-mag-val", (v) => `M ≥ ${Number(v).toFixed(1)}`);
  for (const id of ["window-slider", "ev-kernel", "ev-bw", "ev-sat", "ev-weight", "zn-kernel", "zn-bw", "zn-sat",
    "min-mag", "zone-style", "show-events", "show-zones", "show-baseline", "show-markers", "show-zonepts"]) {
    $(id).addEventListener("input", scheduleRender);
    $(id).addEventListener("change", scheduleRender);
  }
  $("show-tectonic").addEventListener("change", (e) => { state.world?.setTectonic(e.target.checked); });

  $("play-btn").addEventListener("click", () => (state.playing ? stopPlayback() : startPlayback()));
  const step = () => (state.range.t1 - state.range.t0) / 200;
  $("step-prev").addEventListener("click", () => { stopPlayback(); setCursor(state.cursor - step()); });
  $("step-next").addEventListener("click", () => { stopPlayback(); setCursor(state.cursor + step()); });
  $("time-slider").addEventListener("input", (e) => {
    stopPlayback();
    setCursor(state.range.t0 + (Number(e.target.value) / 10000) * (state.range.t1 - state.range.t0));
  });
  $("results-file").addEventListener("change", (e) => loadFiles([...e.target.files]));

  window.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && state.selected) { selectRegion(null); ev.preventDefault(); return; }
    const t = ev.target;
    if (t instanceof HTMLInputElement && t.type !== "checkbox" || t instanceof HTMLSelectElement || t instanceof HTMLTextAreaElement) return;
    const big = ev.shiftKey ? 10 : 1;
    if (ev.key === "ArrowRight") { stopPlayback(); setCursor(state.cursor + big * step()); }
    else if (ev.key === "ArrowLeft") { stopPlayback(); setCursor(state.cursor - big * step()); }
    else if (ev.key === "Home") { stopPlayback(); setCursor(state.range.t0); }
    else if (ev.key === "End") { stopPlayback(); setCursor(state.range.t1); }
    else if (ev.key === " ") { state.playing ? stopPlayback() : startPlayback(); }
    else return;
    ev.preventDefault();
  });
  window.addEventListener("resize", () => state.world?.invalidate());
}

async function init() {
  bindControls();
  try { state.regions = await loadRegionConfig(); }
  catch (err) { status(`Could not load regions.json: ${err.message}`, "error"); return; }

  state.world = new WorldMap({
    regions: state.regions,
    els: { map: $("map"), info: $("info"), strip: $("strip"), notice: $("notice"), back: $("back-btn") },
    onSelect: selectRegion, onScrub: (ms) => { stopPlayback(); setCursor(ms); }, onWheel,
  });
  fetchTectonicPlates().then((d) => { state.world.setTectonicData(d); state.world.setTectonic($("show-tectonic").checked); }).catch(() => {});

  const loaded = await loadAutoResults();
  updateRange();
  rebuildEvents();
  state.cursor = state.range.t1;
  renderAll();                       // regions and their detector output show immediately
  await fillLive();                  // then the rest of the world's events
  if (!loaded) status("No detector results found in ./data/. The map shows worldwide events only; load result files to run the CUSUM view on regions.", "warn");
  renderAll();
  setTimeout(() => state.world.invalidate(), 100);
}

init();
