# Austin Transit Tracker

Real-time view of CapMetro buses & trains running 5+ minutes late.

## Stack
- **client/** — Vite + React + TypeScript
- **server/** — Node/Express proxy that fetches GTFS-RT trip updates from data.texas.gov and joins them against the static GTFS schedule to compute per-trip delays

## Run locally

In two terminals:

```bash
cd server && npm run dev
cd client && npm run dev
```

Open http://localhost:5173 — the Vite dev server proxies `/api/*` to `http://localhost:4000`.

## Data sources

- Trip Updates JSON: `https://data.texas.gov/download/mqtr-wwpy/application%2Foctet-stream`
- Static GTFS zip:   `https://data.texas.gov/download/r4v4-vz24/application%2Fzip`

Server refreshes trip updates every 30s and the static schedule every 6h.

## Why this app
Generic transit apps (Transit, Google Maps) bury delays inside a full schedule view. This one is "what's actually late right now," grouped by route, with the worst delays first.
