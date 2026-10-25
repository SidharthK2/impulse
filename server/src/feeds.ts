// Price feeds. Hyperliquid mids for crypto, memecoins and HIP-3 equities; Polymarket midpoints for binary
// outcomes (and their resolution); a seeded random walk when offline. Feeds only ever call exchange.tick, so
// every price change runs liquidation and ADL atomically, and an admin hold makes the feed stand aside.

import type { Exchange, MarketSpec } from "./exchange.js";
import { candlesFromHistory } from "./history.js";
import { nanoFromFeed } from "./units.js";

const HL = "https://api.hyperliquid.xyz/info";
const PM_CLOB = "https://clob.polymarket.com";
const PM_GAMMA = "https://gamma-api.polymarket.com";
const TIMEOUT = 8000;

async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT) });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return (await res.json()) as T;
}

const hl = <T>(body: object) => getJson<T>(HL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

export async function hlMeta(dex?: string): Promise<Map<string, { szDecimals: number; maxLeverage: number }>> {
  const meta = await hl<{ universe: { name: string; szDecimals: number; maxLeverage: number; isDelisted?: boolean }[] }>({ type: "meta", ...(dex && { dex }) });
  return new Map(meta.universe.filter((u) => !u.isDelisted).map((u) => [u.name, u]));
}

export const hlMids = (dex?: string) => hl<Record<string, string>>({ type: "allMids", ...(dex && { dex }) });

export async function hlCandles(coin: string, minutes: number): Promise<{ t: number; o: string; h: string; l: string; c: string }[]> {
  const end = Date.now();
  return hl({ type: "candleSnapshot", req: { coin, interval: "1m", startTime: end - minutes * 60_000, endTime: end } });
}

export interface PmMarket {
  id: string;
  question: string;
  slug: string;
  endDate: string;
  outcomes: string[];
  prices: number[];
  tokens: string[];
  closed: boolean;
  description: string;
}

function parsePm(raw: Record<string, unknown>): PmMarket {
  const arr = (v: unknown) => (typeof v === "string" ? (JSON.parse(v) as string[]) : ((v as string[]) ?? []));
  return {
    id: String(raw.id),
    question: String(raw.question ?? ""),
    slug: String(raw.slug ?? ""),
    endDate: String(raw.endDate ?? ""),
    outcomes: arr(raw.outcomes),
    prices: arr(raw.outcomePrices).map(Number),
    tokens: arr(raw.clobTokenIds),
    closed: raw.closed === true,
    description: String(raw.description ?? ""),
  };
}

/** Liquid, undecided markets that don't end for a while: the ones a leveraged mirror makes sense on. */
export async function pickPolymarkets(n: number): Promise<PmMarket[]> {
  const minEnd = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 19) + "Z";
  const raw = await getJson<Record<string, unknown>[]>(`${PM_GAMMA}/markets?active=true&closed=false&order=volume24hr&ascending=false&limit=60&end_date_min=${minEnd}`);
  return raw
    .map(parsePm)
    .filter((m) => m.tokens.length === 2 && m.prices[0]! >= 0.08 && m.prices[0]! <= 0.92)
    .slice(0, n);
}

export const pmMarket = async (id: string) => parsePm(await getJson<Record<string, unknown>>(`${PM_GAMMA}/markets/${id}`));

export async function pmMidpoints(tokens: string[]): Promise<Record<string, string>> {
  return getJson(`${PM_CLOB}/midpoints`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(tokens.map((token_id) => ({ token_id }))) });
}

export async function pmHistory(token: string): Promise<{ t: number; p: number }[]> {
  const r = await getJson<{ history: { t: number; p: number }[] }>(`${PM_CLOB}/prices-history?market=${token}&interval=1d&fidelity=1`);
  return r.history;
}

// ---------- default listings ----------

const HL_LISTINGS: { coin: string; dex?: string; id: string; name: string; base: string; fallback: string }[] = [
  { coin: "BTC", id: "BTC-PERP", name: "Bitcoin", base: "BTC", fallback: "80000" },
  { coin: "ETH", id: "ETH-PERP", name: "Ether", base: "ETH", fallback: "2400" },
  { coin: "SOL", id: "SOL-PERP", name: "Solana", base: "SOL", fallback: "100" },
  { coin: "HYPE", id: "HYPE-PERP", name: "Hyperliquid", base: "HYPE", fallback: "75" },
  { coin: "kPEPE", id: "kPEPE-PERP", name: "1000 PEPE (memecoin)", base: "kPEPE", fallback: "0.0044" },
  { coin: "FARTCOIN", id: "FARTCOIN-PERP", name: "Fartcoin (memecoin)", base: "FARTCOIN", fallback: "0.13" },
  { coin: "xyz:AAPL", dex: "xyz", id: "AAPL-PERP", name: "Apple (HIP-3 equity perp)", base: "AAPL", fallback: "345" },
];

const ATTENTION = [
  { handle: "@moonboy", description: "Attention token for a fictional degen influencer. Spot trades on Mirror's xy=k curve; the perp's oracle is that spot price (10-minute TWAP)." },
  { handle: "@anon_dev", description: "Attention token with an instant oracle: the perp marks to the curve's spot price with no smoothing, the configuration the pump-attack sweep shows is exploitable." },
];

/** List the default markets on a fresh exchange. Falls back to simulated prices for anything unreachable. */
export async function listDefaults(x: Exchange, log: (s: string) => void, offline: boolean) {
  const specs: MarketSpec[] = [];
  const metas = new Map<string, Awaited<ReturnType<typeof hlMeta>>>();
  const mids = new Map<string, Record<string, string>>();
  for (const dex of [undefined, "xyz"]) {
    if (offline) break;
    try {
      metas.set(dex ?? "", await hlMeta(dex));
      mids.set(dex ?? "", await hlMids(dex));
    } catch (err) {
      log(`hyperliquid${dex ? ` (${dex})` : ""} unreachable, using simulated prices: ${(err as Error).message}`);
    }
  }
  for (const l of HL_LISTINGS) {
    const meta = metas.get(l.dex ?? "")?.get(l.coin);
    const mid = mids.get(l.dex ?? "")?.[l.coin];
    const live = meta !== undefined && mid !== undefined;
    specs.push({
      id: l.id,
      kind: "perp",
      name: l.name,
      base: l.base,
      szDecimals: meta?.szDecimals ?? (Number(l.fallback) > 1000 ? 4 : Number(l.fallback) > 10 ? 2 : 0),
      price: live ? mid : l.fallback,
      source: live ? { kind: "hyperliquid", coin: l.coin, ...(l.dex && { dex: l.dex }) } : { kind: "sim", volBps: 15 },
      description: live
        ? `Mirrors Hyperliquid's ${l.coin} mid price as the oracle. Liquidity comes from Impulse's own order book.`
        : `Simulated price (Hyperliquid was unreachable at listing).`,
      url: live ? `https://app.hyperliquid.xyz/trade/${l.coin}` : undefined,
    });
  }

  let pms: PmMarket[] = [];
  if (!offline) {
    try {
      pms = await pickPolymarkets(4);
    } catch (err) {
      log(`polymarket unreachable, using a simulated binary: ${(err as Error).message}`);
    }
  }
  for (const pm of pms) {
    specs.push({
      id: `PM-${pm.id}`,
      kind: "binary",
      name: pm.question,
      base: pm.outcomes[0] ?? "YES",
      price: (Math.round(pm.prices[0]! * 1000) / 1000).toFixed(3),
      source: { kind: "polymarket", marketId: pm.id, tokenId: pm.tokens[0]!, outcome: pm.outcomes[0] ?? "Yes" },
      description: `Leveraged mirror of a Polymarket outcome: the oracle is Polymarket's midpoint for "${pm.outcomes[0]}", and it settles when Polymarket resolves. Polymarket ends ${pm.endDate.slice(0, 10)}.`,
      url: pm.slug ? `https://polymarket.com/market/${pm.slug}` : undefined,
    });
  }
  if (pms.length === 0) {
    specs.push({ id: "SIM-ELECTION", kind: "binary", name: "Simulated election (binary)", base: "YES", price: "0.5", source: { kind: "sim", volBps: 40 } });
  }

  for (const a of ATTENTION) {
    specs.push({
      id: a.handle,
      kind: "attention",
      name: `${a.handle} attention token`,
      base: a.handle,
      source: { kind: "curve" },
      oracleWindow: a.handle === "@moonboy" ? 600 : 0,
      description: a.description,
    });
  }

  for (const spec of specs) {
    try {
      x.createMarket(spec);
    } catch (err) {
      log(`could not list ${spec.id}: ${(err as Error).message}`);
    }
  }
  // Chart history is cosmetic: fetch it in the background so the server starts listening right away.
  if (!offline) void backfill(x, log);
}

/** Mirror one Polymarket market by URL, slug or numeric id. The perp tracks the first outcome ("Yes"). */
export async function listPolymarket(x: Exchange, ref: string, log: (s: string) => void) {
  const slug = ref.trim().replace(/^https?:\/\/[^/]+\/(event|market)\//, "").split(/[/?#]/)[0]!;
  let pm: PmMarket;
  if (/^\d+$/.test(slug)) pm = await pmMarket(slug);
  else {
    const found = await getJson<Record<string, unknown>[]>(`${PM_GAMMA}/markets?slug=${encodeURIComponent(slug)}`);
    if (!found[0]) throw new Error(`no Polymarket market with slug "${slug}" (event pages hold several markets: use a market's own URL or id)`);
    pm = parsePm(found[0]);
  }
  if (pm.closed) throw new Error(`Polymarket market ${pm.id} is already closed`);
  if (pm.tokens.length !== 2) throw new Error(`Polymarket market ${pm.id} isn't a two-outcome market`);
  const mids = await pmMidpoints([pm.tokens[0]!]);
  const mid = Number(mids[pm.tokens[0]!] ?? pm.prices[0]);
  const meta = x.createMarket({
    id: `PM-${pm.id}`,
    kind: "binary",
    name: pm.question,
    base: pm.outcomes[0] ?? "YES",
    price: (Math.round(mid * 1000) / 1000).toFixed(3),
    source: { kind: "polymarket", marketId: pm.id, tokenId: pm.tokens[0]!, outcome: pm.outcomes[0] ?? "Yes" },
    description: `Leveraged mirror of a Polymarket outcome: the oracle is Polymarket's midpoint for "${pm.outcomes[0]}", and it settles when Polymarket resolves. Polymarket ends ${pm.endDate.slice(0, 10)}.`,
    url: pm.slug ? `https://polymarket.com/market/${pm.slug}` : undefined,
    creator: "admin",
  });
  void backfill(x, log, [meta.id]);
  return meta;
}

/** Mirror one Hyperliquid perp (e.g. "DOGE", or "xyz:TSLA" for a HIP-3 market). */
export async function listHyperliquid(x: Exchange, coin: string, log: (s: string) => void) {
  const dex = coin.includes(":") ? coin.split(":")[0] : undefined;
  const [meta, mids] = await Promise.all([hlMeta(dex), hlMids(dex)]);
  const info = meta.get(coin);
  const mid = mids[coin];
  if (!info || mid === undefined) throw new Error(`Hyperliquid has no live perp "${coin}"`);
  const base = coin.replace(/^.*:/, "");
  const m = x.createMarket({
    id: `${base}-PERP`,
    kind: "perp",
    name: `${base}${dex ? ` (HIP-3, ${dex})` : ""}`,
    base,
    szDecimals: info.szDecimals,
    price: mid,
    source: { kind: "hyperliquid", coin, ...(dex && { dex }) },
    description: `Mirrors Hyperliquid's ${coin} mid price as the oracle. Liquidity comes from Impulse's own order book.`,
    url: `https://app.hyperliquid.xyz/trade/${coin}`,
    creator: "admin",
  });
  void backfill(x, log, [m.id]);
  return m;
}

/** Seed charts with recent real history so they aren't empty on day one. */
async function backfill(x: Exchange, log: (s: string) => void, only?: string[]) {
  for (const meta of Object.values(x.markets)) {
    if (only && !only.includes(meta.id)) continue;
    try {
      if (meta.source.kind === "hyperliquid") {
        const cs = await hlCandles(meta.source.coin, 360);
        candlesFromHistory(x, meta.id, cs.map((c) => ({ t: c.t, o: c.o, h: c.h, l: c.l, c: c.c })));
      } else if (meta.source.kind === "polymarket") {
        const h = await pmHistory(meta.source.tokenId);
        candlesFromHistory(x, meta.id, h.map((p) => ({ t: p.t * 1000, o: String(p.p), h: String(p.p), l: String(p.p), c: String(p.p) })));
      }
    } catch (err) {
      log(`no history for ${meta.id}: ${(err as Error).message}`);
    }
  }
}

// ---------- the runner ----------

export class Feeds {
  private timers: NodeJS.Timeout[] = [];
  private lastError = new Map<string, number>();
  private rng: () => number;

  constructor(
    private x: Exchange,
    private log: (s: string) => void,
    seed = 42,
  ) {
    let s = seed >>> 0;
    this.rng = () => {
      s = (s + 0x6d2b79f5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  start() {
    const every = (ms: number, fn: () => Promise<void> | void) => {
      const run = async () => {
        try {
          await fn();
        } catch (err) {
          this.warn(fn.name || "feed", err);
        }
      };
      this.timers.push(setInterval(run, ms));
      void run();
    };
    every(3000, () => this.pollHyperliquid());
    every(5000, () => this.pollPolymarket());
    every(60_000, () => this.checkResolutions());
    every(2000, () => this.stepSim());
  }

  stop() {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }

  /** One warning per source per minute, so a dead feed doesn't flood the log. */
  private warn(source: string, err: unknown) {
    const last = this.lastError.get(source) ?? 0;
    if (Date.now() - last < 60_000) return;
    this.lastError.set(source, Date.now());
    this.log(`${source}: ${(err as Error).message ?? err}`);
  }

  private open(kind: string) {
    return Object.values(this.x.markets).filter((m) => m.source.kind === kind && this.x.state.markets[m.id]!.status === "open");
  }

  private safeTick(id: string, price: string | number) {
    try {
      this.x.tick(id, nanoFromFeed(price));
    } catch (err) {
      this.warn(`tick ${id}`, err);
    }
  }

  async pollHyperliquid() {
    const markets = this.open("hyperliquid");
    const dexes = new Set(markets.map((m) => (m.source.kind === "hyperliquid" ? (m.source.dex ?? "") : "")));
    for (const dex of dexes) {
      const mids = await hlMids(dex || undefined);
      for (const m of markets) {
        if (m.source.kind !== "hyperliquid" || (m.source.dex ?? "") !== dex) continue;
        const mid = mids[m.source.coin];
        if (mid !== undefined) this.safeTick(m.id, mid);
      }
    }
  }

  async pollPolymarket() {
    const markets = this.open("polymarket");
    if (markets.length === 0) return;
    const tokens = markets.map((m) => (m.source.kind === "polymarket" ? m.source.tokenId : ""));
    const mids = await pmMidpoints(tokens);
    for (const m of markets) {
      if (m.source.kind !== "polymarket") continue;
      const mid = mids[m.source.tokenId];
      if (mid !== undefined) this.safeTick(m.id, mid);
    }
  }

  /** Settle a mirrored binary when Polymarket resolves it (outcome price exactly 0, 0.5 or 1). */
  async checkResolutions() {
    for (const m of this.open("polymarket")) {
      if (m.source.kind !== "polymarket") continue;
      const pm = await pmMarket(m.source.marketId);
      const p = pm.prices[0];
      if (!pm.closed || p === undefined || ![0, 0.5, 1].includes(p)) continue;
      this.x.resolve(m.id, String(p));
      this.log(`${m.id} resolved at ${p} (Polymarket closed)`);
    }
  }

  /** Offline markets: a log-normal walk for perps, a walk in log-odds for binaries. */
  stepSim() {
    for (const m of this.open("sim")) {
      if (m.source.kind !== "sim") continue;
      const mark = this.x.state.markets[m.id]!.mark;
      if (mark === null) continue;
      const cur = (Number(mark) * 10 ** m.szDecimals) / 1e9; // coin price
      const z = Math.sqrt(-2 * Math.log(this.rng() || 1e-9)) * Math.cos(2 * Math.PI * this.rng());
      const step = (m.source.volBps / 10_000) * z;
      let next: number;
      if (m.kind === "binary") {
        const p = Math.min(Math.max(cur, 0.01), 0.99);
        const logit = Math.log(p / (1 - p)) + step * 4;
        next = Math.min(Math.max(1 / (1 + Math.exp(-logit)), 0.01), 0.99);
      } else next = cur * Math.exp(step);
      this.safeTick(m.id, next.toFixed(9));
    }
  }
}
