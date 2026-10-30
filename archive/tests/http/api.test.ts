// HTTP and websocket API, run against every target in venue.ts (the TS server and the Rust server).

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { type User, type Venue, targets, uid } from "./venue.js";

describe.each(targets())("api ($name)", ({ start }) => {
  let v: Venue;
  const s = uid();
  const X = `API${s}`;
  let trader: User;

  beforeAll(async () => {
    v = await start();
    await v.ok(v.admin("POST", "/api/test/market", { id: X, kind: "perp", price: "100", szDecimals: 2 }));
    const maker = await v.user(`mk${s}`, "100000");
    await v.ok(v.order(maker, { market: X, side: "sell", price: "101", size: "50" }));
    await v.ok(v.order(maker, { market: X, side: "buy", price: "99", size: "50" }));
  });

  afterAll(() => v?.close());

  describe("http api", () => {
    it("signs up with a paper deposit and rejects bad or taken names", async () => {
      const r = await v.call("POST", "/api/accounts", { name: `tr${s}` });
      expect(r.status).toBe(200);
      trader = { id: r.data.id, key: r.data.apiKey };
      expect((await v.call("POST", "/api/accounts", { name: `TR${s}` })).status).toBe(409);
      expect((await v.call("POST", "/api/accounts", { name: "x" })).status).toBe(400);
      const acct = await v.account(trader);
      expect(acct.wallet).toBe("10000.00");
    });

    it("requires auth to trade and admin token for admin", async () => {
      expect((await v.call("GET", "/api/account")).status).toBe(401);
      expect((await v.call("POST", "/api/admin/price", { market: X, price: "50" })).status).toBe(403);
      expect((await v.call("GET", "/api/nope")).status).toBe(404);
    });

    it("trades, reports fills in coins and closes", async () => {
      const r = await v.order(trader, { market: X, side: "buy", type: "market", size: "2.5", leverage: 2 });
      expect(r.status).toBe(200);
      expect(r.data.status).toBe("filled");
      expect(r.data.fills[0]).toMatchObject({ price: "101", size: "2.5" });
      const bad = await v.order(trader, { market: X, side: "buy", type: "limit", price: "100.001", size: "1" });
      expect(bad.status).toBe(400);
      expect(bad.data.error).toMatch(/tick/);
      const acct = await v.account(trader);
      expect(acct.positions[0]).toMatchObject({ size: "2.5", side: "long" });
      const close = await v.as(trader, "POST", "/api/positions/close", { market: X });
      expect(close.data.status).toBe("filled");
    });

    it("lets the admin force a gap and lists it in the feed", async () => {
      const r = await v.admin("POST", "/api/admin/price", { market: X, price: "90", holdSeconds: 0 });
      expect(r.status).toBe(200);
      const feed = await v.call("GET", `/api/feed?market=${X}`);
      expect((feed.data as { kind: string }[]).some((e) => e.kind === "gap")).toBe(true);
    });

    it("lists attention markets permissionlessly", async () => {
      const r = await v.as(trader, "POST", "/api/attention", { handle: `t${s}`, oracleWindow: 0 });
      expect(r.status).toBe(200);
      expect(r.data.id).toBe(`@t${s}`);
      expect((await v.as(trader, "POST", "/api/attention", { handle: `t${s}` })).status).toBe(409);
    });
  });

  describe("websocket", () => {
    it("streams subscribed channels and the authed account", async () => {
      const ws = new WebSocket(v.base.replace("http", "ws") + "/ws");
      const got = new Map<string, unknown>();
      await new Promise<void>((resolve, reject) => {
        ws.on("open", () => {
          ws.send(JSON.stringify({ op: "auth", key: trader.key }));
          for (const ch of ["markets", `book:${X}`, "account"]) ws.send(JSON.stringify({ op: "sub", ch }));
        });
        ws.on("message", (m) => {
          const { ch, data } = JSON.parse(String(m));
          got.set(ch, data);
          if (got.has("markets") && got.has(`book:${X}`) && (got.get("account") as { id?: string } | null)?.id === trader.id) resolve();
        });
        ws.on("error", reject);
        setTimeout(() => reject(new Error(`timeout; got ${[...got.keys()]}`)), 3000);
      });
      expect((got.get(`book:${X}`) as { asks: unknown[] }).asks.length).toBeGreaterThan(0);
      ws.close();
    });
  });
});
