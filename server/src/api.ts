// HTTP + WebSocket API. Plain node:http and `ws`; every handler runs synchronously against the exchange, so each
// request is one atomic step of the single-threaded core (Mirror's "one monolithic core", in miniature).
//
// Auth: `Authorization: Bearer <apiKey>` (issued at signup) for trading; `x-admin-token` for admin.

import { createReadStream, existsSync, statSync } from "node:fs";
import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import type { Bots } from "./bots.js";
import { checkInvariants } from "../../src/engine.js";
import { Exchange, ExchangeError, type Kind, type MarketSpec, type OrderInput, type Source } from "./exchange.js";
import { listHyperliquid, listPolymarket } from "./feeds.js";
import { deserialize, serialize } from "./persist.js";
import { coinsFromLots, parseFixed, usd } from "./units.js";
import { accountView, bookView, candlesView, configView, fillView, leaderboardView, marketView, orderView, tradesView } from "./views.js";

interface Ctx {
  params: Record<string, string>;
  query: URLSearchParams;
  body: Record<string, unknown>;
  account: string | null;
}

type Auth = "none" | "user" | "admin";
type Handler = (c: Ctx) => unknown;

export interface ApiOptions {
  adminToken: string;
  bots: Bots | null;
  webDir: string | null;
  log: (s: string) => void;
  /** Test hooks under /api/test/*: the exchange's clock must be one only `advance` moves. */
  test?: { advance: (ms: number) => void };
}

const str = (v: unknown, name: string): string => {
  if (typeof v === "string" && v.length > 0) return v;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  throw new ExchangeError(`${name} is required`);
};
const optNum = (v: unknown): number | undefined => (v === undefined || v === null || v === "" ? undefined : Number(v));

export function createApi(x: Exchange, opts: ApiOptions) {
  const routes: { method: string; re: RegExp; auth: Auth; handler: Handler }[] = [];
  const route = (method: string, path: string, auth: Auth, handler: Handler) => {
    const re = new RegExp(`^${path.replace(/:(\w+)/g, (_m, k) => `(?<${k}>[^/]+)`)}$`);
    routes.push({ method, re, auth, handler });
  };

  // ---------- public ----------

  route("GET", "/api/health", "none", () => ({ ok: true, version: x.version, time: x.now(), engineTime: Number(x.state.time) }));
  route("GET", "/api/config", "none", () => configView(x));
  route("GET", "/api/markets", "none", () => Object.keys(x.markets).map((id) => marketView(x, id)));
  route("GET", "/api/markets/:id", "none", (c) => {
    x.market(c.params.id!);
    return { market: marketView(x, c.params.id!), book: bookView(x, c.params.id!), trades: tradesView(x, c.params.id!) };
  });
  route("GET", "/api/markets/:id/candles", "none", (c) => {
    x.market(c.params.id!);
    return candlesView(x, c.params.id!);
  });
  route("GET", "/api/markets/:id/positions", "none", (c) => {
    // The whole market is public, like an on-chain venue: who holds what, and who would absorb a shortfall.
    const meta = x.market(c.params.id!);
    const m = x.state.markets[meta.id]!;
    return Object.values(m.positions)
      .filter((p) => p.size !== 0n)
      .map((p) => ({ account: p.account, size: (p.size < 0n ? "-" : "") + coinsFromLots(meta, p.size < 0n ? -p.size : p.size), collateral: usd(p.collateral), adl: usd(p.adlTransfer) }));
  });
  route("GET", "/api/feed", "none", (c) => {
    const market = c.query.get("market");
    return x.risk.filter((r) => !market || r.market === market).slice(-200).reverse();
  });
  route("GET", "/api/leaderboard", "none", () => leaderboardView(x));

  route("POST", "/api/accounts", "none", (c) => {
    const meta = x.createAccount(str(c.body.name, "name"));
    x.faucet(meta.id);
    opts.log(`new account ${meta.id}`);
    return { id: meta.id, apiKey: meta.apiKey };
  });

  // ---------- trading ----------

  route("GET", "/api/account", "user", (c) => accountView(x, c.account!));
  route("POST", "/api/faucet", "user", (c) => ({ amount: usd(x.faucet(c.account!)) }));
  route("POST", "/api/withdraw", "user", (c) => {
    x.withdraw(c.account!, str(c.body.amount, "amount"));
    return { ok: true };
  });
  route("POST", "/api/orders", "user", (c) => {
    const b = c.body;
    const input: OrderInput = {
      market: str(b.market, "market"),
      side: str(b.side, "side") as OrderInput["side"],
      type: str(b.type ?? "limit", "type") as OrderInput["type"],
      size: str(b.size, "size"),
      ...(b.price !== undefined && b.price !== "" && { price: str(b.price, "price") }),
      ...(optNum(b.leverage) !== undefined && { leverage: optNum(b.leverage) }),
      ...(b.reduceOnly !== undefined && { reduceOnly: !!b.reduceOnly }),
      ...(b.tif !== undefined && { tif: str(b.tif, "tif") as OrderInput["tif"] }),
      ...(optNum(b.slippage) !== undefined && { slippage: optNum(b.slippage) }),
    };
    const r = x.placeOrder(c.account!, input);
    return { status: r.status, reason: r.reason, order: orderView(x, r.order), fills: r.fills.map((f) => fillView(x, f, c.account!)) };
  });
  route("DELETE", "/api/orders/:id", "user", (c) => {
    x.cancel(c.account!, Number(c.params.id));
    return { ok: true };
  });
  route("POST", "/api/orders/cancel-all", "user", (c) => ({ cancelled: x.cancelAll(c.account!, typeof c.body.market === "string" ? c.body.market : undefined) }));
  route("POST", "/api/positions/close", "user", (c) => {
    const market = str(c.body.market, "market");
    const meta = x.market(market);
    const size = x.state.markets[market]!.positions[c.account!]?.size ?? 0n;
    if (size === 0n) throw new ExchangeError(`no open position in ${market}`);
    const r = x.placeOrder(c.account!, { market, side: size > 0n ? "sell" : "buy", type: "market", size: coinsFromLots(meta, size < 0n ? -size : size), reduceOnly: true, slippage: optNum(c.body.slippage) ?? 0.1 });
    return { status: r.status, reason: r.reason, fills: r.fills.map((f) => fillView(x, f, c.account!)) };
  });
  route("POST", "/api/margin", "user", (c) => {
    x.adjustMargin(c.account!, str(c.body.market, "market"), str(c.body.amount, "amount"));
    return { ok: true };
  });
  route("POST", "/api/spot/buy", "user", (c) => {
    x.spotBuy(c.account!, str(c.body.market, "market"), str(c.body.usdc, "usdc"));
    return { ok: true };
  });
  route("POST", "/api/spot/sell", "user", (c) => {
    x.spotSell(c.account!, str(c.body.market, "market"), str(c.body.tokens, "tokens"));
    return { ok: true };
  });
  // Permissionless listing, Mirror's pitch: anyone can launch an attention market for a handle.
  route("POST", "/api/attention", "user", (c) => {
    const handle = str(c.body.handle, "handle").replace(/^@?/, "@");
    if (!/^@[A-Za-z0-9_]{2,20}$/.test(handle)) throw new ExchangeError("handle must be 2–20 letters, digits or _");
    const window = optNum(c.body.oracleWindow) ?? 600;
    if (![0, 60, 600, 3600].includes(window)) throw new ExchangeError("oracleWindow must be 0, 60, 600 or 3600 seconds");
    const adl = c.body.adl === "size" ? "size" : "pnl";
    const meta = x.createMarket({
      id: handle,
      kind: "attention",
      name: `${handle} attention token`,
      base: handle,
      source: { kind: "curve" },
      oracleWindow: window,
      adl,
      creator: c.account!,
      description: `Listed by ${c.account}. Spot trades on an xy=k curve ($5k virtual USDC, 1B tokens); the perp's oracle is ${window === 0 ? "the instant spot price" : `a ${window / 60}-minute TWAP of the spot price`}.`,
    });
    return marketView(x, meta.id);
  });

  // ---------- admin ----------

  route("POST", "/api/admin/price", "admin", (c) => {
    const effects = x.adminPrice(str(c.body.market, "market"), str(c.body.price, "price"), optNum(c.body.holdSeconds) ?? 60);
    return { effects: effects.map((e) => e.kind) };
  });
  route("POST", "/api/admin/release", "admin", (c) => {
    x.releaseHold(str(c.body.market, "market"));
    return { ok: true };
  });
  route("POST", "/api/admin/resolve", "admin", (c) => {
    x.resolve(str(c.body.market, "market"), str(c.body.price, "price"));
    return { ok: true };
  });
  route("POST", "/api/admin/market", "admin", (c) => {
    const b = c.body as Partial<Omit<MarketSpec, "source">> & { resolvesInMinutes?: number; taperMinutes?: number };
    const spec: MarketSpec = {
      id: str(b.id, "id"),
      kind: (b.kind ?? "binary") as MarketSpec["kind"],
      name: b.name ?? b.id,
      source: { kind: "manual" },
      price: str(b.price, "price"),
      ...(b.base && { base: b.base }),
      ...(b.szDecimals !== undefined && { szDecimals: Number(b.szDecimals) }),
      ...(b.adl && { adl: b.adl }),
      ...(b.description && { description: b.description }),
      ...(b.resolvesInMinutes && { resolvesAtMs: x.now() + Number(b.resolvesInMinutes) * 60_000 }),
      ...(b.taperMinutes && { taperSeconds: Math.round(Number(b.taperMinutes) * 60) }),
      ...(b.initialLeverage && { initialLeverage: Number(b.initialLeverage) }),
      ...(b.maintenanceLeverage && { maintenanceLeverage: Number(b.maintenanceLeverage) }),
      creator: "admin",
    };
    // Admin perps get a random-walk oracle so they move on their own; admin binaries move only when told to.
    if (spec.kind === "perp") spec.source = { kind: "sim", volBps: Number((c.body as { volBps?: unknown }).volBps ?? 20) || 20 };
    return marketView(x, x.createMarket(spec).id);
  });
  // Listing from live venues is async (it fetches the venue's metadata), so these handlers return promises.
  route("POST", "/api/admin/polymarket", "admin", async (c) => {
    try {
      return marketView(x, (await listPolymarket(x, str(c.body.ref, "ref"), opts.log)).id);
    } catch (err) {
      throw err instanceof ExchangeError ? err : new ExchangeError((err as Error).message);
    }
  });
  route("POST", "/api/admin/hyperliquid", "admin", async (c) => {
    try {
      return marketView(x, (await listHyperliquid(x, str(c.body.coin, "coin"), opts.log)).id);
    } catch (err) {
      throw err instanceof ExchangeError ? err : new ExchangeError((err as Error).message);
    }
  });
  route("POST", "/api/admin/deposit", "admin", (c) => {
    x.deposit(str(c.body.account, "account"), str(c.body.amount, "amount"));
    return { ok: true };
  });
  route("POST", "/api/admin/bots", "admin", (c) => {
    if (!opts.bots) throw new ExchangeError("bots are not running (BOTS=0)");
    opts.bots.enabled = !!c.body.enabled;
    if (!opts.bots.enabled) for (const { id } of opts.bots.summary()) if (x.accounts[id]) x.cancelAll(id);
    return { enabled: opts.bots.enabled };
  });
  route("GET", "/api/admin/status", "admin", () => ({ bots: opts.bots ? { enabled: opts.bots.enabled, accounts: opts.bots.summary() } : null }));

  // ---------- test hooks (the Rust server has the same ones under TEST_CLOCK=1) ----------

  const test = opts.test;
  if (test) {
    route("POST", "/api/test/advance", "admin", (c) => {
      test.advance(optNum(c.body.ms) ?? 0);
      return { effects: x.clock().map((e) => e.kind), now: x.now() };
    });
    route("POST", "/api/test/market", "admin", (c) => {
      const b = c.body;
      const spec: MarketSpec = {
        id: str(b.id, "id"),
        kind: str(b.kind, "kind") as Kind,
        source: (b.source as Source | undefined) ?? { kind: "manual" },
        ...(b.price !== undefined && { price: str(b.price, "price") }),
        ...(optNum(b.szDecimals) !== undefined && { szDecimals: optNum(b.szDecimals) }),
        ...(optNum(b.oracleWindow) !== undefined && { oracleWindow: optNum(b.oracleWindow) }),
        ...(optNum(b.feeBps) !== undefined && { feeBps: optNum(b.feeBps) }),
        ...(typeof b.adl === "string" && { adl: b.adl as "size" | "pnl" }),
      };
      return marketView(x, x.createMarket(spec).id);
    });
    route("POST", "/api/test/tick", "admin", (c) => {
      const effects = x.tick(str(c.body.market, "market"), parseFixed(str(c.body.price, "price")));
      return { effects: effects === null ? null : effects.map((e) => e.kind) };
    });
    route("GET", "/api/test/invariants", "admin", () => checkInvariants(x.state));
    // Round-trip the whole exchange through a snapshot in place, then treat `downMs` as downtime.
    route("POST", "/api/test/reload", "admin", (c) => {
      const before = serialize(x.toSnapshot());
      const y = Exchange.fromSnapshot(deserialize(before), { now: x.now });
      const identical = serialize(y.toSnapshot()) === before;
      Object.assign(x, y, { version: x.version + 1 });
      const down = optNum(c.body.downMs) ?? 0;
      test.advance(down);
      x.resumeAfter(down);
      return { identical, effects: x.clock().map((e) => e.kind) };
    });
  }

  // ---------- plumbing ----------

  async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
    if (req.method === "GET" || req.method === "HEAD") return {};
    let size = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > 64 * 1024) throw new ExchangeError("body too large", 413);
      chunks.push(chunk as Buffer);
    }
    if (size === 0) return {};
    try {
      const v = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      return v && typeof v === "object" ? v : {};
    } catch {
      throw new ExchangeError("body must be JSON");
    }
  }

  const send = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json", "access-control-allow-origin": "*" });
    res.end(JSON.stringify(body));
  };

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", "http://local");
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET,POST,DELETE,OPTIONS",
        "access-control-allow-headers": "content-type,authorization,x-admin-token",
      });
      return res.end();
    }
    if (!url.pathname.startsWith("/api/")) {
      try {
        return serveStatic(url.pathname, res);
      } catch {
        res.writeHead(400);
        return res.end();
      }
    }
    try {
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const match = r.re.exec(url.pathname);
        if (!match) continue;
        const params = Object.fromEntries(Object.entries(match.groups ?? {}).map(([k, v]) => [k, decodeURIComponent(v)]));
        let account: string | null = null;
        if (r.auth === "user") {
          const key = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1];
          account = key ? (x.accountByKey(key)?.id ?? null) : null;
          if (!account) throw new ExchangeError("sign in first (missing or unknown API key)", 401);
        }
        if (r.auth === "admin" && req.headers["x-admin-token"] !== opts.adminToken) throw new ExchangeError("admin token required", 403);
        const body = await readBody(req);
        return send(res, 200, await r.handler({ params, query: url.searchParams, body, account }));
      }
      throw new ExchangeError(`no route ${req.method} ${url.pathname}`, 404);
    } catch (err) {
      if (err instanceof ExchangeError) return send(res, err.status, { error: err.message });
      opts.log(`500 on ${req.method} ${url.pathname}: ${(err as Error).stack ?? err}`);
      return send(res, 500, { error: (err as Error).message });
    }
  }

  const TYPES: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript",
    ".css": "text/css",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
    ".json": "application/json",
    ".woff2": "font/woff2",
  };

  function serveStatic(pathname: string, res: ServerResponse) {
    if (!opts.webDir || !existsSync(opts.webDir)) {
      res.writeHead(200, { "content-type": "text/plain" });
      return res.end("Impulse API is running. The web app isn't built: run `pnpm --filter impulse-web dev` (or `pnpm web:build`).");
    }
    const root = resolve(opts.webDir);
    let file = resolve(join(root, normalize(decodeURIComponent(pathname))));
    if (file !== root && !file.startsWith(root + sep)) {
      res.writeHead(403);
      return res.end();
    }
    if (!existsSync(file) || statSync(file).isDirectory()) file = join(root, "index.html"); // SPA fallback
    res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
    createReadStream(file).pipe(res);
  }

  const server = createServer((req, res) => void handle(req, res));
  const hub = createHub(x);
  server.on("upgrade", (req, socket, head) => {
    if (new URL(req.url ?? "/", "http://local").pathname !== "/ws") return socket.destroy();
    hub.wss.handleUpgrade(req, socket, head, (ws) => hub.wss.emit("connection", ws, req));
  });
  return { server, hub };
}

// ---------- websocket hub ----------

interface Client {
  ws: WebSocket;
  subs: Set<string>;
  account: string | null;
  sent: Map<string, string>;
}

/**
 * Channels: markets, feed, leaderboard, book:<id>, trades:<id>, candles:<id>, account (after {op:"auth"}).
 * Every 500 ms, if the exchange changed, each client gets the channels whose payload changed since last send.
 */
export function createHub(x: Exchange) {
  const wss = new WebSocketServer({ noServer: true });
  const clients = new Set<Client>();
  let lastVersion = -1;

  wss.on("connection", (ws) => {
    const c: Client = { ws, subs: new Set(), account: null, sent: new Map() };
    clients.add(c);
    ws.on("message", (raw) => {
      let msg: { op?: string; ch?: string; key?: string };
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (msg.op === "sub" && typeof msg.ch === "string") {
        c.subs.add(msg.ch);
        push(c, msg.ch, new Map());
      } else if (msg.op === "unsub" && typeof msg.ch === "string") {
        c.subs.delete(msg.ch);
        c.sent.delete(msg.ch);
      } else if (msg.op === "auth") {
        c.account = (msg.key && x.accountByKey(msg.key)?.id) || null;
        c.sent.delete("account");
        ws.send(JSON.stringify({ ch: "auth", data: { account: c.account } }));
        if (c.subs.has("account")) push(c, "account", new Map());
      }
    });
    ws.on("close", () => clients.delete(c));
    ws.on("error", () => clients.delete(c));
  });

  function payload(ch: string, c: Client): unknown {
    if (ch === "markets") return Object.keys(x.markets).map((id) => marketView(x, id));
    if (ch === "feed") return x.risk.slice(-60).reverse();
    if (ch === "leaderboard") return leaderboardView(x);
    if (ch === "account") return c.account ? accountView(x, c.account) : null;
    const [kind, id] = ch.split(/:(.*)/s);
    if (!id || !x.markets[id]) return undefined;
    if (kind === "book") return bookView(x, id);
    if (kind === "trades") return tradesView(x, id, 40);
    if (kind === "candles") return candlesView(x, id).slice(-2);
    return undefined;
  }

  /** Send one channel if its payload changed. `cache` shares payloads across clients within a tick. */
  function push(c: Client, ch: string, cache: Map<string, string>) {
    if (c.ws.readyState !== WebSocket.OPEN || c.ws.bufferedAmount > 1_000_000) return;
    const key = ch === "account" ? `account:${c.account}` : ch;
    let text = cache.get(key);
    if (text === undefined) {
      const data = payload(ch, c);
      if (data === undefined) return;
      text = JSON.stringify({ ch, data });
      cache.set(key, text);
    }
    if (c.sent.get(ch) === text) return;
    c.sent.set(ch, text);
    c.ws.send(text);
  }

  const timer = setInterval(() => {
    if (x.version === lastVersion) return;
    lastVersion = x.version;
    const cache = new Map<string, string>();
    try {
      for (const c of clients) for (const ch of c.subs) push(c, ch, cache);
    } catch (err) {
      console.error("websocket push failed:", (err as Error).stack ?? err);
    }
  }, 500);

  return { wss, close: () => clearInterval(timer), clients };
}
