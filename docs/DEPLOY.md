# Deploying to Fly.io

One Fly app runs everything: the Rust server serves the web app, the API and the websocket from the same address,
and keeps its SQLite database on a Fly volume. Files: `Dockerfile`, `.dockerignore`, `fly.toml`,
`.github/workflows/fly-deploy.yml`.

**Rules that keep it correct**
- **One machine, always.** The exchange is one process holding its state in memory, journaled to SQLite on one
  volume. Two machines would be two separate exchanges. Always deploy with `--ha=false`; never `fly scale count 2`.
- **Always on.** `auto_stop_machines = "off"`: the clock, bots and price feeds run inside the server.
- **Set `ADMIN_TOKEN`.** The default `impulse-admin` is public in this repo; anyone could crash markets with it.
- **Never set `TEST_CLOCK`** in production: it turns on the `/api/test/*` hooks.

## First deploy (once, from your terminal)

```bash
brew install flyctl
fly auth login
fly apps create <your-app-name>          # then put that name in fly.toml's `app =`
fly volumes create impulse_data --size 1 --region sin --app <your-app-name>
fly secrets set ADMIN_TOKEN="$(openssl rand -hex 24)" --app <your-app-name>
fly deploy --remote-only --ha=false
```

The app comes up at `https://<your-app-name>.fly.dev`. `--remote-only` builds the image on Fly's builder, so
nothing heavy runs on your machine. Keep the admin token somewhere safe: `fly secrets` won't show it again.

Optional: `fly secrets set OFFLINE=1` (or uncomment it in `fly.toml`) for simulated prices.

## Deploys from GitHub

`.github/workflows/fly-deploy.yml` deploys on every push to `main`, and from the Actions tab by hand.

1. `fly tokens create deploy -x 999999h --app <your-app-name>`
2. GitHub repo → Settings → Secrets and variables → Actions → New secret `FLY_API_TOKEN` with that token.
3. Push `main`.

## Day to day

| Task | Command |
|---|---|
| Logs | `fly logs` |
| Status, health checks | `fly status`, `fly checks list` |
| Shell on the machine | `fly ssh console` |
| Inspect the database | `fly ssh console -C "sqlite3 /data/impulse.db"` (if sqlite3 is installed in the image; otherwise copy it out with `fly ssh sftp get /data/impulse.db`) |
| Restart | `fly machine restart` |
| Back up the volume now | `fly volumes snapshots create <volume-id>` (Fly also snapshots volumes daily) |

## Cost

Pay-as-you-go, no plan: a shared-cpu-1x machine with 512 MB is about $3.69/month, the 1 GB volume about
$0.15/month, plus bandwidth. Fly has no hard spending cap. Check current prices on fly.io/pricing.
