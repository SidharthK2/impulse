import { useEffect, useState } from "react";
import { api, getAdminToken, setAdminToken } from "../api";
import { useToast } from "../components/ui";
import { num, price, toInput, usd } from "../format";
import { act, useMarkets } from "../queries";
import { useNavigate } from "@tanstack/react-router";
import type { MarketView } from "../types";

// ---------- admin ----------

export function AdminPage() {
  const markets = useMarkets() ?? [];
  const toast = useToast();
  const [token, setToken] = useState(getAdminToken());
  const [status, setStatus] = useState<{ bots: { enabled: boolean; accounts: { id: string; wallet: string }[] } | null } | null>(null);
  const [prices, setPrices] = useState<Record<string, string>>({});
  const [hold, setHold] = useState("120");

  const call = async (path: string, body: Record<string, unknown>, ok: string) => {
    try {
      await act("POST", path, body, { admin: true });
      toast(ok, "up");
      void refresh();
    } catch (e) {
      toast((e as Error).message, "down");
    }
  };
  const refresh = async () => {
    if (!getAdminToken()) return setStatus(null);
    try {
      setStatus(await api("GET", "/api/admin/status", undefined, { admin: true }));
    } catch {
      setStatus(null);
    }
  };
  useEffect(() => {
    void refresh();
  }, [token]);

  const gap = (m: MarketView, factor: number) => {
    const p = num(m.mark) * factor;
    const v = m.kind === "binary" ? Math.min(1, Math.max(0, p)) : p;
    void call("/api/admin/price", { market: m.id, price: toInput(v, 9), holdSeconds: Number(hold) || 0 }, `${m.id} → ${toInput(v, m.priceDecimals)}`);
  };

  return (
    <div className="page">
      <h1>Admin</h1>
      <p className="lead">
        Force oracle gaps, resolve markets, list markets and run the house bots. The server prints its admin token at startup (default <code>impulse-admin</code>).
      </p>
      <div className="row" style={{ maxWidth: 520 }}>
        <input className="input mono" type="password" placeholder="admin token" value={token} onChange={(e) => setToken(e.target.value)} />
        <button
          className="btn"
          onClick={() => {
            setAdminToken(token);
            void refresh();
          }}
        >
          Save
        </button>
        <span className={status ? "up" : "muted"}>{status ? "authorized" : "not authorized"}</span>
      </div>

      <DemoControls markets={markets} />

      <h2>Oracle overrides</h2>
      <p>
        Set a price and hold the feed for{" "}
        <input className="input mono" style={{ width: 70, display: "inline-block" }} value={hold} onChange={(e) => setHold(e.target.value)} /> seconds (0 = the feed takes over on its next poll). When the
        hold ends, the live feed snaps the price back. That's a wick, scenario C.
      </p>
      <div className="panel">
        <table className="grid">
          <thead>
            <tr>
              <th>Market</th>
              <th className="right">Mark</th>
              <th>Set price</th>
              <th>Quick gaps</th>
              <th>Resolve</th>
            </tr>
          </thead>
          <tbody>
            {markets.map((m) => (
              <tr key={m.id}>
                <td style={{ maxWidth: 260, overflow: "hidden", textOverflow: "ellipsis" }}>
                  <b>{m.id}</b> <span className="faint">{m.kind === "binary" ? m.name : ""}</span>
                  {m.status === "resolved" && <span className="badge info"> resolved</span>}
                </td>
                <td className="right mono">{price(m.mark, m.priceDecimals)}</td>
                <td>
                  {m.curve ? (
                    <span className="faint">curve-priced: pump it with spot buys</span>
                  ) : (
                    <div className="row">
                      <input
                        className="input mono"
                        style={{ width: 110 }}
                        value={prices[m.id] ?? ""}
                        placeholder={m.mark ?? ""}
                        onChange={(e) => setPrices({ ...prices, [m.id]: e.target.value.trim() })}
                      />
                      <button className="btn small" disabled={!prices[m.id] || m.status !== "open"} onClick={() => call("/api/admin/price", { market: m.id, price: prices[m.id], holdSeconds: Number(hold) || 0 }, `${m.id} set`)}>
                        Set
                      </button>
                      {m.heldUntil && (
                        <button className="btn small ghost" onClick={() => call("/api/admin/release", { market: m.id }, `${m.id} released to feed`)}>
                          Release
                        </button>
                      )}
                    </div>
                  )}
                </td>
                <td>
                  {!m.curve && m.status === "open" && (
                    <div className="row" style={{ gap: 4 }}>
                      {(m.kind === "binary" ? [0.2, 0.5, 1.5] : [0.7, 0.85, 1.15, 1.4]).map((f) => (
                        <button key={f} className={`btn small ${f < 1 ? "danger" : ""}`} onClick={() => gap(m, f)}>
                          {f < 1 ? `−${Math.round((1 - f) * 100)}%` : `+${Math.round((f - 1) * 100)}%`}
                        </button>
                      ))}
                    </div>
                  )}
                </td>
                <td>
                  {m.resolvable && m.status === "open" && (
                    <div className="row" style={{ gap: 4 }}>
                      <button className="btn small" onClick={() => confirm(`Resolve ${m.id} at 0?`) && call("/api/admin/resolve", { market: m.id, price: "0" }, `${m.id} resolved 0`)}>
                        → 0
                      </button>
                      <button className="btn small" onClick={() => confirm(`Resolve ${m.id} at 1?`) && call("/api/admin/resolve", { market: m.id, price: "1" }, `${m.id} resolved 1`)}>
                        → 1
                      </button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <MirrorMarket onList={(path, body, label) => call(path, body, `listed ${label}`)} />

      <CreateMarket onCreate={(body) => call("/api/admin/market", body, `listed ${String((body as { id: string }).id)}`)} />

      <h2>House bots</h2>
      {status?.bots ? (
        <div className="col">
          <div className="row">
            <span>Bots are {status.bots.enabled ? <b className="up">running</b> : <b className="muted">paused</b>}</span>
            <button className="btn small" onClick={() => call("/api/admin/bots", { enabled: !status.bots!.enabled }, status.bots!.enabled ? "bots paused" : "bots running")}>
              {status.bots.enabled ? "Pause" : "Resume"}
            </button>
          </div>
          <div className="faint">{status.bots.accounts.map((a) => `${a.id} ${usd(a.wallet)}`).join(" · ")}</div>
        </div>
      ) : (
        <p>{status ? "Bots are disabled on this server (BOTS=0)." : "Authorize to see bot status."}</p>
      )}

      <Deposit onDeposit={(account, amount) => call("/api/admin/deposit", { account, amount }, `deposited $${amount} to ${account}`)} />
    </div>
  );
}

function MirrorMarket({ onList }: { onList: (path: string, body: Record<string, unknown>, label: string) => void }) {
  const [pm, setPm] = useState("");
  const [coin, setCoin] = useState("");
  return (
    <>
      <h2>Mirror a live market</h2>
      <p>List any Polymarket market (paste its market URL, slug or id) or any Hyperliquid perp (a coin, or <code>xyz:TSLA</code> for a HIP-3 market). The venue's price becomes the oracle; the order book here is Impulse's own.</p>
      <div className="row" style={{ flexWrap: "wrap", maxWidth: 900 }}>
        <input className="input" style={{ flex: "2 1 300px" }} placeholder="polymarket.com/market/… or id" value={pm} onChange={(e) => setPm(e.target.value.trim())} />
        <button className="btn" disabled={!pm} onClick={() => onList("/api/admin/polymarket", { ref: pm }, pm)}>
          Mirror Polymarket
        </button>
        <input className="input mono" style={{ flex: "1 1 140px" }} placeholder="DOGE or xyz:TSLA" value={coin} onChange={(e) => setCoin(e.target.value.trim())} />
        <button className="btn" disabled={!coin} onClick={() => onList("/api/admin/hyperliquid", { coin }, coin)}>
          Mirror Hyperliquid
        </button>
      </div>
    </>
  );
}

function CreateMarket({ onCreate }: { onCreate: (body: Record<string, unknown>) => void }) {
  const [f, setF] = useState({ id: "", name: "", kind: "binary", price: "0.5", resolvesInMinutes: "30", taperMinutes: "10", adl: "pnl", volBps: "20" });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  return (
    <>
      <h2>List a market</h2>
      <p>
        Binary markets move only when you set the price here, and can resolve on a schedule with a taper. Perps follow a random walk.
      </p>
      <div className="panel panel-body" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10 }}>
        <div className="field">
          <label>Id</label>
          <input className="input" value={f.id} onChange={set("id")} placeholder="ELECTION-24" />
        </div>
        <div className="field">
          <label>Name</label>
          <input className="input" value={f.name} onChange={set("name")} placeholder="Will X happen?" />
        </div>
        <div className="field">
          <label>Kind</label>
          <select className="input" value={f.kind} onChange={set("kind")}>
            <option value="binary">binary</option>
            <option value="perp">perp (random walk)</option>
          </select>
        </div>
        <div className="field">
          <label>Start price</label>
          <input className="input mono" value={f.price} onChange={set("price")} />
        </div>
        {f.kind === "binary" ? (
          <>
            <div className="field">
              <label>Resolves in (min)</label>
              <input className="input mono" value={f.resolvesInMinutes} onChange={set("resolvesInMinutes")} placeholder="blank = whenever" />
            </div>
            <div className="field">
              <label>Taper (min)</label>
              <input className="input mono" value={f.taperMinutes} onChange={set("taperMinutes")} placeholder="0 = none" />
            </div>
          </>
        ) : (
          <div className="field">
            <label>Volatility / step (bps)</label>
            <input className="input mono" value={f.volBps} onChange={set("volBps")} />
          </div>
        )}
        <div className="field">
          <label>ADL rule</label>
          <select className="input" value={f.adl} onChange={set("adl")}>
            <option value="pnl">capped PnL</option>
            <option value="size">size pro-rata</option>
          </select>
        </div>
        <div className="field" style={{ justifyContent: "flex-end" }}>
          <button
            className="btn primary"
            disabled={!f.id || !f.price}
            onClick={() =>
              onCreate({
                id: f.id,
                name: f.name || f.id,
                kind: f.kind,
                price: f.price,
                adl: f.adl,
                ...(f.kind === "binary"
                  ? { ...(num(f.resolvesInMinutes) > 0 && { resolvesInMinutes: num(f.resolvesInMinutes) }), ...(num(f.taperMinutes) > 0 && num(f.resolvesInMinutes) > 0 && { taperMinutes: num(f.taperMinutes) }) }
                  : { szDecimals: 2, volBps: num(f.volBps) }),
              })
            }
          >
            List
          </button>
        </div>
      </div>
    </>
  );
}

function Deposit({ onDeposit }: { onDeposit: (account: string, amount: string) => void }) {
  const [account, setAccount] = useState("");
  const [amount, setAmount] = useState("10000");
  return (
    <>
      <h2>Deposit paper USDC</h2>
      <div className="row" style={{ maxWidth: 520 }}>
        <input className="input" placeholder="account" value={account} onChange={(e) => setAccount(e.target.value.trim())} />
        <input className="input mono" placeholder="amount" value={amount} onChange={(e) => setAmount(e.target.value.trim())} />
        <button className="btn" disabled={!account || !(num(amount) > 0)} onClick={() => onDeposit(account, amount)}>
          Deposit
        </button>
      </div>
    </>
  );
}

type Effects = { title: string; lines: string[]; time: number };

/** The demo in a few clicks: launch a coin, pump or dump it, crash a market, list and IPO a pre-IPO, resolve a binary. */
function DemoControls({ markets }: { markets: MarketView[] }) {
  const toast = useToast();
  const navigate = useNavigate();
  const [last, setLast] = useState<Effects | null>(null);
  const [handle, setHandle] = useState("");
  const coins = markets.filter((m) => m.kind === "attention" && m.status === "open");
  const live = coins.filter((m) => !m.snipe);
  const [coin, setCoin] = useState("");
  const [usdc, setUsdc] = useState("5000");
  const crashable = markets.filter((m) => !m.curve && m.status === "open" && m.mark);
  const [target, setTarget] = useState("");
  const [pre, setPre] = useState({ id: "", name: "", price: "", description: "" });
  const privates = markets.filter((m) => m.preipo?.status === "private");
  const [ipoMarket, setIpoMarket] = useState("");
  const [ipoPrice, setIpoPrice] = useState("");
  const binaries = markets.filter((m) => m.kind === "binary" && m.status === "open");
  const [binary, setBinary] = useState("");

  const pick = (id: string, list: MarketView[]) => (list.some((m) => m.id === id) ? id : (list[0]?.id ?? ""));
  const coinId = pick(coin, live);
  const targetId = pick(target, crashable);
  const ipoId = pick(ipoMarket, privates);
  const binaryId = pick(binary, binaries);

  async function run<T>(title: string, path: string, body: Record<string, unknown>, after?: (r: T) => void) {
    try {
      const r = await act<T>("POST", path, body, { admin: true });
      const effects = (r as { effects?: string[] } | null)?.effects;
      setLast({ title, lines: Array.isArray(effects) ? effects : [], time: Date.now() });
      toast(title, "up");
      after?.(r);
    } catch (e) {
      toast((e as Error).message, "down");
    }
  }

  const crash = (factor: number) => {
    const m = crashable.find((x) => x.id === targetId);
    if (!m) return;
    const p = num(m.mark) * factor;
    const v = m.kind === "binary" ? Math.min(1, Math.max(0, p)) : p;
    void run(`${m.id} → ${toInput(v, m.priceDecimals)}`, "/api/admin/price", { market: m.id, price: toInput(v, 9), holdSeconds: 60 });
  };

  return (
    <>
      <h2>Demo</h2>
      <div className="demo-grid">
        <div className="panel panel-body col">
          <h3>Launch a demo coin</h3>
          <p className="small">Lists a creator coin with a snipe window and a few house snipes.</p>
          <div className="row">
            <input className="input" placeholder="@handle (blank = random)" value={handle} onChange={(e) => setHandle(e.target.value.trim())} />
            <button className="btn primary" onClick={() => run<MarketView>("Demo coin listed", "/api/admin/demo-coin", handle ? { handle } : {}, (m) => m?.id && navigate({ to: "/trade/$market", params: { market: m.id } }))}>
              Launch
            </button>
          </div>
        </div>

        <div className="panel panel-body col">
          <h3>Pump or dump a creator coin</h3>
          <p className="small">A house account buys or sells spot on the curve.</p>
          <div className="row">
            <select className="input" value={coinId} onChange={(e) => setCoin(e.target.value)} disabled={!live.length}>
              {live.length === 0 && <option>no live coins</option>}
              {live.map((m) => (
                <option key={m.id}>{m.id}</option>
              ))}
            </select>
            <div className="adorn" style={{ width: 120 }}>
              <span className="prefix">$</span>
              <input className="input mono" value={usdc} onChange={(e) => setUsdc(e.target.value.trim())} aria-label="USDC" />
            </div>
          </div>
          <div className="row">
            <button className="btn buy grow" disabled={!coinId || !(num(usdc) > 0)} onClick={() => run(`Pumped ${coinId}`, "/api/admin/pump", { market: coinId, usdc })}>
              Pump +${usdc}
            </button>
            <button className="btn sell grow" disabled={!coinId || !(num(usdc) > 0)} onClick={() => run(`Dumped ${coinId}`, "/api/admin/pump", { market: coinId, usdc: `-${usdc}` })}>
              Dump −${usdc}
            </button>
          </div>
        </div>

        <div className="panel panel-body col">
          <h3>Crash a market</h3>
          <p className="small">Forces the oracle and holds it for 60 s. Longs past their bankruptcy price go bust and the shorts pay.</p>
          <select className="input" value={targetId} onChange={(e) => setTarget(e.target.value)}>
            {crashable.map((m) => (
              <option key={m.id} value={m.id}>
                {m.kind === "binary" ? `${m.id} · ${m.name}` : m.id}
              </option>
            ))}
          </select>
          <div className="row">
            {[0.5, 0.7, 1.3, 1.6].map((f) => (
              <button key={f} className={`btn small grow ${f < 1 ? "danger" : ""}`} disabled={!targetId} onClick={() => crash(f)}>
                {f < 1 ? `−${Math.round((1 - f) * 100)}%` : `+${Math.round((f - 1) * 100)}%`}
              </button>
            ))}
          </div>
        </div>

        <div className="panel panel-body col">
          <h3>List a pre-IPO market</h3>
          <div className="row">
            <input className="input mono" placeholder="ID-PRE" value={pre.id} onChange={(e) => setPre({ ...pre, id: e.target.value.trim().toUpperCase() })} />
            <input className="input mono" placeholder="seed price" value={pre.price} onChange={(e) => setPre({ ...pre, price: e.target.value.trim() })} />
          </div>
          <input className="input" placeholder="Company name" value={pre.name} onChange={(e) => setPre({ ...pre, name: e.target.value })} />
          <input className="input" placeholder="Description (optional)" value={pre.description} onChange={(e) => setPre({ ...pre, description: e.target.value })} />
          <button
            className="btn primary"
            disabled={!pre.id || !(num(pre.price) > 0)}
            onClick={() =>
              run<MarketView>(`Listed ${pre.id}`, "/api/admin/preipo", { id: pre.id, name: pre.name || pre.id, price: pre.price, ...(pre.description && { description: pre.description }) }, () => setPre({ id: "", name: "", price: "", description: "" }))
            }
          >
            List pre-IPO
          </button>
        </div>

        <div className="panel panel-body col">
          <h3>IPO a pre-IPO market</h3>
          <p className="small">Reprices it in one step to the IPO price. Whoever is on the wrong side of the gap pays.</p>
          <div className="row">
            <select className="input" value={ipoId} onChange={(e) => setIpoMarket(e.target.value)} disabled={!privates.length}>
              {privates.length === 0 && <option>no private markets</option>}
              {privates.map((m) => (
                <option key={m.id}>{m.id}</option>
              ))}
            </select>
            <input className="input mono" style={{ width: 120 }} placeholder={privates.find((m) => m.id === ipoId)?.mark ?? "price"} value={ipoPrice} onChange={(e) => setIpoPrice(e.target.value.trim())} />
          </div>
          <button className="btn primary" disabled={!ipoId || !(num(ipoPrice) > 0)} onClick={() => run(`${ipoId} IPO at ${ipoPrice}`, "/api/admin/ipo", { market: ipoId, price: ipoPrice }, () => setIpoPrice(""))}>
            IPO
          </button>
        </div>

        <div className="panel panel-body col">
          <h3>Resolve a binary</h3>
          <select className="input" value={binaryId} onChange={(e) => setBinary(e.target.value)} disabled={!binaries.length}>
            {binaries.length === 0 && <option>no open binaries</option>}
            {binaries.map((m) => (
              <option key={m.id} value={m.id}>
                {m.id} · {m.name}
              </option>
            ))}
          </select>
          <div className="row">
            {["0", "1"].map((p) => (
              <button key={p} className="btn grow" disabled={!binaryId} onClick={() => confirm(`Resolve ${binaryId} at ${p}?`) && run(`${binaryId} resolved ${p}`, "/api/admin/resolve", { market: binaryId, price: p })}>
                {p === "1" ? "YES → 1" : "NO → 0"}
              </button>
            ))}
          </div>
        </div>
      </div>
      {last && (
        <div className="note effects">
          <b>{last.title}</b>
          {last.lines.length > 0 ? (
            <ul>
              {last.lines.map((l, i) => (
                <li key={i}>{l}</li>
              ))}
            </ul>
          ) : (
            <span className="muted"> · done</span>
          )}
        </div>
      )}
    </>
  );
}
