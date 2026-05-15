import { useEffect, useMemo, useState } from "react";
import "./App.css";
import RoutePicker from "./RoutePicker";
import { loadSavedRoutes, saveSavedRoutes } from "./savedRoutes";
import { getDeviceId } from "./deviceId";
import { pushSupport, subscribeToPush, unsubscribeFromPush, isSubscribed, updatePushRoutes, sendTestPush } from "./push";

type Delay = {
  tripId: string;
  routeId: string;
  routeShortName: string;
  routeLongName: string;
  nextStopId: string;
  nextStopName: string;
  scheduledArrival: number;
  predictedArrival: number;
  delaySec: number;
  delayMin: number;
  vehicleId: string | null;
  showedVotes: number;
  missedVotes: number;
};

type DelaysResponse = {
  computedAt: number;
  thresholdMin: number;
  items: Delay[];
};

const REFRESH_MS = 30_000;

function formatClock(epochSec: number) {
  return new Date(epochSec * 1000).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
}

function ageString(ms: number) {
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60) return `${s}s ago`;
  return `${Math.floor(s / 60)}m ${s % 60}s ago`;
}

type PatternsResponse = {
  windowDays: number;
  minSnapshotsPerDay: number;
  routes: Record<string, number>;
};

export default function App() {
  const [data, setData] = useState<DelaysResponse | null>(null);
  const [patterns, setPatterns] = useState<PatternsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [, setTick] = useState(0);
  const [savedRoutes, setSavedRoutes] = useState<Set<string>>(() => loadSavedRoutes());
  const [pickerOpen, setPickerOpen] = useState(false);
  const [filterMine, setFilterMine] = useState(() => loadSavedRoutes().size > 0);

  useEffect(() => { saveSavedRoutes(savedRoutes); }, [savedRoutes]);

  // ---- push notification state ----
  const [subscribed, setSubscribed] = useState(false);
  const [pushMsg, setPushMsg] = useState<string | null>(null);
  const push = pushSupport();

  useEffect(() => {
    if (!push.supported) return;
    isSubscribed().then(setSubscribed);
  }, [push.supported]);

  // When the user changes their saved routes AND they're already subscribed,
  // push the new route list to the server so notifications target the right routes.
  useEffect(() => {
    if (subscribed) updatePushRoutes([...savedRoutes]);
  }, [savedRoutes, subscribed]);

  const handleSubscribe = async () => {
    if (savedRoutes.size === 0) {
      setPushMsg("Pick at least one route first — that's what we'll notify you about.");
      setPickerOpen(true);
      return;
    }
    setPushMsg("Requesting permission…");
    const res = await subscribeToPush([...savedRoutes]);
    if (res.ok) {
      setSubscribed(true);
      setPushMsg("You'll get a notification when one of your routes runs late.");
    } else {
      setPushMsg(res.message || "Couldn't enable notifications.");
    }
  };

  const handleUnsubscribe = async () => {
    await unsubscribeFromPush();
    setSubscribed(false);
    setPushMsg("Notifications off.");
  };

  const handleTestPush = async () => {
    setPushMsg("Sending test notification…");
    const res = await sendTestPush();
    setPushMsg(res.ok
      ? "Test sent. Look for the notification — if you don't see one, your OS/browser blocked it."
      : `Test failed: ${res.message}`);
  };

  // Local override of vote tallies so we don't have to wait for the next /api/delays refresh.
  // Key: `${tripId}|${nextStopId}|${scheduledArrival}` -> { showed, missed, myVote }
  const [localVotes, setLocalVotes] = useState<Map<string, { showed: number; missed: number; myVote: "showed" | "missed" | null }>>(new Map());

  const vote = async (d: Delay, value: "showed" | "missed") => {
    const key = `${d.tripId}|${d.nextStopId}|${d.scheduledArrival}`;
    // Optimistic update so the UI feels instant
    setLocalVotes(prev => {
      const next = new Map(prev);
      const existing = next.get(key) || { showed: d.showedVotes, missed: d.missedVotes, myVote: null };
      let { showed, missed } = existing;
      if (existing.myVote === "showed") showed = Math.max(0, showed - 1);
      if (existing.myVote === "missed") missed = Math.max(0, missed - 1);
      if (value === "showed") showed++;
      else missed++;
      next.set(key, { showed, missed, myVote: value });
      return next;
    });
    try {
      const r = await fetch("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tripId: d.tripId,
          stopId: d.nextStopId,
          scheduledArrival: d.scheduledArrival,
          value,
          deviceId: getDeviceId(),
        }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      setLocalVotes(prev => {
        const next = new Map(prev);
        next.set(key, { showed: j.showedVotes, missed: j.missedVotes, myVote: value });
        return next;
      });
    } catch (err) {
      console.error("vote failed", err);
    }
  };

  const votesFor = (d: Delay) => {
    const key = `${d.tripId}|${d.nextStopId}|${d.scheduledArrival}`;
    const local = localVotes.get(key);
    if (local) return local;
    return { showed: d.showedVotes, missed: d.missedVotes, myVote: null as null };
  };

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const [delaysRes, patternsRes] = await Promise.all([
          fetch("/api/delays"),
          fetch("/api/patterns"),
        ]);
        if (!delaysRes.ok) throw new Error(`HTTP ${delaysRes.status}`);
        const j = (await delaysRes.json()) as DelaysResponse;
        if (!cancelled) {
          setData(j);
          setError(null);
        }
        if (patternsRes.ok) {
          const p = (await patternsRes.json()) as PatternsResponse;
          if (!cancelled) setPatterns(p);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    load();
    const id = setInterval(load, REFRESH_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const visibleItems = useMemo(() => {
    if (!data) return [];
    if (filterMine && savedRoutes.size > 0) {
      return data.items.filter(d => savedRoutes.has(d.routeId));
    }
    return data.items;
  }, [data, filterMine, savedRoutes]);

  const grouped = useMemo(() => {
    const byRoute = new Map<string, Delay[]>();
    for (const d of visibleItems) {
      const key = d.routeShortName || d.routeId;
      const arr = byRoute.get(key) || [];
      arr.push(d);
      byRoute.set(key, arr);
    }
    return [...byRoute.entries()]
      .map(([route, delays]) => ({
        route,
        routeId: delays[0].routeId,
        longName: delays[0].routeLongName,
        delays: delays.sort((a, b) => b.delaySec - a.delaySec),
        worstMin: delays[0].delayMin,
      }))
      .sort((a, b) => b.worstMin - a.worstMin);
  }, [visibleItems]);

  const showMineToggle = savedRoutes.size > 0;
  const visible = visibleItems.length;
  const total = data?.items.length ?? 0;

  return (
    <div className="app">
      <header>
        <h1>Austin Transit Tracker</h1>
        <p className="tagline">CapMetro buses & trains running 5+ minutes late, right now</p>
      </header>

      <div className="toolbar">
        <button className="btn" onClick={() => setPickerOpen(true)}>
          {savedRoutes.size === 0 ? "Pick your routes" : `My routes (${savedRoutes.size})`}
        </button>
        {showMineToggle && (
          <label className="toggle">
            <input
              type="checkbox"
              checked={filterMine}
              onChange={e => setFilterMine(e.target.checked)}
            />
            Show only mine
          </label>
        )}
        {push.supported && (
          subscribed ? (
            <>
              <button className="btn btn-ghost" onClick={handleUnsubscribe}>
                🔔 Notifications on
              </button>
              <button className="link-btn" onClick={handleTestPush}>
                Send test
              </button>
            </>
          ) : (
            <button className="btn btn-outline" onClick={handleSubscribe}>
              🔕 Notify me when late
            </button>
          )
        )}
      </div>
      {pushMsg && <div className="push-msg">{pushMsg}</div>}

      <div className="status">
        {loading && <span>Loading…</span>}
        {error && <span className="err">Error: {error}</span>}
        {data && !error && (
          <span>
            {filterMine && showMineToggle
              ? <>{visible} of {total} delayed (your routes) · </>
              : <>{total} delayed {total === 1 ? "trip" : "trips"} · </>}
            updated {ageString(data.computedAt)} · auto-refresh 30s
          </span>
        )}
      </div>

      {data && visible === 0 && !error && (
        <div className="empty">
          {filterMine && showMineToggle ? (
            <>
              <strong>Your routes are on time.</strong>
              <p>None of your saved routes are 5+ minutes behind right now.</p>
            </>
          ) : (
            <>
              <strong>Everything's on time.</strong>
              <p>No CapMetro trips are running 5+ minutes behind schedule right now.</p>
            </>
          )}
        </div>
      )}

      <div className="routes">
        {grouped.map(g => (
          <section key={g.route} className="route-card">
            <div className="route-head">
              <span className="route-badge">{g.route}</span>
              <div className="route-head-info">
                <div className="route-long">{g.longName}</div>
                <div className="route-sub">
                  {g.delays.length} delayed · worst {g.worstMin} min late
                </div>
              </div>
              {patterns && patterns.routes[g.routeId] >= 2 && (
                <span
                  className="pattern-badge"
                  title={`Late on ${patterns.routes[g.routeId]} of the last ${patterns.windowDays} days (≥${patterns.minSnapshotsPerDay} late readings per day)`}
                >
                  late {patterns.routes[g.routeId]}/{patterns.windowDays}d
                </span>
              )}
            </div>
            <ul className="delays">
              {g.delays.map(d => {
                const v = votesFor(d);
                const total = v.showed + v.missed;
                return (
                  <li key={d.tripId}>
                    <span className={`pill ${d.delayMin >= 15 ? "severe" : d.delayMin >= 10 ? "warn" : ""}`}>
                      +{d.delayMin} min
                    </span>
                    <div className="stop-info">
                      <div className="stop-name">→ {d.nextStopName}</div>
                      <div className="stop-times">
                        sched {formatClock(d.scheduledArrival)} · now expected {formatClock(d.predictedArrival)}
                        {d.vehicleId && <> · bus #{d.vehicleId}</>}
                      </div>
                      <div className="vote-row">
                        <button
                          className={`vote-btn ${v.myVote === "showed" ? "on" : ""}`}
                          onClick={() => vote(d, "showed")}
                          aria-pressed={v.myVote === "showed"}
                          title="The bus actually showed up"
                        >
                          👍 Showed
                        </button>
                        <button
                          className={`vote-btn ${v.myVote === "missed" ? "on bad" : ""}`}
                          onClick={() => vote(d, "missed")}
                          aria-pressed={v.myVote === "missed"}
                          title="Bus never came / ghost bus"
                        >
                          👎 No-show
                        </button>
                        {total > 0 && (
                          <span className="vote-tally">
                            {v.showed} showed · {v.missed} no-show
                          </span>
                        )}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </div>

      <footer>
        Data: CapMetro via data.texas.gov · refreshes every 30s · delay = predicted minus scheduled arrival at next stop
      </footer>

      <RoutePicker
        open={pickerOpen}
        selected={savedRoutes}
        onClose={() => setPickerOpen(false)}
        onChange={(next) => {
          setSavedRoutes(next);
          if (next.size === 0) setFilterMine(false);
          else if (!filterMine) setFilterMine(true);
        }}
      />
    </div>
  );
}
