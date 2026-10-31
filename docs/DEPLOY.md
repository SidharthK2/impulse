# Deploying to Fly.io

One Fly app runs everything: the Rust server serves the web app, the API and the websocket from the same address,
and keeps its SQLite database on a Fly volume. Files: `Dockerfile`, `.dockerignore`, `fly.toml`,
`.github/workflows/fly-deploy.yml`.

**Rules that keep it correct**
- **One machine, always.** The exchange is one process holding its state in memory, journaled to SQLite on one
  volume. Two machines would be two separate exchanges. Always deploy with `--ha=false`; never `fly scale count 2`.
- **Stops when idle.** `auto_stop_machines = "stop"`: cheapest; bots and prices pause while nobody's connected.
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

`.github/workflows/fly-deploy.yml` deploys **on demand only**: GitHub → Actions → "Deploy to Fly" → Run workflow
(pick the branch, default `main`), or from a terminal: `gh workflow run fly-deploy.yml --repo SidharthK2/impulse`.
Pushes don't deploy.

1. `fly tokens create deploy -x 999999h --app <your-app-name>`
2. GitHub repo → Settings → Secrets and variables → Actions → New secret `FLY_API_TOKEN` with that token.
3. Run the workflow when you want to ship.

## Web app on Cloudflare

The web app is also served from Cloudflare's edge by a Worker with static assets (`web/wrangler.jsonc`,
`web/worker/index.ts`): Cloudflare serves `web/dist` (unknown paths get `index.html`), and the Worker forwards
`/api/*` and `/ws` to `API_ORIGIN` (`https://impulse-sid.fly.dev`) unchanged, websockets included. The browser
sees one origin, so the web app needs no API URL and no CORS. A frontend change ships without restarting the
exchange, and the site still loads while the Fly machine is stopped or deploying.

`.github/workflows/web-deploy.yml` deploys **on every push to main that touches `web/`**, and on demand
(`gh workflow run web-deploy.yml`). It builds the app and runs `wrangler deploy`.

**Setup (once)**
1. Cloudflare dashboard → Add a domain → `sidkap.xyz` (Free plan). Check the imported DNS records against
   Porkbun's, then set the two Cloudflare nameservers at Porkbun. Wait until the domain shows **Active**.
2. Cloudflare → My Profile → API Tokens → Create Token → template **Edit Cloudflare Workers** (account: yours,
   zone: `sidkap.xyz`). Note the account ID from the Workers & Pages overview.
3. `gh secret set CLOUDFLARE_API_TOKEN` and `gh secret set CLOUDFLARE_ACCOUNT_ID` (each prompts for the value).
4. Run the workflow. The site comes up at `https://impulse-web.<your-subdomain>.workers.dev`.
5. Custom domain: in Cloudflare DNS, delete the imported `impulse` CNAME (it points at Fly), then add to
   `web/wrangler.jsonc`: `"routes": [{ "pattern": "impulse.sidkap.xyz", "custom_domain": true }]` and deploy.

To try the Worker locally: `cd web && pnpm run build && npx wrangler@4.151.1 dev --port 8788`. It forwards to
the live API on Fly (`API_ORIGIN`), not to a local server.

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

Sized for the lowest cost: one shared-cpu-1x machine with 256 MB (about $2.19/month if it ran all month) that stops
when nobody is connected, so it bills only while in use; a 1 GB volume (about $0.15/month); shared IPs (free).
While stopped, the clock, bots and prices pause, and the first visit afterwards takes a few seconds to start.
For always-on, set `auto_stop_machines = "off"` and `min_machines_running = 1` in fly.toml. Fly has no hard
spending cap. Check current prices on fly.io/pricing.
