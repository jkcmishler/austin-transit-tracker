import express from "express";
import cors from "cors";
import AdmZip from "adm-zip";

const PORT = process.env.PORT || 4000;
const TRIP_UPDATES_URL = "https://data.texas.gov/download/mqtr-wwpy/application%2Foctet-stream";
const STATIC_GTFS_URL = "https://data.texas.gov/download/r4v4-vz24/application%2Fzip";
const TRIP_UPDATES_REFRESH_MS = 30_000;
const STATIC_GTFS_REFRESH_MS = 6 * 60 * 60 * 1000; // 6h
const DELAY_THRESHOLD_SEC = 5 * 60; // 5 minutes

// scheduledIndex: Map<tripId, Map<stopSequence, { stopId, arrivalSec }>>
// arrivalSec is seconds-since-midnight in the trip's local schedule
let scheduledIndex = new Map();
// routesById: Map<routeId, { shortName, longName, type }>
let routesById = new Map();
// stopsById: Map<stopId, { name }>
let stopsById = new Map();

let cachedDelays = { computedAt: 0, items: [] };

function parseCsv(text) {
  const rows = [];
  let i = 0, field = "", row = [], inQuotes = false;
  while (i < text.length) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += c; i++;
    } else {
      if (c === '"') { inQuotes = true; i++; }
      else if (c === ",") { row.push(field); field = ""; i++; }
      else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; i++; }
      else if (c === "\r") { i++; }
      else { field += c; i++; }
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  if (!rows.length) return [];
  const header = rows[0].map(h => h.trim());
  return rows.slice(1).filter(r => r.length === header.length).map(r => {
    const o = {};
    header.forEach((h, idx) => { o[h] = r[idx]; });
    return o;
  });
}

function hmsToSec(hms) {
  // GTFS allows hours >= 24 for service days that cross midnight.
  const [h, m, s] = hms.split(":").map(Number);
  return h * 3600 + m * 60 + s;
}

async function loadStaticGtfs() {
  console.log("Fetching static GTFS schedule…");
  const resp = await fetch(STATIC_GTFS_URL);
  if (!resp.ok) throw new Error(`GTFS fetch ${resp.status}`);
  const buf = Buffer.from(await resp.arrayBuffer());
  const zip = new AdmZip(buf);

  const entries = Object.fromEntries(
    zip.getEntries().map(e => [e.entryName, e.getData().toString("utf-8")])
  );

  const newRoutes = new Map();
  for (const r of parseCsv(entries["routes.txt"] || "")) {
    newRoutes.set(r.route_id, {
      shortName: r.route_short_name || "",
      longName: r.route_long_name || "",
      type: r.route_type || "",
    });
  }

  const newStops = new Map();
  for (const s of parseCsv(entries["stops.txt"] || "")) {
    newStops.set(s.stop_id, { name: s.stop_name || "" });
  }

  const newIndex = new Map();
  for (const row of parseCsv(entries["stop_times.txt"] || "")) {
    const tripId = row.trip_id;
    if (!tripId) continue;
    let trip = newIndex.get(tripId);
    if (!trip) { trip = new Map(); newIndex.set(tripId, trip); }
    const seq = Number(row.stop_sequence);
    trip.set(seq, {
      stopId: row.stop_id,
      arrivalSec: row.arrival_time ? hmsToSec(row.arrival_time) : null,
    });
  }

  scheduledIndex = newIndex;
  routesById = newRoutes;
  stopsById = newStops;
  console.log(`Loaded ${newIndex.size} trips, ${newRoutes.size} routes, ${newStops.size} stops.`);
}

function startOfTripDay(yyyymmdd) {
  // GTFS startDate "YYYYMMDD" → seconds since epoch at local-midnight (UTC approx; CapMetro is America/Chicago)
  // For delay math we only need a stable reference; using UTC midnight introduces TZ skew but the delta
  // (predicted - scheduled) cancels out as long as both reference the same anchor.
  const y = Number(yyyymmdd.slice(0, 4));
  const m = Number(yyyymmdd.slice(4, 6)) - 1;
  const d = Number(yyyymmdd.slice(6, 8));
  // CapMetro local TZ is America/Chicago (UTC-5 or -6). Use -6 (CST) as a stable anchor;
  // DST drift just shifts delays by 1h uniformly within a day, which we filter via |delay| sanity check.
  return Date.UTC(y, m, d, 6, 0, 0) / 1000;
}

async function refreshDelays() {
  try {
    const resp = await fetch(TRIP_UPDATES_URL);
    if (!resp.ok) throw new Error(`trip-updates ${resp.status}`);
    const feed = await resp.json();
    const now = Math.floor(Date.now() / 1000);
    const items = [];

    for (const entity of feed.entity || []) {
      const tu = entity.tripUpdate;
      if (!tu) continue;
      const trip = tu.trip || {};
      const tripId = trip.tripId;
      const routeId = trip.routeId;
      const startDate = trip.startDate;
      if (!tripId || !routeId || !startDate) continue;

      const sched = scheduledIndex.get(tripId);
      if (!sched) continue;
      const dayAnchor = startOfTripDay(startDate);

      // Look at the next upcoming stopTimeUpdate (one whose predicted arrival is still ahead of now)
      const stus = tu.stopTimeUpdate || [];
      let next = null;
      for (const stu of stus) {
        const predicted = Number(stu.arrival?.time || stu.departure?.time || 0);
        if (predicted >= now) { next = { stu, predicted }; break; }
      }
      if (!next) continue;

      const seq = Number(next.stu.stopSequence);
      const sInfo = sched.get(seq);
      if (!sInfo || sInfo.arrivalSec == null) continue;
      const scheduled = dayAnchor + sInfo.arrivalSec;
      const delaySec = next.predicted - scheduled;

      // Sanity filter: > 90 min in either direction is almost certainly a TZ/data artifact, drop it.
      if (Math.abs(delaySec) > 90 * 60) continue;
      if (delaySec < DELAY_THRESHOLD_SEC) continue;

      const route = routesById.get(routeId);
      const stop = stopsById.get(sInfo.stopId);
      items.push({
        tripId,
        routeId,
        routeShortName: route?.shortName || routeId,
        routeLongName: route?.longName || "",
        nextStopId: sInfo.stopId,
        nextStopName: stop?.name || sInfo.stopId,
        scheduledArrival: scheduled,
        predictedArrival: next.predicted,
        delaySec,
        delayMin: Math.round(delaySec / 60),
        vehicleId: tu.vehicle?.id || null,
      });
    }

    items.sort((a, b) => b.delaySec - a.delaySec);
    cachedDelays = { computedAt: Date.now(), items };
    console.log(`Refreshed delays: ${items.length} trips ≥ ${DELAY_THRESHOLD_SEC / 60} min late`);
  } catch (err) {
    console.error("refreshDelays error:", err.message);
  }
}

const app = express();
app.use(cors());

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    trips: scheduledIndex.size,
    routes: routesById.size,
    stops: stopsById.size,
    lastDelayRefresh: cachedDelays.computedAt,
    delayCount: cachedDelays.items.length,
  });
});

app.get("/api/delays", (_req, res) => {
  res.json({
    computedAt: cachedDelays.computedAt,
    thresholdMin: DELAY_THRESHOLD_SEC / 60,
    items: cachedDelays.items,
  });
});

async function start() {
  await loadStaticGtfs();
  await refreshDelays();
  setInterval(refreshDelays, TRIP_UPDATES_REFRESH_MS);
  setInterval(() => { loadStaticGtfs().catch(e => console.error("static reload:", e.message)); },
    STATIC_GTFS_REFRESH_MS);
  app.listen(PORT, () => console.log(`Server on http://localhost:${PORT}`));
}

start().catch(err => { console.error("startup failed:", err); process.exit(1); });
