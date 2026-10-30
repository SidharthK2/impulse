// HTTP test targets. Without BASE_URL the tests run against an in-process TS server (with a manual clock) and
// against the Rust server the global setup started; with BASE_URL, against that server only (start it with
// TEST_CLOCK=1 and ADMIN_TOKEN=t, or set ADMIN_TOKEN to match).

import type { AddressInfo } from "node:net";
import { inject } from "vitest";
import { createApi } from "../../reference/server/src/api.js";
import { Exchange } from "../../reference/server/src/exchange.js";

export interface Target {
  name: string;
  start: () => Promise<Venue>;
}

export interface Reply {
  status: number;
  data: any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

export interface User {
  id: string;
  key: string;
}

export class Venue {
  constructor(
    readonly base: string,
    readonly adminToken: string,
    readonly close: () => Promise<void> = async () => {},
  ) {}

  async call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Reply> {
    const res = await fetch(this.base + path, {
      method,
      headers: { "content-type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, data: await res.json() };
  }

  admin(method: string, path: string, body?: unknown) {
    return this.call(method, path, body, { "x-admin-token": this.adminToken });
  }

  as(u: User, method: string, path: string, body?: unknown) {
    return this.call(method, path, body, { authorization: `Bearer ${u.key}` });
  }

  /** The body of a 200, or a thrown error with the server's message. */
  async ok(r: Promise<Reply>) {
    const { status, data } = await r;
    if (status !== 200) throw new Error(`HTTP ${status}: ${data?.error}`);
    return data;
  }

  /** A signed-up account holding `wallet` USD (sign-up pays $10k; the rest is withdrawn or deposited). */
  async user(name: string, wallet = "10000"): Promise<User> {
    const { id, apiKey } = await this.ok(this.call("POST", "/api/accounts", { name }));
    const u = { id, key: apiKey };
    const diff = Number(wallet) - 10_000;
    if (diff < 0) await this.ok(this.as(u, "POST", "/api/withdraw", { amount: String(-diff) }));
    if (diff > 0) await this.ok(this.admin("POST", "/api/admin/deposit", { account: id, amount: String(diff) }));
    return u;
  }

  order(u: User, body: Record<string, unknown>) {
    return this.as(u, "POST", "/api/orders", { type: "limit", ...body });
  }

  account(u: User) {
    return this.ok(this.as(u, "GET", "/api/account"));
  }

  async invariants(): Promise<string[]> {
    return this.ok(this.admin("GET", "/api/test/invariants"));
  }
}

let n = 0;
/** A short name no other test (or earlier run against the same server) has used. */
export const uid = () => `${(Date.now() % 1e6).toString(36)}${(n++).toString(36)}${Math.floor(Math.random() * 36 ** 2).toString(36)}`;

function tsTarget(): Target {
  return {
    name: "ts",
    start: async () => {
      let t = Date.now();
      const x = new Exchange({ now: () => t });
      const { server, hub } = createApi(x, { adminToken: "t", bots: null, webDir: null, log: () => {}, test: { advance: (ms) => (t += ms) } });
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      return new Venue(base, "t", async () => {
        hub.close();
        for (const c of hub.clients) c.ws.terminate();
        server.close();
        server.closeAllConnections();
      });
    },
  };
}

export function targets(): Target[] {
  const remote = inject("remoteBase");
  if (remote) return [{ name: remote, start: async () => new Venue(remote, process.env.ADMIN_TOKEN ?? "t") }];
  const rust = inject("rustBase");
  return [tsTarget(), ...(rust ? [{ name: "rust", start: async () => new Venue(rust, "t") }] : [])];
}

/** Only the Rust server (BASE_URL counts as one): for features the TS server doesn't have. */
export function rustTargets(): Target[] {
  return targets().filter((t) => t.name !== "ts");
}
