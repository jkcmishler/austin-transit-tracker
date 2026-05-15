import { useEffect, useMemo, useState } from "react";
import "./App.css";

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

export default function App() {
  const [data, setData] = useState<DelaysResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const r = await fetch("/api/delays");
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = (await r.json()) as DelaysResponse;
        if (!cancelled) {
          setData(j);
          setError(null);
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

  const grouped = useMemo(() => {
    if (!data) return [];
    const byRoute = new Map<string, Delay[]>();
    for (const d of data.items) {
      const key = d.routeShortName || d.routeId;
      const arr = byRoute.get(key) || [];
      arr.push(d);
      byRoute.set(key, arr);
    }
    return [...byRoute.entries()]
      .map(([route, delays]) => ({
        route,
        longName: delays[0].routeLongName,
        delays: delays.sort((a, b) => b.delaySec - a.delaySec),
        worstMin: delays[0].delayMin,
      }))
      .sort((a, b) => b.worstMin - a.worstMin);
  }, [data]);

  return (
    <div className="app">
      <header>
        <h1>Austin Transit Tracker</h1>
        <p className="tagline">CapMetro buses & trains running 5+ minutes late, right now</p>
      </header>

      <div className="status">
        {loading && <span>Loading…</span>}
        {error && <span className="err">Error: {error}</span>}
        {data && !error && (
          <span>
            {data.items.length} delayed {data.items.length === 1 ? "trip" : "trips"} ·
            updated {ageString(data.computedAt)} · auto-refresh 30s
          </span>
        )}
      </div>

      {data && data.items.length === 0 && !error && (
        <div className="empty">
          <strong>Everything's on time.</strong>
          <p>No CapMetro trips are running 5+ minutes behind schedule right now.</p>
        </div>
      )}

      <div className="routes">
        {grouped.map(g => (
          <section key={g.route} className="route-card">
            <div className="route-head">
              <span className="route-badge">{g.route}</span>
              <div>
                <div className="route-long">{g.longName}</div>
                <div className="route-sub">
                  {g.delays.length} delayed · worst {g.worstMin} min late
                </div>
              </div>
            </div>
            <ul className="delays">
              {g.delays.map(d => (
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
                  </div>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>

      <footer>
        Data: CapMetro via data.texas.gov · refreshes every 30s · delay = predicted minus scheduled arrival at next stop
      </footer>
    </div>
  );
}
