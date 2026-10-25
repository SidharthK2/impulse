import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { createApi } from "../src/api.js";
import { Exchange } from "../src/exchange.js";

const x = new Exchange();
const { server, hub } = createApi(x, { adminToken: "t", bots: null, webDir: null, log: () => {} });
let base = "";

beforeAll(async () => {
  x.createMarket({ id: "X", kind: "perp", source: { kind: "manual" }, price: "100", szDecimals: 2 });
  x.createAccount("maker1");
  x.deposit("maker1", "100000");
  x.placeOrder("maker1", { market: "X", side: "sell", type: "limit", price: "101", size: "50" });
  x.placeOrder("maker1", { market: "X", side: "buy", type: "limit", price: "99", size: "50" });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  hub.close();
  for (const c of hub.clients) c.ws.terminate();
  server.close();
});

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(base + path, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, data: (await res.json()) as Record<string, unknown> & { error?: string } };
}

describe("http api", () => {
  let key = "";
  const auth = () => ({ authorization: `Bearer ${key}` });

  it("signs up with a paper deposit and rejects bad or taken names", async () => {
    const r = await call("POST", "/api/accounts", { name: "trader" });
    expect(r.status).toBe(200);
    key = r.data.apiKey as string;
    expect((await call("POST", "/api/accounts", { name: "Trader" })).status).toBe(409);
    expect((await call("POST", "/api/accounts", { name: "x" })).status).toBe(400);
    const acct = await call("GET", "/api/account", undefined, auth());
    expect(acct.data.wallet).toBe("10000.00");
  });

  it("requires auth to trade and admin token for admin", async () => {
    expect((await call("GET", "/api/account")).status).toBe(401);
    expect((await call("POST", "/api/admin/price", { market: "X", price: "50" })).status).toBe(403);
    expect((await call("GET", "/api/nope")).status).toBe(404);
  });

  it("trades, reports fills in coins and closes", async () => {
    const r = await call("POST", "/api/orders", { market: "X", side: "buy", type: "market", size: "2.5", leverage: 2 }, auth());
    expect(r.status).toBe(200);
    expect(r.data.status).toBe("filled");
    expect((r.data.fills as { price: string; size: string }[])[0]).toMatchObject({ price: "101", size: "2.5" });
    const bad = await call("POST", "/api/orders", { market: "X", side: "buy", type: "limit", price: "100.001", size: "1" }, auth());
    expect(bad.status).toBe(400);
    expect(bad.data.error).toMatch(/tick/);
    const acct = await call("GET", "/api/account", undefined, auth());
    expect((acct.data.positions as { size: string; side: string }[])[0]).toMatchObject({ size: "2.5", side: "long" });
    const close = await call("POST", "/api/positions/close", { market: "X" }, auth());
    expect(close.data.status).toBe("filled");
  });

  it("lets the admin force a gap and lists it in the feed", async () => {
    const r = await call("POST", "/api/admin/price", { market: "X", price: "90", holdSeconds: 0 }, { "x-admin-token": "t" });
    expect(r.status).toBe(200);
    const feed = await call("GET", "/api/feed?market=X");
    expect((feed.data as unknown as { kind: string }[]).some((e) => e.kind === "gap")).toBe(true);
  });

  it("lists attention markets permissionlessly", async () => {
    const r = await call("POST", "/api/attention", { handle: "testcoin", oracleWindow: 0 }, auth());
    expect(r.status).toBe(200);
    expect(r.data.id).toBe("@testcoin");
    expect((await call("POST", "/api/attention", { handle: "testcoin" }, auth())).status).toBe(409);
  });
});

describe("websocket", () => {
  it("streams subscribed channels and the authed account", async () => {
    const key = x.accounts.trader!.apiKey;
    const ws = new WebSocket(base.replace("http", "ws") + "/ws");
    const got = new Map<string, unknown>();
    await new Promise<void>((resolve, reject) => {
      ws.on("open", () => {
        ws.send(JSON.stringify({ op: "auth", key }));
        for (const ch of ["markets", "book:X", "account"]) ws.send(JSON.stringify({ op: "sub", ch }));
      });
      ws.on("message", (m) => {
        const { ch, data } = JSON.parse(String(m));
        got.set(ch, data);
        if (got.has("markets") && got.has("book:X") && (got.get("account") as { id?: string } | null)?.id === "trader") resolve();
      });
      ws.on("error", reject);
      setTimeout(() => reject(new Error(`timeout; got ${[...got.keys()]}`)), 3000);
    });
    expect((got.get("book:X") as { asks: unknown[] }).asks.length).toBeGreaterThan(0);
    ws.close();
  });
});
