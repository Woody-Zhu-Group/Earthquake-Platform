// Network access: region config, detector result files, and a live USGS fallback for events.
export const FDSN_LIMIT = 20000;
const FDSN_URL = "https://earthquake.usgs.gov/fdsnws/event/1/query";

export async function getJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(text.trim().slice(0, 200) || `HTTP ${response.status}`);
  }
  return response.json();
}

export async function loadRegionConfig(url = "./regions.json") {
  const cfg = await getJson(url);
  if (!Array.isArray(cfg.regions) || !cfg.regions.length) throw new Error("regions.json has no regions");
  return cfg.regions;
}

/** featureToEvent: GeoJSON feature -> flat event, or null when unusable. */
export function featureToEvent(f) {
  const c = f?.geometry?.coordinates, p = f?.properties;
  if (!Array.isArray(c) || c.length < 2 || !p || p.mag == null || p.time == null) return null;
  return { id: f.id, lon: c[0], lat: c[1], depth: c[2] ?? null, mag: Number(p.mag), timeMs: Number(p.time),
           place: p.place || "Unknown location", measure: null };
}

export const parseFeatures = (geojson) =>
  (geojson?.features ?? []).map(featureToEvent).filter(Boolean).sort((a, b) => a.timeMs - b.timeMs);

/** Live fallback when a region has no detector file: USGS events inside the region for the last `days` days. */
export async function fetchRegionEventsLive(bbox, days, minMag, now = Date.now()) {
  const iso = (ms) => new Date(ms).toISOString().slice(0, 19);
  const [west, south, east, north] = bbox;
  const q = new URLSearchParams({
    format: "geojson", starttime: iso(now - days * 86_400_000), endtime: iso(now), minmagnitude: String(minMag),
    minlongitude: west, minlatitude: south, maxlongitude: east, maxlatitude: north,
    eventtype: "earthquake", orderby: "time-asc", limit: String(FDSN_LIMIT),
  });
  return parseFeatures(await getJson(`${FDSN_URL}?${q}`));
}

export async function fetchTectonicPlates() {
  return getJson("https://raw.githubusercontent.com/fraxen/tectonicplates/master/GeoJSON/PB2002_boundaries.json");
}

/** Worldwide USGS events for [t0, t1], fetched in chunks so no single query reaches the FDSN limit. */
export async function fetchGlobalEventsLive(t0, t1, minMag = 4.5, { chunkDays = 90, maxChunks = 14 } = {}) {
  const iso = (ms) => new Date(ms).toISOString().slice(0, 19);
  const step = chunkDays * 86_400_000;
  const spans = [];
  for (let a = t0; a < t1 && spans.length < maxChunks; a += step) spans.push([a, Math.min(t1, a + step)]);
  const parts = await Promise.all(spans.map(([a, b]) => getJson(`${FDSN_URL}?${new URLSearchParams({
    format: "geojson", starttime: iso(a), endtime: iso(b), minmagnitude: String(minMag),
    eventtype: "earthquake", orderby: "time-asc", limit: String(FDSN_LIMIT),
  })}`)));
  const seen = new Set();
  return parts.flatMap(parseFeatures).filter((e) => (seen.has(e.id) ? false : seen.add(e.id))).sort((a, b) => a.timeMs - b.timeMs);
}
