# Deploy to Fly.io

Fly is the simplest fit because the app needs (1) HTTPS for web push to work,
(2) a persistent disk for SQLite, and (3) always-on for the background refresh
loop. The included `Dockerfile` and `fly.toml` handle all three.

## One-time setup

1. **Install flyctl** (if you don't have it):
   ```
   brew install flyctl
   ```

2. **Sign in** (uses your browser):
   ```
   fly auth login
   ```

3. **Launch the app.** From the repo root:
   ```
   fly launch --copy-config --no-deploy
   ```
   It will read `fly.toml`, ask you to confirm the app name and region,
   and skip the first deploy so you can set up the volume and secrets first.
   If the name `austin-transit-tracker` is taken, pick a unique one (e.g.
   `transit-atx-<your-handle>`); update the `app =` line in `fly.toml` to match.

4. **Create the persistent volume** for SQLite (1 GB is generous for this data):
   ```
   fly volumes create transit_data --region dfw --size 1
   ```
   The mount path `/data` is already wired in `fly.toml`.

5. **Set VAPID secrets.** Generate fresh keys (don't reuse the dev keys):
   ```
   node -e "import('web-push').then(w => { const k = w.default.generateVAPIDKeys(); console.log('PUB=' + k.publicKey); console.log('PRIV=' + k.privateKey); })"
   ```
   Then on Fly:
   ```
   fly secrets set \
     VAPID_PUBLIC_KEY=... \
     VAPID_PRIVATE_KEY=... \
     VAPID_CONTACT=mailto:you@example.com
   ```

6. **Deploy:**
   ```
   fly deploy
   ```
   First deploy takes ~3-5 minutes (native module compile). Subsequent deploys
   are faster thanks to Docker layer caching.

7. **Open it:**
   ```
   fly open
   ```
   You'll land on `https://<your-app>.fly.dev` with a valid cert — web push
   works from this URL on Chrome/Firefox immediately, and on iOS Safari after
   you "Add to Home Screen" and grant notification permission inside the
   installed PWA.

## Verifying the deploy

```
fly status                    # is the machine running?
fly logs                      # see the GTFS-load + refresh-cycle output
fly ssh console               # poke around in the container
```

Hit `https://<your-app>.fly.dev/api/health` — should return JSON with trip
and route counts. If `lastDelayRefresh` stays at 0, check `fly logs` for the
first delay refresh.

## Updating

```
git push origin main          # if you wire up CI later; for now, just:
fly deploy
```

## Costs

On Fly's `shared-cpu-1x` / 512 MB / 1 GB volume, this app fits in the free
allowance for one machine. `auto_stop_machines = "stop"` lets the machine
sleep when idle, but `min_machines_running = 1` keeps it warm so the
background refresh loop and push fan-out actually run — set this to 0 only
if you don't need notifications to fire when no one's viewing.
