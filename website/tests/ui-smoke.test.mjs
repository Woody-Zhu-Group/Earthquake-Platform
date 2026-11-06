// Runs the real main.js / worldmap.js against a minimal fake DOM + fake Leaflet. It catches runtime errors and wiring
// mistakes (wrong ids, missing methods, bad data flow); it cannot judge visuals. Use a real browser for that.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");
const regionsJson = read("../../shared/regions.json");
const fixtureIndex = read("../../tests/fixtures/standin_index.json");
const fixtureResult = read("../../tests/fixtures/standin_california.json");

// ---- fake DOM -------------------------------------------------------------------
const created = [];
function fakeEl(tag = "div") {
  const kids = {};
  const el = {
    tag, value: "", checked: false, textContent: "", innerHTML: "", className: "", style: {}, dataset: {}, handlers: {},
    clientWidth: 600, clientHeight: 72, width: 600, height: 72,
    classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, contains(c) { return this._s.has(c); },
                 toggle(c, on) { (on ?? !this._s.has(c)) ? this._s.add(c) : this._s.delete(c); } },
    addEventListener(type, fn, opts) { (el.handlers[type] ||= []).push({ fn, opts }); },
    appendChild() {}, setPointerCapture() {}, getBoundingClientRect: () => ({ left: 0, top: 0, width: 600, height: 72 }),
    querySelector(sel) { return (kids[sel] ||= fakeEl()); },
    getContext: () => new Proxy({}, { get: (_, k) => (k === "measureText" ? () => ({ width: 10 }) : () => {}), set: () => true }),
    toDataURL: () => "data:image/png;base64,AAAA",
  };
  created.push(el);
  return el;
}
const byId = {};
const sliderDefaults = { "window-slider": "30", "ev-bw": "50", "ev-sat": "3", "zn-bw": "100", "zn-sat": "2", "speed": "1", "time-slider": "10000", "ev-weight": "count", "zone-style": "both", "ev-kernel": "gaussian", "zn-kernel": "gaussian" };
globalThis.document = {
  getElementById: (id) => (byId[id] ||= Object.assign(fakeEl(), { value: sliderDefaults[id] ?? "", checked: ["show-events", "show-zones", "show-markers"].includes(id) })),
  createElement: (tag) => fakeEl(tag),
};
globalThis.window = { devicePixelRatio: 1, addEventListener(type, fn) { (globalThis.window.handlers[type] ||= []).push(fn); }, handlers: {} };
globalThis.HTMLInputElement = class {}; globalThis.HTMLSelectElement = class {}; globalThis.HTMLTextAreaElement = class {};
globalThis.ImageData = class { constructor(d, w, h) { this.data = d; this.width = w; this.height = h; } };
let rafQueue = [];
globalThis.requestAnimationFrame = (fn) => { rafQueue.push(fn); return rafQueue.length; };
globalThis.cancelAnimationFrame = () => {};
const flush = (now = 1000) => { const q = rafQueue; rafQueue = []; q.forEach((f) => f(now)); };

// ---- fake Leaflet -----------------------------------------------------------------
const calls = { polyline: 0, imageOverlay: 0, circleMarker: 0, setUrl: 0, removeLayer: 0, rectangle: 0, fitBounds: [] };
const rectHandlers = {};
const layer = () => { const l = { addTo() { return l; }, bindPopup() { return l; }, bindTooltip() { return l; }, setStyle() { return l; }, on() { return l; },
                                 clearLayers() {}, setUrl() { calls.setUrl++; }, setBounds() {} }; return l; };
globalThis.L = {
  map: () => ({ fitBounds(b) { calls.fitBounds.push(b); }, on() {}, invalidateSize() {}, removeLayer() { calls.removeLayer++; },
                getBounds: () => ({ pad: () => ({ getWest: () => -180, getEast: () => 180, getSouth: () => -60, getNorth: () => 78 }) }) }),
  control: { zoom: () => layer() }, tileLayer: () => layer(), layerGroup: () => layer(), geoJSON: () => layer(),
  rectangle: () => { calls.rectangle++; const l = layer(); l.on = (type, fn) => { (rectHandlers[calls.rectangle] ||= {})[type] = fn; return l; }; return l; },
  polyline: () => { calls.polyline++; return layer(); },
  circleMarker: () => { calls.circleMarker++; return layer(); },
  imageOverlay: () => { calls.imageOverlay++; return layer(); },
};

// ---- fake network ------------------------------------------------------------------
const requested = [];
const caEnd = JSON.parse(fixtureResult).time.monitor_end_ms;
globalThis.fetch = async (url) => {
  requested.push(String(url));
  const ok = (body) => ({ ok: true, status: 200, json: async () => JSON.parse(body), text: async () => body });
  const u = String(url);
  if (u.endsWith("regions.json")) return ok(regionsJson);
  if (u.endsWith("data/index.json")) return ok(fixtureIndex);
  if (u.endsWith("standin_california.json")) return ok(fixtureResult);
  if (u.includes("fdsnws")) {
    const f = (id, lon, lat) => ({ id, properties: { mag: 5.1, time: caEnd - 86400000, place: `Live ${id}` }, geometry: { coordinates: [lon, lat, 10] } });
    return ok(JSON.stringify({ features: [f("atlantic", -30, 0), f("in-california", -120, 36)] }));
  }
  return { ok: false, status: 404, text: async () => "nope", json: async () => ({}) };
};

const settle = async () => { for (let i = 0; i < 20; i++) { await new Promise((r) => setTimeout(r, 0)); flush(); } };
await import("../src/main.js");
await settle();

const info = () => byId["info"].innerHTML;
const key = (k, o = {}, run = true) => { const ev = { key: k, target: {}, shiftKey: false, prevented: false, preventDefault() { this.prevented = true; }, ...o }; window.handlers.keydown.forEach((h) => h(ev)); if (run) flush(); return ev; };
const clickRegion = (id) => byId["info"].handlers.click[0].fn({ target: { closest: () => ({ dataset: { region: id } }) } });

test("there is one world map with one clickable box per configured region", () => {
  assert.equal(created.filter((e) => e.className === "panel").length, 0, "no per-region panels");
  assert.equal(calls.rectangle, 4);
  assert.ok(calls.fitBounds.length >= 1, "starts zoomed to the world");
});

test("worldwide events are fetched without a bbox; detector results load for California only", () => {
  const live = requested.filter((u) => u.includes("fdsnws"));
  assert.ok(live.length >= 1);
  assert.ok(live.every((u) => !u.includes("minlongitude=")), "global queries are not restricted to a region");
  assert.ok(requested.some((u) => u.endsWith("data/standin_california.json")));
});

test("world view lists every region; only California has detector output", () => {
  assert.match(info(), /World<\/b> \d+ events/);
  for (const name of ["California", "Japan and surroundings", "Central &amp; South America", "Sumatra / Indonesia"]) assert.match(info(), new RegExp(name));
  assert.match(info(), /California<\/b> CUSUM/);
  assert.equal((info().match(/no results/g) || []).length, 3);
  assert.match(byId["status-msg"].textContent, /no data \(fixture\)/);
});

test("rendering draws the kernel overlays and markers", () => {
  assert.ok(calls.imageOverlay >= 2, `overlays created: ${calls.imageOverlay}`);
  assert.ok(calls.circleMarker > 0);
  assert.match(byId["time-display"].innerHTML, /Cursor/);
});

test("clicking a region zooms to it and shows its detector state; the back button and Escape return to the world", () => {
  const zoomsBefore = calls.fitBounds.length;
  clickRegion("california"); flush();
  assert.equal(calls.fitBounds.length, zoomsBefore + 1);
  const f = JSON.parse(fixtureResult).frame;
  assert.deepEqual(calls.fitBounds.at(-1), [[f.south, f.west], [f.north, f.east]], "zooms to the detector frame");
  assert.match(info(), /Region<\/b> California/);
  assert.match(info(), /CUSUM/);
  assert.match(info(), /STAND-IN/);
  assert.match(byId["notice"].textContent, /not the score-matching model/i);
  assert.equal(byId["back-btn"].style.display, "inline-block");

  byId["back-btn"].handlers.click[0].fn(); flush();
  assert.match(info(), /World<\/b>/);
  assert.equal(byId["back-btn"].style.display, "none");

  clickRegion("california"); flush();
  assert.ok(key("Escape").prevented);
  assert.match(info(), /World<\/b>/);
});

test("a region without results zooms in and says how to run the detector, instead of failing", () => {
  clickRegion("japan"); flush();
  assert.match(info(), /Region<\/b> Japan/);
  assert.match(info(), /--region japan/);
  assert.doesNotMatch(info(), /CUSUM/);
  assert.match(byId["notice"].textContent, /No detector results for Japan/);
  clickRegion(null); flush();
});

const stripWheel = (ev) => byId["strip"].handlers.wheel.at(-1).fn(ev);
const mkWheel = (o = {}) => ({ deltaY: 400, deltaX: 0, deltaMode: 0, shiftKey: false, altKey: false, prevented: false, preventDefault() { this.prevented = true; }, stopPropagation() {}, ...o });
const cursorFraction = () => Number(byId["time-slider"].value);

test("scrolling on a timeline strip moves time (down = later, up = earlier) and prevents page scroll", () => {
  byId["time-slider"].value = "10000";
  const up = mkWheel({ deltaY: -1000 }); stripWheel(up); flush();
  const afterUp = cursorFraction();
  assert.ok(up.prevented && afterUp < 10000, `up -> earlier (${afterUp})`);
  const down = mkWheel({ deltaY: 400 }); stripWheel(down); flush();
  assert.ok(cursorFraction() > afterUp, "down -> later");
});

test("wheel on a map only scrolls time with Shift or the checkbox; plain wheel is left to Leaflet zoom", () => {
  const mapWheel = (ev) => byId["map"].handlers.wheel.at(-1).fn(ev);
  const plain = mkWheel({ deltaY: -400 }); mapWheel(plain);
  assert.equal(plain.prevented, false, "plain wheel untouched");
  const shifted = mkWheel({ deltaY: -400, shiftKey: true }); mapWheel(shifted);
  assert.equal(shifted.prevented, true);
  byId["wheel-map"].checked = true;
  const toggled = mkWheel({ deltaY: -400 }); mapWheel(toggled);
  assert.equal(toggled.prevented, true);
  byId["wheel-map"].checked = false;
});

test("dragging on a strip seeks to that time, and scrubbing the strip moves the shared cursor", () => {
  const strip = byId["strip"];
  strip.handlers.pointerdown[0].fn({ clientX: 150, pointerId: 1 }); flush();
  const f = cursorFraction();
  assert.ok(f > 1000 && f < 9000, `quarter-way (${f})`);
  strip.handlers.pointermove[0].fn({ clientX: 450 }); flush();
  assert.ok(cursorFraction() > f);
  strip.handlers.pointerup[0].fn({});
  strip.handlers.pointermove[0].fn({ clientX: 10 }); flush();
  assert.ok(cursorFraction() > f, "no seeking after pointer release");
});

test("keyboard: arrows step, Shift steps 10x, Home/End jump, Space toggles playback", () => {
    key("Home"); assert.equal(cursorFraction(), 0);
  key("ArrowRight"); const one = cursorFraction();
  assert.ok(one > 0 && one <= 60, `one step ~ 1/200 of span (${one})`);
  key("ArrowRight", { shiftKey: true }); assert.ok(cursorFraction() > one * 5);
  key("End"); assert.equal(cursorFraction(), 10000);
  const ev = key("ArrowLeft"); assert.ok(ev.prevented && cursorFraction() < 10000);
  assert.equal(key("x").prevented, false, "unrelated keys are not swallowed");
  key(" ", {}, false); assert.match(byId["play-btn"].textContent, /Pause/);   // (no frame flush: the fake clock is not performance.now)
  key(" ", {}, false); assert.match(byId["play-btn"].textContent, /Play/);
});

test("playback advances the cursor with real frame timing and stops at the end", () => {
  window.handlers.keydown.forEach((h) => h({ key: "Home", target: {}, preventDefault() {} })); flush();
  byId["play-btn"].handlers.click[0].fn(); 
  let t = 1000;
  for (let i = 0; i < 5; i++) { t += 1000; flush(t); }
  assert.ok(cursorFraction() > 0 && cursorFraction() < 10000, `advanced (${cursorFraction()})`);
  for (let i = 0; i < 80; i++) { t += 1000; flush(t); }
  assert.equal(cursorFraction(), 10000);
  assert.match(byId["play-btn"].textContent, /Play/, "stops itself at the end");
});

test("changing a kernel, bandwidth or layer toggle re-renders without error", () => {
  const before = calls.imageOverlay + calls.setUrl;
  byId["ev-kernel"].value = "epanechnikov"; byId["ev-kernel"].handlers.change.forEach((h) => h.fn()); flush();
  byId["zone-style"].value = "contours"; byId["zone-style"].handlers.change.forEach((h) => h.fn()); flush();
  byId["zn-bw"].value = "250"; byId["zn-bw"].handlers.input.forEach((h) => h.fn()); flush();
  byId["show-baseline"].checked = true; byId["show-baseline"].handlers.change.forEach((h) => h.fn()); flush();
  byId["show-zones"].checked = false; byId["show-zones"].handlers.change.forEach((h) => h.fn()); flush();
  assert.ok(calls.imageOverlay + calls.setUrl > before);
  assert.equal(byId["zn-bw-val"].textContent, "250 km");
});

test("loading a result file by hand attaches it; a bad file reports an error instead of throwing", async () => {
  const file = (name, text) => ({ name, text: async () => text });
  await byId["results-file"].handlers.change[0].fn({ target: { files: [file("ok.json", fixtureResult)] } });
  await settle();
  assert.equal(byId["status-msg"].textContent, "");
  await byId["results-file"].handlers.change[0].fn({ target: { files: [file("bad.json", "{not json"), file("old.json", JSON.stringify({ version: 1 }))] } });
  await settle();
  assert.match(byId["status-msg"].textContent, /bad\.json/);
  assert.match(byId["status-msg"].textContent, /old\.json: Not a detector result file: version 1/);
  const wrongRegion = JSON.parse(fixtureResult); wrongRegion.region.id = "atlantis";
  await byId["results-file"].handlers.change[0].fn({ target: { files: [file("x.json", JSON.stringify(wrongRegion))] } });
  await settle();
  assert.match(byId["status-msg"].textContent, /no region "atlantis" on the map/);
});

test("the selected region shows the detector state at the cursor: empty at the start of monitoring, populated at the end", () => {
  clickRegion("california"); flush();
  const region = () => Number(/Region ω<\/b> (\d+) pts/.exec(info())[1]);
  key("Home");
  assert.equal(region(), 0, "no anomaly region before the detector has seen any data");
  assert.match(info(), /CUSUM<\/b> 0 /);
  key("End");
  assert.ok(region() > 10, `region omega at the end: ${region()}`);
  assert.doesNotMatch(info(), /CUSUM<\/b> 0 /);
});

test("the anomaly zone is drawn as contour lines when a region with detector output is shown", () => {
  byId["zone-style"].value = "both"; byId["zone-style"].handlers.change.forEach((h) => h.fn());
  byId["zn-bw"].value = "100"; byId["zn-bw"].handlers.input.forEach((h) => h.fn());
  byId["show-zones"].checked = true; byId["show-zones"].handlers.change.forEach((h) => h.fn());
  const before = calls.polyline;
  key("End");
  assert.ok(calls.polyline > before, `contour polylines drawn: ${calls.polyline - before}`);
});
