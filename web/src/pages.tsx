import { useEffect, useMemo, useState } from "react";
import { api, getAdminToken, setAdminToken } from "./api";
import { RiskList } from "./components/RiskFeed";
import { useToast } from "./components/ui";
import { num, price, toInput, tone, usd } from "./format";
import { useChannel } from "./hooks";
import type { LeaderRow, MarketView, RiskEvent, RiskKind } from "./types";

// ---------- risk feed ----------

const KINDS: RiskKind[] = ["bankrupt", "haircut", "liquidation", "adl", "settlement", "graduation", "gap", "listing"];

export function FeedPage() {
  const [history, setHistory] = useState<RiskEvent[]>([]);
  const live = useChannel<RiskEvent[]>("feed") ?? [];
  const [kinds, setKinds] = useState<Set<RiskKind>>(new Set(KINDS));
  const [market, setMarket] = useState("");
  useEffect(() => {
    api<RiskEvent[]>("GET", "/api/feed").then(setHistory).catch(() => {});
  }, []);
  const all = useMemo(() => {
    const seen = new Set<number>();
    return [...live, ...history].filter((e) => !seen.has(e.id) && (seen.add(e.id), true)).sort((a, b) => b.id - a.id);
  }, [live, history]);
  const shown = all.filter((e) => kinds.has(e.kind) && (!market || e.market === market));
  const sum = (k: RiskKind) => all.filter((e) => e.kind === k).reduce((s, e) => s + num(e.amount ?? "0"), 0);
  const count = (k: RiskKind) => all.filter((e) => e.kind === k).length;
  const markets = [...new Set(all.map((e) => e.market))].sort();
  return (
    <div className="page">
      <h1>Risk feed</h1>
      <p className="lead">
        There's no insurance fund. When a position's equity goes negative, the shortfall is charged to the traders on the other side (ADL), inside the same transaction. This is every
        liquidation, bankruptcy and haircut, so you can see who paid.
      </p>
      <div className="cards">
        <div className="card">
          <span className="label">Bankruptcies</span>
          <span className="v">{count("bankrupt")}</span>
        </div>
        <div className="card">
          <span className="label">Shortfall socialized</span>
          <span className="v down">{usd(sum("bankrupt"))}</span>
        </div>
        <div className="card">
          <span className="label">Haircuts charged</span>
          <span className="v">{count("haircut")}</span>
        </div>
        <div className="card">
          <span className="label">Liquidations (equity ≥ 0)</span>
          <span className="v">{count("liquidation")}</span>
        </div>
        <div className="card">
          <span className="label">Forced ADL closes</span>
          <span className="v">{count("adl")}</span>
        </div>
      </div>
      <div className="row" style={{ flexWrap: "wrap", marginBottom: 10 }}>
        {KINDS.map((k) => (
          <label key={k} className="check">
            <input
              type="checkbox"
              checked={kinds.has(k)}
              onChange={(e) => {
                const n = new Set(kinds);
                if (e.target.checked) n.add(k);
                else n.delete(k);
                setKinds(n);
              }}
            />
            {k === "adl" ? "ADL close" : k}
          </label>
        ))}
        <span className="spacer" />
        <select className="input" style={{ width: 220 }} value={market} onChange={(e) => setMarket(e.target.value)}>
          <option value="">All markets</option>
          {markets.map((m) => (
            <option key={m}>{m}</option>
          ))}
        </select>
      </div>
      <div className="panel">
        <RiskList events={shown} />
      </div>
    </div>
  );
}

// ---------- leaderboard ----------

export function LeaderboardPage({ me }: { me?: string }) {
  const rows = useChannel<LeaderRow[]>("leaderboard") ?? [];
  return (
    <div className="page">
      <h1>Leaderboard</h1>
      <p className="lead">Total PnL since sign-up, marked to the oracle. The haircuts column is how much of each account's profit (or principal) went to cover other people's bankruptcies.</p>
      <div className="panel">
        <table className="grid">
          <thead>
            <tr>
              <th>#</th>
              <th>Account</th>
              <th className="right">Equity</th>
              <th className="right">PnL</th>
              <th className="right">ADL haircuts paid</th>
              <th className="right">Open positions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.id} style={r.id === me ? { background: "var(--panel-2)" } : undefined}>
                <td className="muted">{i + 1}</td>
                <td>
                  {r.id} {r.bot && <span className="badge">bot</span>} {r.id === me && <span className="badge up">you</span>}
                </td>
                <td className="right mono">{usd(r.equity)}</td>
                <td className={`right mono ${tone(num(r.pnl))}`}>{usd(r.pnl, { sign: true })}</td>
                <td className="right mono">{num(r.haircuts) > 0 ? <span className="down">{usd(r.haircuts)}</span> : "—"}</td>
                <td className="right mono">{r.open}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 && <div className="empty">Loading…</div>}
      </div>
    </div>
  );
}

// ---------- how it works ----------

export function AboutPage() {
  return (
    <div className="page prose">
      <h1>How Impulse works</h1>
      <p className="lead">
        A paper-trading <strong>MicroPerps</strong> exchange, modelled on the design Mirror describes: leveraged perps on any asset, with <strong>auto-deleveraging as the only backstop</strong>. There's no
        insurance fund and no house vault. Everything here is play money.
      </p>

      <h2>One atomic core</h2>
      <p>
        Every action is a single transition of a deterministic risk engine (integer nano-USD, no floats): a fill, an oracle tick, a curve trade, or a clock step. Each transition runs liquidation
        and ADL inside itself, then checks the invariants before it commits: exposure balanced, money conserved, no negative equity. So the venue is <strong>solvent after every transition</strong>,
        by construction.
      </p>

      <h2>Orders and margin</h2>
      <ul>
        <li>Each market has a central limit order book with price-time priority: limit, market (5% slippage cap), post-only and reduce-only orders. Self-trades cancel the resting order.</li>
        <li>
          Margin is <strong>isolated per market</strong> and posted <strong>per fill</strong>. When an order fills, the exchange moves just enough from your wallet to cover the position at the leverage
          you chose. It also checks that both sides clear initial margin <em>at the oracle mark</em>, so a trade can never create bad debt. A maker whose order it can no longer afford loses the order.
        </li>
        <li>When a position closes, its collateral returns to your wallet. You can add or remove margin on an open position.</li>
      </ul>

      <h2>When the price gaps</h2>
      <ul>
        <li>
          Below maintenance margin with equity ≥ 0: <strong>liquidated</strong>. The position is closed at mark against the other side, pro-rata by size, and you keep what's left. There's no penalty.
        </li>
        <li>
          Equity &lt; 0: <strong>bankrupt</strong>. The shortfall is charged to the opposing side (<strong>ADL</strong>), and those positions are force-closed pro-rata. Most markets here use{" "}
          <strong>capped pro-rata on positive PnL</strong> (Chitra's fair rule): profit pays first, and principal pays only when profits can't cover it. The other option is size pro-rata.
        </li>
        <li>Solvency is cheap; payment isn't. When a gap is big enough, winners collect less than they were owed, and the risk feed shows exactly who paid.</li>
      </ul>

      <h2>Oracles</h2>
      <ul>
        <li>
          <strong>Crypto, memecoins, equities:</strong> Hyperliquid mid prices (including a HIP-3 equity perp). The order book here is our own; only the oracle comes from outside.
        </li>
        <li>
          <strong>Prediction markets:</strong> Polymarket midpoints on outcome tokens. A market settles at 0 or 1 when Polymarket resolves it. Resolution is a guaranteed gap: anyone less than
          fully collateralized on the losing side goes bankrupt.
        </li>
        <li>
          <strong>Attention markets:</strong> anyone can list a handle. It gets an xy=k spot curve ($5k virtual USDC, 1B tokens, Mirror's published reserves), and the perp's oracle is that curve:
          instant, or a TWAP. With an instant oracle, a spot pump moves the mark in the same transaction, which is the pump attack.
        </li>
        <li>The admin page can force any external oracle to a price and hold it. That's how to demo a gap.</li>
      </ul>

      <h2>Leverage, funding, taper</h2>
      <ul>
        <li>
          Markets launch at <strong>3×</strong> and graduate through 5×, 10×, 20×, 50× and 100× as cumulative volume and depth (open interest, plus curve USDC) pass thresholds. Tiers never come back down.
        </li>
        <li>Funding is hourly, accrued every couple of seconds: a base rate paid by longs to shorts (0.05%/h at launch, falling with each tier) plus a premium on the last trade vs the oracle.</li>
        <li>Markets with a scheduled resolution can taper: requirements ramp to full collateral against max loss before the end.</li>
      </ul>

      <h2>House bots</h2>
      <p>
        <code>maker</code> quotes a ladder around the oracle on every market, leaning against its inventory. <code>ape</code>, <code>degen</code>, <code>whale</code> and <code>scalper</code> trade randomly
        with leverage. They're ordinary accounts with no special treatment: they get liquidated, and they get haircut.
      </p>

      <h2>API</h2>
      <p>
        Everything the UI does goes through a JSON API. Send <code>Authorization: Bearer &lt;key&gt;</code> for trading. A websocket at <code>/ws</code> streams <code>markets</code>,{" "}
        <code>book:&lt;id&gt;</code>, <code>trades:&lt;id&gt;</code>, <code>candles:&lt;id&gt;</code>, <code>feed</code>, <code>leaderboard</code> and <code>account</code>. Example:
      </p>
      <pre className="note mono" style={{ whiteSpace: "pre-wrap" }}>
        {`curl -X POST localhost:8787/api/orders -H "authorization: Bearer $KEY" \\
  -H "content-type: application/json" \\
  -d '{"market":"BTC-PERP","side":"buy","type":"market","size":"0.01","leverage":3}'`}
      </pre>

      <h2>What this isn't</h2>
      <p>
        It isn't real money, custody, or a chain, and there are no partial liquidations, liquidation fees, perp trading fees or cross margin. The graduation, funding and taper parameters are ours,
        because Mirror publishes none. The research behind the design is in the repo's <code>docs/BRIEF.md</code>.
      </p>
    </div>
  );
}

// ---------- admin ----------

export function AdminPage({ markets }: { markets: MarketView[] }) {
  const toast = useToast();
  const [token, setToken] = useState(getAdminToken());
  const [status, setStatus] = useState<{ bots: { enabled: boolean; accounts: { id: string; wallet: string }[] } | null } | null>(null);
  const [prices, setPrices] = useState<Record<string, string>>({});
  const [hold, setHold] = useState("120");

  const call = async (path: string, body: object, ok: string) => {
    try {
      await api("POST", path, body, { admin: true });
      toast(ok, "up");
      void refresh();
    } catch (e) {
      toast((e as Error).message, "down");
    }
  };
  const refresh = async () => {
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

function MirrorMarket({ onList }: { onList: (path: string, body: object, label: string) => void }) {
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

function CreateMarket({ onCreate }: { onCreate: (body: object) => void }) {
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
