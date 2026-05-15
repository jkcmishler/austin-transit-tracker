import express from "express";
import cors from "cors";
import AdmZip from "adm-zip";
import webpush from "web-push";
import { db } from "./db.js";
import { startOfChicagoDayFromYmd, chicagoYmdFromEpochSec } from "./tz.js";

const VAPID_PUBLIC = process.env.VAPID_PUBLIC_KEY || "";
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY || "";
const VAPID_CONTACT = process.env.VAPID_CONTACT || "mailto:dev@example.com";
const PUSH_ENABLED = Boolean(VAPID_PUBLIC && VAPID_PRIVATE);
if (PUSH_ENABLED) {
  webpush.setVapidDetails(VAPID_CONTACT, VAPID_PUBLIC, VAPID_PRIVATE);
  console.log("Web push enabled.");
} else {
  console.log("Web push disabled (VAPID keys not set).");
}

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

const startOfTripDay = startOfChicagoDayFromYmd;

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

      // Data-quality sanity filter: > 3h delay is almost always a stale/bad feed row.
      if (Math.abs(delaySec) > 3 * 60 * 60) continue;
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

    // Persist snapshot for pattern analysis (one row per currently-delayed trip)
    if (items.length) {
      const tx = db.transaction((rows) => {
        for (const r of rows) insertSnapshot.run(r);
      });
      tx(items.map(d => ({
        capturedAt: cachedDelays.computedAt,
        tripId: d.tripId,
        routeId: d.routeId,
        nextStopId: d.nextStopId,
        scheduledArrival: d.scheduledArrival,
        delaySec: d.delaySec,
      })));
    }

    if (PUSH_ENABLED) await sendPushNotifications(items);
  } catch (err) {
    console.error("refreshDelays error:", err.message);
  }
}

async function sendPushNotifications(delayedItems) {
  const subs = allSubscriptions.all();
  if (!subs.length) return;

  for (const sub of subs) {
    let routeIds;
    try { routeIds = JSON.parse(sub.route_ids); } catch { continue; }
    if (!Array.isArray(routeIds) || !routeIds.length) continue;
    const watching = new Set(routeIds);

    // For each delayed trip on a watched route, send one notification per trip per device (ever).
    for (const d of delayedItems) {
      if (!watching.has(d.routeId)) continue;
      if (hasSentPush.get(d.tripId, sub.device_id)) continue;

      const payload = JSON.stringify({
        title: `Route ${d.routeShortName} is ${d.delayMin} min late`,
        body: `Next stop: ${d.nextStopName} — expected ${new Date(d.predictedArrival * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`,
        url: "/",
        tag: `route-${d.routeId}`,
      });

      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          payload,
        );
        recordSentPush.run(d.tripId, sub.device_id, Date.now());
      } catch (err) {
        // 404/410 = subscription gone; clean up
        if (err.statusCode === 404 || err.statusCode === 410) {
          deleteSubscription.run(sub.device_id);
          console.log(`Removed dead subscription ${sub.device_id}`);
          break; // sub is gone, skip remaining items for this device
        }
        console.error(`Push error for ${sub.device_id}:`, err.statusCode || err.message);
      }
    }
  }
}

// ---- prepared statements ----
const insertSnapshot = db.prepare(`
  INSERT INTO delay_snapshots (captured_at, trip_id, route_id, next_stop_id, scheduled_arrival, delay_sec)
  VALUES (@capturedAt, @tripId, @routeId, @nextStopId, @scheduledArrival, @delaySec)
`);
const patternForRoute = db.prepare(`
  SELECT
    chicago_day(captured_at / 1000) AS local_day,
    COUNT(*) AS snapshots,
    AVG(delay_sec) AS avg_delay,
    MAX(delay_sec) AS max_delay
  FROM delay_snapshots
  WHERE route_id = @routeId AND captured_at >= @since
  GROUP BY local_day
  ORDER BY local_day DESC
`);
const bulkPatterns = db.prepare(`
  SELECT
    route_id,
    chicago_day(captured_at / 1000) AS local_day,
    COUNT(*) AS snapshots
  FROM delay_snapshots
  WHERE captured_at >= @since
  GROUP BY route_id, local_day
  HAVING snapshots >= @minPerDay
`);

const subscriptionByDevice = db.prepare(`SELECT * FROM push_subscriptions WHERE device_id = ?`);

const upsertSubscription = db.prepare(`
  INSERT INTO push_subscriptions (device_id, endpoint, p256dh, auth, route_ids, created_at, updated_at)
  VALUES (@deviceId, @endpoint, @p256dh, @auth, @routeIds, @now, @now)
  ON CONFLICT (device_id) DO UPDATE SET
    endpoint = excluded.endpoint,
    p256dh = excluded.p256dh,
    auth = excluded.auth,
    route_ids = excluded.route_ids,
    updated_at = excluded.updated_at
`);
const updateSubscriptionRoutes = db.prepare(`
  UPDATE push_subscriptions SET route_ids = @routeIds, updated_at = @now WHERE device_id = @deviceId
`);
const deleteSubscription = db.prepare(`DELETE FROM push_subscriptions WHERE device_id = ?`);
const allSubscriptions = db.prepare(`SELECT * FROM push_subscriptions`);
const hasSentPush = db.prepare(`SELECT 1 FROM push_sent WHERE trip_id = ? AND device_id = ?`);
const recordSentPush = db.prepare(`
  INSERT OR IGNORE INTO push_sent (trip_id, device_id, sent_at) VALUES (?, ?, ?)
`);

const upsertFeedback = db.prepare(`
  INSERT INTO feedback (trip_id, stop_id, scheduled_arrival, value, device_id, created_at)
  VALUES (@tripId, @stopId, @scheduledArrival, @value, @deviceId, @createdAt)
  ON CONFLICT (trip_id, stop_id, scheduled_arrival, device_id) DO UPDATE
    SET value = excluded.value, created_at = excluded.created_at
`);
const tallyFeedback = db.prepare(`
  SELECT
    SUM(CASE WHEN value = 'showed' THEN 1 ELSE 0 END) AS showed,
    SUM(CASE WHEN value = 'missed' THEN 1 ELSE 0 END) AS missed
  FROM feedback
  WHERE trip_id = @tripId AND stop_id = @stopId AND scheduled_arrival = @scheduledArrival
`);

function attachFeedback(items) {
  return items.map(d => {
    const t = tallyFeedback.get({
      tripId: d.tripId,
      stopId: d.nextStopId,
      scheduledArrival: d.scheduledArrival,
    });
    return { ...d, showedVotes: t?.showed || 0, missedVotes: t?.missed || 0 };
  });
}

const app = express();
app.use(cors());
app.use(express.json());

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
    items: attachFeedback(cachedDelays.items),
  });
});

app.get("/api/patterns", (_req, res) => {
  const since = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const MIN_PER_DAY = 3;
  const rows = bulkPatterns.all({ since, minPerDay: MIN_PER_DAY });
  const counts = new Map();
  for (const r of rows) counts.set(r.route_id, (counts.get(r.route_id) || 0) + 1);
  res.json({
    windowDays: 7,
    minSnapshotsPerDay: MIN_PER_DAY,
    routes: Object.fromEntries(counts),
  });
});

app.get("/api/patterns/:routeId", (req, res) => {
  const since = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const days = patternForRoute.all({ routeId: req.params.routeId, since });
  // A "late day" = had at least MIN_SNAPSHOTS_PER_DAY late readings (≥5 min)
  const MIN_SNAPSHOTS_PER_DAY = 3;
  const lateDays = days.filter(d => d.snapshots >= MIN_SNAPSHOTS_PER_DAY);
  res.json({
    routeId: req.params.routeId,
    lateDays: lateDays.length,
    windowDays: 7,
    perDay: days.map(d => ({
      day: d.local_day,
      snapshots: d.snapshots,
      avgDelayMin: Math.round(d.avg_delay / 60),
      maxDelayMin: Math.round(d.max_delay / 60),
    })),
  });
});

app.get("/api/push/vapid-public-key", (_req, res) => {
  if (!PUSH_ENABLED) return res.status(503).json({ error: "push disabled" });
  res.json({ key: VAPID_PUBLIC });
});

app.post("/api/push/subscribe", (req, res) => {
  if (!PUSH_ENABLED) return res.status(503).json({ error: "push disabled" });
  const { deviceId, subscription, routeIds } = req.body || {};
  if (!deviceId || !subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
    return res.status(400).json({ error: "missing fields" });
  }
  const routes = Array.isArray(routeIds) ? routeIds.filter(r => typeof r === "string") : [];
  upsertSubscription.run({
    deviceId,
    endpoint: subscription.endpoint,
    p256dh: subscription.keys.p256dh,
    auth: subscription.keys.auth,
    routeIds: JSON.stringify(routes),
    now: Date.now(),
  });
  res.json({ ok: true, watching: routes.length });
});

app.post("/api/push/update-routes", (req, res) => {
  if (!PUSH_ENABLED) return res.status(503).json({ error: "push disabled" });
  const { deviceId, routeIds } = req.body || {};
  if (!deviceId) return res.status(400).json({ error: "missing deviceId" });
  const routes = Array.isArray(routeIds) ? routeIds.filter(r => typeof r === "string") : [];
  const result = updateSubscriptionRoutes.run({
    deviceId, routeIds: JSON.stringify(routes), now: Date.now(),
  });
  if (result.changes === 0) return res.status(404).json({ error: "not subscribed" });
  res.json({ ok: true, watching: routes.length });
});

app.post("/api/push/test", async (req, res) => {
  if (!PUSH_ENABLED) return res.status(503).json({ error: "push disabled" });
  const { deviceId } = req.body || {};
  if (!deviceId) return res.status(400).json({ error: "missing deviceId" });
  const sub = subscriptionByDevice.get(deviceId);
  if (!sub) return res.status(404).json({ error: "not subscribed on this device" });

  try {
    await webpush.sendNotification(
      { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
      JSON.stringify({
        title: "Test notification",
        body: "If you can read this, push delivery is working.",
        url: "/",
        tag: "test",
      }),
    );
    res.json({ ok: true });
  } catch (err) {
    if (err.statusCode === 404 || err.statusCode === 410) {
      deleteSubscription.run(deviceId);
      return res.status(410).json({ error: "subscription expired; please re-subscribe" });
    }
    res.status(500).json({ error: err.message, statusCode: err.statusCode });
  }
});

app.post("/api/push/unsubscribe", (req, res) => {
  const { deviceId } = req.body || {};
  if (!deviceId) return res.status(400).json({ error: "missing deviceId" });
  deleteSubscription.run(deviceId);
  res.json({ ok: true });
});

app.post("/api/feedback", (req, res) => {
  const { tripId, stopId, scheduledArrival, value, deviceId } = req.body || {};
  if (!tripId || !stopId || !Number.isFinite(scheduledArrival) || !deviceId) {
    return res.status(400).json({ error: "missing fields" });
  }
  if (value !== "showed" && value !== "missed") {
    return res.status(400).json({ error: "value must be 'showed' or 'missed'" });
  }
  upsertFeedback.run({
    tripId, stopId, scheduledArrival, value, deviceId,
    createdAt: Date.now(),
  });
  const tally = tallyFeedback.get({ tripId, stopId, scheduledArrival });
  res.json({ ok: true, showedVotes: tally.showed || 0, missedVotes: tally.missed || 0 });
});

app.get("/api/routes", (_req, res) => {
  // Natural-sort by shortName so "1", "2", "10" come out as 1, 2, 10 (not 1, 10, 2).
  const items = [...routesById.entries()].map(([id, r]) => ({
    routeId: id,
    shortName: r.shortName,
    longName: r.longName,
    type: r.type,
  }));
  items.sort((a, b) => {
    const an = Number(a.shortName), bn = Number(b.shortName);
    const aNum = !Number.isNaN(an), bNum = !Number.isNaN(bn);
    if (aNum && bNum) return an - bn;
    if (aNum) return -1;
    if (bNum) return 1;
    return a.shortName.localeCompare(b.shortName);
  });
  res.json({ items });
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
