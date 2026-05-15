# Austin Transit Tracker

Real-time view of CapMetro buses & trains running 5+ minutes late.

## What it does

- **List view** — every currently-delayed CapMetro trip, grouped by route, worst-first. Auto-refreshes every 30s.
- **Map view** — all ~400 active vehicles plotted on an OpenStreetMap, colored by delay severity (green / orange / amber / red).
- **Saved routes** — pin the routes you care about; "Show only mine" filters the list to them.
- **Saved stops** — pin specific stops; delays approaching one of your stops get a 📍 badge.
- **Push notifications** — get notified when one of your routes is late approaching one of your stops. (Just routes saved? You get every late trip on those routes.)
- **Pattern memory** — "late N of last 7 days" badge appears on routes that have been chronically delayed.
- **Reality check** — 👍/👎 votes per delay so the community can flag ghost buses.
- **Send test** — once subscribed, a one-click test notification confirms your push setup actually works.

## Stack

- **client/** — Vite + React + TypeScript + Leaflet/OSM
- **server/** — Node 24 + Express + SQLite (better-sqlite3) + web-push, fetching data from `data.texas.gov`

## Data sources

| Feed | URL |
|---|---|
| Trip Updates JSON (GTFS-RT 2.0) | `https://data.texas.gov/download/mqtr-wwpy/application%2Foctet-stream` |
| Vehicle Positions JSON | `https://data.texas.gov/download/cuc7-ywmd/application%2Foctet-stream` |
| Static GTFS schedule | `https://data.texas.gov/download/r4v4-vz24/application%2Fzip` |

Trip updates and vehicle positions refresh every 30s; the static schedule reloads every 6h. Delay is computed per-trip as `predicted_arrival − scheduled_arrival` for the next stop the vehicle will hit, with proper America/Chicago timezone handling (DST-aware).

## Run locally

Two terminals:

```bash
cd server && npm run dev
cd client && npm run dev
```

Open http://localhost:5173. Vite proxies `/api/*` to `http://localhost:4000`.

### Web push in dev

For push to work in dev, copy `server/.env.example` to `server/.env` and fill in VAPID keys:

```bash
node -e "import('web-push').then(w => { const k = w.default.generateVAPIDKeys(); console.log('VAPID_PUBLIC_KEY=' + k.publicKey); console.log('VAPID_PRIVATE_KEY=' + k.privateKey); })"
```

Chrome and Firefox treat localhost as a secure origin for the Push API, so it works without HTTPS. iOS Safari does not — you need to deploy.

## Deploy

See **[DEPLOY.md](./DEPLOY.md)** for Fly.io instructions (auto HTTPS, persistent SQLite volume, ~5 min from `fly auth login` to live URL).

## Origin

The app idea came out of a keyword-opportunity scan ([App-Creator repo](https://github.com/jkcmishler/App-Creator)) that flagged "transit delay Austin" as the highest-scoring app niche for Austin (opportunity 67.7). The market gap: CapMetro's official app and Transit make you drill into a stop to discover whether your bus is late. This one is "what's late right now" by default.
