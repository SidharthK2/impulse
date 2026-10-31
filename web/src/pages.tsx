import { useEffect, useMemo, useState } from "react";
import { api } from "./api";
import { normalizeEvents } from "./normalize";
import { RiskList } from "./components/RiskFeed";
import { num, usd } from "./format";
import { useFeed } from "./queries";
import type { RiskEvent, RiskKind } from "./types";

// ---------- risk feed ----------

const KINDS: RiskKind[] = [
  "bankrupt",
  "haircut",
  "liquidation",
  "adl",
  "settlement",
  "graduation",
  "gap",
  "listing",
  "open",
  "ipo",
];

export function FeedPage() {
  const [history, setHistory] = useState<RiskEvent[]>([]);
  const live = useFeed();
  const [kinds, setKinds] = useState<Set<RiskKind>>(new Set(KINDS));
  const [market, setMarket] = useState("");
  useEffect(() => {
    api<unknown>("GET", "/api/feed")
      .then((xs) => setHistory(normalizeEvents(xs)))
      .catch(() => {});
  }, []);
  const all = useMemo(() => {
    const seen = new Set<number>();
    return [...live, ...history]
      .filter((e) => !seen.has(e.id) && (seen.add(e.id), true))
      .sort((a, b) => b.id - a.id);
  }, [live, history]);
  const shown = all.filter((e) => kinds.has(e.kind) && (!market || e.market === market));
  const sum = (k: RiskKind) =>
    all.filter((e) => e.kind === k).reduce((s, e) => s + num(e.amount ?? "0"), 0);
  const count = (k: RiskKind) => all.filter((e) => e.kind === k).length;
  const markets = [...new Set(all.map((e) => e.market))].sort();
  return (
    <div className="page">
      <h1>Risk feed</h1>
      <p className="lead">
        There's no insurance fund. When a position's equity goes negative, the shortfall is charged
        to the traders on the other side (ADL), inside the same transaction. This is every
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
        <select
          className="input"
          style={{ width: 220 }}
          value={market}
          onChange={(e) => setMarket(e.target.value)}
        >
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

// ---------- how it works ----------

export function AboutPage() {
  return (
    <div className="page prose">
      <h1>How Impulse works</h1>
      <p className="lead">
        A paper-trading <strong>MicroPerps</strong> exchange, modelled on the design Mirror
        describes: leveraged perps on any asset, with{" "}
        <strong>auto-deleveraging as the only backstop</strong>. There's no insurance fund and no
        house vault. Everything here is play money.
      </p>

      <h2>One atomic core</h2>
      <p>
        Every action is a single transition of a deterministic risk engine (integer nano-USD, no
        floats): a fill, an oracle tick, a curve trade, or a clock step. Each transition runs
        liquidation and ADL inside itself, then checks the invariants before it commits: exposure
        balanced, money conserved, no negative equity. So the venue is{" "}
        <strong>solvent after every transition</strong>, by construction.
      </p>

      <h2>Orders and margin</h2>
      <ul>
        <li>
          Each market has a central limit order book with price-time priority: limit, market (5%
          slippage cap), post-only and reduce-only orders. Self-trades cancel the resting order.
        </li>
        <li>
          Margin is <strong>isolated per market</strong> and posted <strong>per fill</strong>. When
          an order fills, the exchange moves just enough from your wallet to cover the position at
          the leverage you chose. It also checks that both sides clear initial margin{" "}
          <em>at the oracle mark</em>, so a trade can never create bad debt. A maker whose order it
          can no longer afford loses the order.
        </li>
        <li>
          When a position closes, its collateral returns to your wallet. You can add or remove
          margin on an open position.
        </li>
      </ul>

      <h2>When the price gaps</h2>
      <ul>
        <li>
          Below maintenance margin with equity ≥ 0: <strong>liquidated</strong>. The position is
          closed at mark against the other side, pro-rata by size, and you keep what's left. There's
          no penalty.
        </li>
        <li>
          Equity &lt; 0: <strong>bankrupt</strong>. The shortfall is charged to the opposing side (
          <strong>ADL</strong>), and those positions are force-closed pro-rata. Most markets here
          use <strong>capped pro-rata on positive PnL</strong> (Chitra's fair rule): profit pays
          first, and principal pays only when profits can't cover it. The other option is size
          pro-rata.
        </li>
        <li>
          Solvency is cheap; payment isn't. When a gap is big enough, winners collect less than they
          were owed, and the risk feed shows exactly who paid.
        </li>
      </ul>

      <h2>Oracles</h2>
      <ul>
        <li>
          <strong>Crypto, memecoins, equities:</strong> Hyperliquid mid prices (including a HIP-3
          equity perp). The order book here is our own; only the oracle comes from outside.
        </li>
        <li>
          <strong>Prediction markets:</strong> Polymarket midpoints on outcome tokens. A market
          settles at 0 or 1 when Polymarket resolves it. Resolution is a guaranteed gap: anyone less
          than fully collateralized on the losing side goes bankrupt.
        </li>
        <li>
          <strong>Attention markets:</strong> anyone can list a handle. It gets an xy=k spot curve
          ($5k virtual USDC, 1B tokens, Mirror's published reserves), and the perp's oracle is that
          curve: instant, or a TWAP. With an instant oracle, a spot pump moves the mark in the same
          transaction, which is the pump attack.
        </li>
        <li>
          The admin page can force any external oracle to a price and hold it. That's how to demo a
          gap.
        </li>
      </ul>

      <h2>Leverage, funding, taper</h2>
      <ul>
        <li>
          Markets launch at <strong>3×</strong> and graduate through 5×, 10×, 20×, 50× and 100× as
          cumulative volume and depth (open interest, plus curve USDC) pass thresholds. Tiers never
          come back down.
        </li>
        <li>
          Funding is hourly, accrued every couple of seconds: a base rate paid by longs to shorts
          (0.05%/h at launch, falling with each tier) plus a premium on the last trade vs the
          oracle.
        </li>
        <li>
          Markets with a scheduled resolution can taper: requirements ramp to full collateral
          against max loss before the end.
        </li>
      </ul>

      <h2>House bots</h2>
      <p>
        <code>maker</code> quotes a ladder around the oracle on every market, leaning against its
        inventory. <code>ape</code>, <code>degen</code>, <code>whale</code> and <code>scalper</code>{" "}
        trade randomly with leverage. They're ordinary accounts with no special treatment: they get
        liquidated, and they get haircut.
      </p>

      <h2>API</h2>
      <p>
        Everything the UI does goes through a JSON API. Send{" "}
        <code>Authorization: Bearer &lt;key&gt;</code> for trading. A websocket at <code>/ws</code>{" "}
        streams <code>markets</code>, <code>book:&lt;id&gt;</code>, <code>trades:&lt;id&gt;</code>,{" "}
        <code>candles:&lt;id&gt;</code>, <code>feed</code>, <code>leaderboard</code> and{" "}
        <code>account</code>. Example:
      </p>
      <pre className="note mono" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
        {`curl -X POST localhost:8787/api/orders -H "authorization: Bearer $KEY" \\
  -H "content-type: application/json" \\
  -d '{"market":"BTC-PERP","side":"buy","type":"market","size":"0.01","leverage":3}'`}
      </pre>

      <h2>What this isn't</h2>
      <p>
        It isn't real money, custody, or a chain, and there are no partial liquidations, liquidation
        fees, perp trading fees or cross margin. The graduation, funding and taper parameters are
        ours, because Mirror publishes none. The research behind the design is in the
        impulse-research repo (<code>docs/BRIEF.md</code>).
      </p>
    </div>
  );
}
