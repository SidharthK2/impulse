// Impulse paper exchange: MicroPerps with ADL as the only backstop, live.
//
//   PORT=8787  DATA_DIR=server/data  ADMIN_TOKEN=impulse-admin  OFFLINE=1 (no network feeds)  BOTS=0 (no house bots)

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createApi } from "./api.js";
import { Bots } from "./bots.js";
import { Exchange } from "./exchange.js";
import { Feeds, listDefaults } from "./feeds.js";
import { loadSnapshot, saveSnapshot } from "./persist.js";

const here = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 8787);
const DATA_DIR = process.env.DATA_DIR ?? join(here, "../data");
const WEB_DIR = process.env.WEB_DIR ?? join(here, "../../web/dist");
const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? "impulse-admin";
const OFFLINE = process.env.OFFLINE === "1";
const BOTS = process.env.BOTS !== "0";

const log = (s: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${s}`);

const snap = loadSnapshot(DATA_DIR);
const x = snap ? Exchange.fromSnapshot(snap) : new Exchange();
if (snap) {
  const down = snap.savedAt ? Date.now() - snap.savedAt : 0;
  x.resumeAfter(down);
  log(`restored snapshot: ${Object.keys(x.markets).length} markets, ${Object.keys(x.accounts).length} accounts, engine t=${x.state.time}s; paused for ${Math.round(down / 1000)}s of downtime`);
} else {
  log(`fresh exchange; listing default markets${OFFLINE ? " (offline)" : ""}…`);
  await listDefaults(x, log, OFFLINE);
  log(`listed ${Object.keys(x.markets).join(", ")}`);
}

x.clock();

const bots = BOTS ? new Bots(x, log) : null;
bots?.ensureAccounts();
bots?.start();

const feeds = new Feeds(x, log);
if (!OFFLINE) feeds.start();
else setInterval(() => feeds.stepSim(), 2000);

const clock = setInterval(() => {
  try {
    x.clock();
  } catch (err) {
    log(`clock: ${(err as Error).stack ?? err}`);
  }
}, 2000);

let savedVersion = -1;
function save() {
  if (x.version === savedVersion) return;
  try {
    saveSnapshot(DATA_DIR, x.toSnapshot());
    savedVersion = x.version;
  } catch (err) {
    log(`snapshot failed: ${(err as Error).message}`);
  }
}
const saver = setInterval(save, 15_000);

const { server, hub } = createApi(x, { adminToken: ADMIN_TOKEN, bots, webDir: WEB_DIR, log });
server.listen(PORT, () => {
  log(`Impulse listening on http://localhost:${PORT}  (admin token: ${ADMIN_TOKEN === "impulse-admin" ? "impulse-admin, the default" : "from ADMIN_TOKEN"})`);
});

function shutdown() {
  log("shutting down, saving snapshot");
  clearInterval(clock);
  clearInterval(saver);
  feeds.stop();
  bots?.stop();
  hub.close();
  save();
  server.close();
  process.exit(0);
}
// Last-resort net: every engine transition is clone-then-commit, so a thrown error can't leave half-applied state.
process.on("unhandledRejection", (err) => log(`unhandled rejection: ${(err as Error)?.stack ?? err}`));
process.on("uncaughtException", (err) => log(`uncaught exception: ${err.stack ?? err}`));
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
