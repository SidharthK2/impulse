// Creator-coin launches through the API: snipe window, the open on the exchange clock, launch reserve, pump.
// Rust server only (the TS server has no launches).

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { type Venue, rustTargets, uid } from "./venue.js";

describe.each(rustTargets())("creator-coin launch ($name)", ({ start }) => {
  let v: Venue;
  beforeAll(async () => {
    v = await start();
  });
  afterAll(() => v?.close());

  const market = async (id: string) => (await v.ok(v.call("GET", `/api/markets/${encodeURIComponent(id)}`))).market;

  it("$100,000 of bids opens at $0.000125 for 800,000,000 tokens, with the rest held as the launch reserve", async () => {
    const s = uid();
    const C = `@c${s}`;
    await v.ok(v.admin("POST", "/api/test/market", { id: C, kind: "attention", source: { kind: "curve" }, feeBps: 0, snipeSeconds: 60 }));
    const a = await v.user(`sa${s}`, "100000");
    const b = await v.user(`sb${s}`, "100000");
    await v.ok(v.as(a, "POST", "/api/snipe", { market: C, usdc: "75000" }));
    await v.ok(v.as(b, "POST", "/api/snipe", { market: C, usdc: "25000" }));
    const before = await market(C);
    expect(before.snipe).toMatchObject({ total: "100000.00", snipers: 2, projectedOpenPrice: "0.000125" });
    expect(before.snipe.top).toEqual([
      { account: a.id, usdc: "75000.00" },
      { account: b.id, usdc: "25000.00" },
    ]);
    expect(before.launch).toBeNull();

    const { effects } = await v.ok(v.admin("POST", "/api/test/advance", { ms: 60_000 }));
    expect(effects).toContain("open");
    const after = await market(C);
    expect(after.snipe).toBeNull();
    expect(after.launch).toMatchObject({ openPrice: "0.000125", sniped: "100000.00", tokensSold: "800000000", reserve: "80000.00" });
    expect(after.mark).toBe("0.000125");
    expect(after.curve).toMatchObject({ usdcIn: "20000.00", tokensSold: "800000000" });
    expect((await v.account(a)).spot).toEqual([expect.objectContaining({ market: C, tokens: "600000000" })]);
    expect((await v.account(b)).spot).toEqual([expect.objectContaining({ market: C, tokens: "200000000" })]);
    expect(await v.invariants()).toEqual([]); // the $80,000 reserve is inside conservation

    const feed = (await v.ok(v.call("GET", `/api/feed?market=${encodeURIComponent(C)}`))) as { kind: string; price: string | null; accounts: string[] }[];
    const open = feed.find((r) => r.kind === "open")!;
    expect(open.price).toBe("0.000125");
    expect(open.accounts.sort()).toEqual([a.id, b.id].sort());
  });

  it("holds bids in the window, rejects trading until the open and bids after it", async () => {
    const s = uid();
    const u = await v.user(`sn${s}`);
    const coin = await v.ok(v.as(u, "POST", "/api/attention", { handle: `w${s}` }));
    const C = coin.id;
    expect(coin.snipe).toMatchObject({ total: "0.00", snipers: 0, recent: [], top: [] });
    expect(coin.snipe.opensAt).toBeGreaterThan(Date.now() - 60_000);
    await v.ok(v.as(u, "POST", "/api/snipe", { market: C, usdc: "1000" }));
    const acct = await v.account(u);
    expect(acct.wallet).toBe("9000.00");
    expect(acct.snipes).toEqual([{ market: C, usdc: "1000.00", time: expect.any(Number) }]);
    const m = await market(C);
    expect(m.snipe.recent).toEqual([{ account: u.id, usdc: "1000.00", time: expect.any(Number) }]);

    const spot = await v.as(u, "POST", "/api/spot/buy", { market: C, usdc: "10" });
    expect(spot.status).toBe(400);
    expect(spot.data.error).toMatch(/snipe window/);
    const perp = await v.order(u, { market: C, side: "buy", type: "market", size: "1000" });
    expect(perp.status).toBe(400);
    expect(perp.data.error).toMatch(/snipe window/);
    expect(await v.invariants()).toEqual([]); // the bid (net of its 1% fee) is held by the launch

    await v.ok(v.admin("POST", "/api/test/advance", { ms: 61_000 }));
    const late = await v.as(u, "POST", "/api/snipe", { market: C, usdc: "10" });
    expect(late.status).toBe(400);
    expect(late.data.error).toMatch(/closed/);
    expect((await v.account(u)).snipes).toEqual([]);
    expect((await market(C)).launch.sniped).toBe("990.00"); // the 1% spot fee applies to snipes
    await v.ok(v.as(u, "POST", "/api/spot/buy", { market: C, usdc: "10" }));
    expect(await v.invariants()).toEqual([]);
  });

  it("lists a demo coin and pumps it from the house account", async () => {
    const coin = await v.ok(v.admin("POST", "/api/admin/demo-coin", {}));
    expect(coin.id).toMatch(/^@demo_/);
    expect(coin.snipe).not.toBeNull();
    expect((await v.admin("POST", "/api/admin/pump", { market: coin.id, usdc: "100" })).status).toBe(400); // not open yet
    await v.ok(v.admin("POST", "/api/test/advance", { ms: 61_000 }));
    const opened = await market(coin.id);
    expect(opened.launch).toMatchObject({ sniped: "0.00", tokensSold: "0", openPrice: "0.000005" });

    const up = await v.ok(v.admin("POST", "/api/admin/pump", { market: coin.id, usdc: "5000" }));
    expect(up.effects).toContain("spot");
    const pumped = await market(coin.id);
    expect(Number(pumped.curve.price)).toBeGreaterThan(0.000019); // spot ∝ x²: $5k into a $5k curve ≈ 4×
    const down = await v.ok(v.admin("POST", "/api/admin/pump", { market: coin.id, usdc: "-2000" }));
    expect(down.effects).toContain("spot");
    expect(Number((await market(coin.id)).curve.price)).toBeLessThan(Number(pumped.curve.price));
    const perp = await v.admin("POST", "/api/admin/pump", { market: "BTC-PERP", usdc: "100" });
    expect(perp.status).toBe(400);
    expect(perp.data.error).toMatch(/admin\/price/);
    expect(await v.invariants()).toEqual([]);
  });

  it("reports every market's settings, flagging the ones Mirror doesn't publish", async () => {
    const coin = await v.ok(v.admin("POST", "/api/admin/demo-coin", { handle: `set${uid()}` }));
    const byLabel = Object.fromEntries((coin.settings as { label: string; value: string; ours: boolean }[]).map((x) => [x.label, x]));
    expect(byLabel["Perp oracle"]).toEqual({ label: "Perp oracle", value: "10-minute TWAP of spot", ours: true });
    expect(byLabel["Spot fee"]).toMatchObject({ value: "1%, also on snipes", ours: true });
    expect(byLabel["Start leverage"]).toMatchObject({ value: "3×" });
    expect(byLabel.ADL).toMatchObject({ value: "pro-rata on profit first, then principal", ours: true });
    expect(byLabel["Snipe window"]).toMatchObject({ value: "60 s" });
  });

  it("streams the new fields on the existing channels: markets, account and feed", async () => {
    const s = uid();
    const u = await v.user(`ws${s}`);
    const coin = await v.ok(v.as(u, "POST", "/api/attention", { handle: `ws${s}` }));
    await v.ok(v.as(u, "POST", "/api/snipe", { market: coin.id, usdc: "50" }));
    const ws = new WebSocket(v.base.replace("http", "ws") + "/ws");
    const got = new Map<string, any>(); // eslint-disable-line @typescript-eslint/no-explicit-any
    await new Promise<void>((resolve, reject) => {
      ws.on("open", () => {
        ws.send(JSON.stringify({ op: "auth", key: u.key }));
        for (const ch of ["markets", "feed", "account"]) ws.send(JSON.stringify({ op: "sub", ch }));
      });
      ws.on("message", (m) => {
        const { ch, data } = JSON.parse(String(m));
        got.set(ch, data);
        if (got.has("markets") && got.has("feed") && got.get("account")?.id === u.id) resolve();
      });
      ws.on("error", reject);
      setTimeout(() => reject(new Error(`timeout; got ${[...got.keys()]}`)), 3000);
    });
    ws.close();
    const m = (got.get("markets") as { id: string }[]).find((x) => x.id === coin.id) as Record<string, unknown>;
    expect(m.snipe).toMatchObject({ total: "50.00", snipers: 1 });
    expect(m).toHaveProperty("launch", null);
    expect(m).toHaveProperty("preipo", null);
    expect(m.settings).toEqual(expect.any(Array));
    expect(got.get("account").snipes).toEqual([{ market: coin.id, usdc: "50.00", time: expect.any(Number) }]);
    expect(got.get("feed")[0]).toHaveProperty("price");
  });
});
