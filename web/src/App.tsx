import { useEffect, useMemo, useState } from "react";
import { api, getKey, setKey } from "./api";
import { AccountPanel } from "./components/AccountPanel";
import { Chart } from "./components/Chart";
import { InfoPanel, MarketBar, SpotPanel } from "./components/Market";
import { OrderBook, Trades } from "./components/OrderBook";
import { OrderForm } from "./components/OrderForm";
import { RiskList } from "./components/RiskFeed";
import { Modal, ToastProvider, useToast } from "./components/ui";
import { countdown, num, tone, usd } from "./format";
import { useChannel, useConnected, useHashRoute, useNow } from "./hooks";
import { AboutPage, AdminPage, FeedPage, LeaderboardPage } from "./pages";
import type { AccountView, MarketView, RiskEvent } from "./types";

export default function App() {
  return (
    <ToastProvider>
      <Shell />
    </ToastProvider>
  );
}

function Shell() {
  const [route, go] = useHashRoute();
  const [key, setKeyState] = useState(getKey());
  const [modal, setModal] = useState<"signup" | "list" | null>(null);
  const markets = useChannel<MarketView[]>("markets");
  const account = useChannel<AccountView | null>(key ? "account" : null) ?? undefined;
  const connected = useConnected();
  const byId = useMemo(() => Object.fromEntries((markets ?? []).map((m) => [m.id, m])), [markets]);

  const page = route[0] ?? "trade";
  const marketId = page === "trade" && route[1] && byId[route[1]] ? route[1] : (markets?.[0]?.id ?? null);
  const signIn = (k: string | null) => {
    setKey(k);
    setKeyState(k);
  };

  return (
    <div className="app">
      <header className="header">
        <a className="brand" href="#/trade">
          <svg width="22" height="22" viewBox="0 0 32 32" aria-hidden="true">
            <rect width="32" height="32" rx="7" fill="#151a23" />
            <path d="M4 18h6l3-9 5 15 3-8h7" fill="none" stroke="var(--accent)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          IMPULSE <small>paper</small>
        </a>
        <nav className="nav">
          {[
            ["trade", "Trade"],
            ["feed", "Risk feed"],
            ["leaderboard", "Leaderboard"],
            ["about", "How it works"],
            ["admin", "Admin"],
          ].map(([id, label]) => (
            <a key={id} href={`#/${id}${id === "trade" && marketId ? `/${encodeURIComponent(marketId)}` : ""}`} className={page === id ? "active" : ""}>
              {label}
            </a>
          ))}
        </nav>
        <span className="spacer" />
        <span className="row muted" title={connected ? "Live" : "Reconnecting…"} style={{ fontSize: 12 }}>
          <span className={`dot ${connected ? "on" : ""}`} /> {connected ? "live" : "offline"}
        </span>
        <AccountChip account={account} signedIn={!!key} onSignUp={() => setModal("signup")} onSignOut={() => signIn(null)} />
      </header>

      <main className="main">
        {!markets ? (
          <div className="empty">Connecting to the exchange…</div>
        ) : page === "feed" ? (
          <FeedPage />
        ) : page === "leaderboard" ? (
          <LeaderboardPage me={account?.id} />
        ) : page === "about" ? (
          <AboutPage />
        ) : page === "admin" ? (
          <AdminPage markets={markets} />
        ) : marketId ? (
          <TradePage
            key={marketId}
            market={byId[marketId]!}
            markets={markets}
            byId={byId}
            account={account}
            signedIn={!!key}
            onPick={(id) => go(`trade/${encodeURIComponent(id)}`)}
            onSignUp={() => setModal("signup")}
            onList={() => (key ? setModal("list") : setModal("signup"))}
          />
        ) : (
          <div className="empty">No markets listed.</div>
        )}
      </main>

      {modal === "signup" && <SignUp onDone={(k) => (signIn(k), setModal(null))} onClose={() => setModal(null)} />}
      {modal === "list" && <ListAttention onClose={() => setModal(null)} onListed={(id) => (setModal(null), go(`trade/${encodeURIComponent(id)}`))} />}
    </div>
  );
}

function AccountChip({ account, signedIn, onSignUp, onSignOut }: { account: AccountView | undefined; signedIn: boolean; onSignUp: () => void; onSignOut: () => void }) {
  const toast = useToast();
  const now = useNow(1000);
  if (!signedIn) {
    return (
      <button className="btn primary" onClick={onSignUp}>
        Sign up · get $10k
      </button>
    );
  }
  if (!account) return <span className="muted">…</span>;
  const wait = account.nextFaucet - now;
  return (
    <div className="acct">
      <div className="who">
        <span>
          <b>{account.id}</b> <span className={`mono ${tone(num(account.pnl))}`}>{usd(account.pnl, { sign: true })}</span>
        </span>
        <small>
          equity {usd(account.equity)} · wallet {usd(account.wallet)}
        </small>
      </div>
      <button
        className="btn small"
        disabled={wait > 0}
        title="Paper USDC: $10,000 a minute, up to a $100k wallet"
        onClick={() =>
          api<{ amount: string }>("POST", "/api/faucet")
            .then((r) => toast(`+${usd(r.amount)} paper USDC`, "up"))
            .catch((e) => toast((e as Error).message, "down"))
        }
      >
        {wait > 0 ? `faucet ${countdown(wait)}` : "+ $10k"}
      </button>
      <button className="btn small ghost" onClick={onSignOut} title="Forget the API key in this browser">
        Sign out
      </button>
    </div>
  );
}

function SignUp({ onDone, onClose }: { onDone: (key: string) => void; onClose: () => void }) {
  const [name, setName] = useState("");
  const [existing, setExisting] = useState("");
  const [created, setCreated] = useState<{ id: string; apiKey: string } | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  async function create() {
    setBusy(true);
    setErr("");
    try {
      setCreated(await api<{ id: string; apiKey: string }>("POST", "/api/accounts", { name }));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (created) {
    return (
      <Modal onClose={() => onDone(created.apiKey)}>
        <h2>Welcome, {created.id}</h2>
        <p>Your account holds $10,000 of paper USDC. This API key is your login, and it's stored in this browser. Copy it if you want to sign in elsewhere or trade from a script.</p>
        <input className="input mono" readOnly value={created.apiKey} onFocus={(e) => e.target.select()} />
        <button className="btn primary block" onClick={() => onDone(created.apiKey)}>
          Start trading
        </button>
      </Modal>
    );
  }
  return (
    <Modal onClose={onClose}>
      <h2>Open a paper account</h2>
      <p>Pick a name. You get $10,000 of paper USDC, with more from the faucet. Nothing here is real money.</p>
      <form
        className="col"
        onSubmit={(e) => {
          e.preventDefault();
          void create();
        }}
      >
        <input className="input" autoFocus placeholder="name (3–16 letters, digits, _)" value={name} onChange={(e) => setName(e.target.value)} />
        {err && <div className="note down">{err}</div>}
        <button className="btn primary block" disabled={busy || name.trim().length < 3}>
          Create account
        </button>
      </form>
      <div className="faint" style={{ fontSize: 12 }}>
        Already have one? Paste your API key:
      </div>
      <div className="row">
        <input className="input mono" placeholder="API key" value={existing} onChange={(e) => setExisting(e.target.value.trim())} />
        <button className="btn" disabled={!existing} onClick={() => onDone(existing)}>
          Sign in
        </button>
      </div>
    </Modal>
  );
}

function ListAttention({ onClose, onListed }: { onClose: () => void; onListed: (id: string) => void }) {
  const [handle, setHandle] = useState("");
  const [oracleWindow, setOracleWindow] = useState(600);
  const [adl, setAdl] = useState<"pnl" | "size">("pnl");
  const [err, setErr] = useState("");
  async function list() {
    setErr("");
    try {
      const m = await api<MarketView>("POST", "/api/attention", { handle, oracleWindow, adl });
      onListed(m.id);
    } catch (e) {
      setErr((e as Error).message);
    }
  }
  return (
    <Modal onClose={onClose}>
      <h2>List an attention market</h2>
      <p>Listing is permissionless, as on Mirror: any handle gets a spot token on an xy=k curve ($5k virtual USDC, 1B tokens) plus a perp that marks to that curve.</p>
      <input className="input" autoFocus placeholder="@handle" value={handle} onChange={(e) => setHandle(e.target.value)} />
      <div className="field">
        <label>Perp oracle</label>
        <div className="seg">
          {[
            [0, "instant"],
            [60, "1m TWAP"],
            [600, "10m TWAP"],
            [3600, "60m TWAP"],
          ].map(([w, l]) => (
            <button key={w} className={oracleWindow === w ? "on" : ""} onClick={() => setOracleWindow(w as number)}>
              {l}
            </button>
          ))}
        </div>
      </div>
      <div className="field">
        <label>ADL rule</label>
        <div className="seg">
          <button className={adl === "pnl" ? "on" : ""} onClick={() => setAdl("pnl")}>
            capped PnL
          </button>
          <button className={adl === "size" ? "on" : ""} onClick={() => setAdl("size")}>
            size pro-rata
          </button>
        </div>
      </div>
      {oracleWindow === 0 && <div className="note warn">An instant oracle lets anyone with a spot buy move the perp's mark in the same transaction. That's the pump attack.</div>}
      {err && <div className="note down">{err}</div>}
      <button className="btn primary block" disabled={handle.replace("@", "").length < 2} onClick={list}>
        List market
      </button>
    </Modal>
  );
}

interface TradeProps {
  market: MarketView;
  markets: MarketView[];
  byId: Record<string, MarketView>;
  account: AccountView | undefined;
  signedIn: boolean;
  onPick: (id: string) => void;
  onSignUp: () => void;
  onList: () => void;
}

function TradePage({ market, markets, byId, account, signedIn, onPick, onSignUp, onList }: TradeProps) {
  const [picked, setPicked] = useState<{ price: string; n: number } | null>(null);
  const feed = useChannel<RiskEvent[]>("feed") ?? [];
  const position = account?.positions.find((p) => p.market === market.id && p.side !== "flat");
  useEffect(() => {
    document.title = `${market.mark ?? ""} ${market.id} · Impulse`;
  }, [market.mark, market.id]);
  return (
    <div className="trade">
      <MarketBar market={market} markets={markets} onPick={onPick} onList={onList} />
      <Chart market={market} position={position} />
      <div className="book-col">
        <OrderBook market={market} onPick={(p) => setPicked({ price: p, n: Date.now() })} />
        <Trades market={market} />
      </div>
      <div className="form-col scroll">
        <OrderForm market={market} account={account} signedIn={signedIn} picked={picked} onSignUp={onSignUp} />
        {market.curve && <SpotPanel market={market} account={account} signedIn={signedIn} />}
        <InfoPanel market={market} />
        <div className="panel">
          <div className="panel-head">
            <h3>Risk feed</h3>
            <span className="spacer" />
            <a href="#/feed" style={{ fontSize: 12 }}>
              all
            </a>
          </div>
          <RiskList events={feed.slice(0, 12)} onMarket={onPick} />
        </div>
      </div>
      <AccountPanel account={account} markets={byId} current={market} signedIn={signedIn} onPick={onPick} />
    </div>
  );
}
