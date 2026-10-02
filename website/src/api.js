// USGS data access. Same sources as services/cusum_engine/usgs.py.
export const FDSN_LIMIT = 20000; // hard cap enforced by the USGS FDSN service

const SUMMARY_URL = (feed) => `https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/${feed}.geojson`;
const FDSN_URL = "https://earthquake.usgs.gov/fdsnws/event/1/query";

/** GeoJSON feature -> flat event, or null when the event cannot be used (no mag/time/coords). */
export function featureToEvent(f) {
  const c = f?.geometry?.coordinates;
  const p = f?.properties;
  if (!Array.isArray(c) || c.length < 2 || !p || p.mag == null || p.time == null) return null;
  return {
    id: f.id, lon: c[0], lat: c[1], depth: c[2] ?? null,
    mag: Number(p.mag), timeMs: Number(p.time), place: p.place || "Unknown location",
  };
}

export const parseFeatures = (geojson) =>
  (geojson?.features ?? []).map(featureToEvent).filter(Boolean).sort((a, b) => a.timeMs - b.timeMs);

async function getJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(text.trim().slice(0, 200) || `HTTP ${response.status}`);
  }
  return response.json();
}

export async function fetchHistorical(startDate, endDate, minMag) {
  if (!startDate || !endDate) throw new Error("Choose both a start and an end date.");
  if (startDate > endDate) throw new Error("Start date is after the end date.");
  const q = new URLSearchParams({
    format: "geojson", starttime: `${startDate}T00:00:00`, endtime: `${endDate}T23:59:59`,
    minmagnitude: String(minMag), eventtype: "earthquake", orderby: "time-asc", limit: String(FDSN_LIMIT),
  });
  return parseFeatures(await getJson(`${FDSN_URL}?${q}`));
}

export async function fetchSummaryFeed(feed) {
  return parseFeatures(await getJson(SUMMARY_URL(feed)));
}

export async function fetchTectonicPlates() {
  return getJson("https://raw.githubusercontent.com/fraxen/tectonicplates/master/GeoJSON/PB2002_boundaries.json");
}
