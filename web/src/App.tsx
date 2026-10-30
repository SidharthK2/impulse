import { Link, Outlet, useRouterState } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { Roll } from "./components/Roll";
import { api } from "./api";
import { Modal, useToast } from "./components/ui";
import { useFixtureDriver } from "./fixtures";
import { countdown, num, tone, usd } from "./format";
import { useConnected, useNow } from "./hooks";
import { useAccount, useMarkets } from "./queries";
import { usePrefs, useSession, useUi } from "./store";
import type { AccountView } from "./types";

const NAV = [
  { to: "/", label: "Markets" },
  { to: "/trade", label: "Trade" },
  { to: "/portfolio", label: "Portfolio" },
  { to: "/leaderboard", label: "Leaderboard" },
  { to: "/feed", label: "Who paid" },
  { to: "/admin", label: "Admin" },
] as const;

export function Layout() {
  useFixtureDriver();
  const theme = usePrefs((s) => s.theme);
  const setTheme = usePrefs((s) => s.setTheme);
  const fixtures = usePrefs((s) => s.fixtures);
  const lastMarket = usePrefs((s) => s.lastMarket);
  const key = useSession((s) => s.key);
  const signIn = useSession((s) => s.signIn);
  const modal = useUi((s) => s.modal);
  const open = useUi((s) => s.open);
  const markets = useMarkets();
  const account = useAccount();
  const connected = useConnected();
  const path = useRouterState({ select: (s) => s.location.pathname });

  useRiskToasts(account);

  return (
    <div className="app">
      <header className="header">
        <Link className="brand" to="/">
          <svg width="22" height="22" viewBox="0 0 32 32" aria-hidden="true">
            <rect width="32" height="32" rx="7" fill="var(--brand-tile)" />
            <path d="M4 18h6l3-9 5 15 3-8h7" fill="none" stroke="var(--accent)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          IMPULSE <small>paper</small>
        </Link>
        <nav className="nav">
          {NAV.map((n) => {
            const active = n.to === "/" ? path === "/" : path.startsWith(n.to);
            return n.to === "/trade" ? (
              <Link key={n.to} to="/trade/$market" params={{ market: lastMarket ?? markets?.[0]?.id ?? "BTC-PERP" }} className={active ? "active" : ""}>
                {n.label}
              </Link>
            ) : (
              <Link key={n.to} to={n.to} className={active ? "active" : ""}>
                {n.label}
              </Link>
            );
          })}
        </nav>
        <span className="spacer" />
        {import.meta.env.DEV && (
          <label className="check dev-toggle" title="Dev only: merge typed fixtures (web/src/fixtures) for contract fields this server doesn't send yet">
            <input type="checkbox" checked={fixtures} onChange={(e) => usePrefs.getState().setFixtures(e.target.checked)} /> <span className="hide-sm">fixtures</span>
          </label>
        )}
        <button className="btn small ghost icon" onClick={() => setTheme(theme === "dark" ? "light" : "dark")} title={`Switch to ${theme === "dark" ? "light" : "dark"} theme`} aria-label="Toggle theme">
          {theme === "dark" ? "☀" : "☾"}
        </button>
        <span className="row muted live-dot" title={connected ? "Live" : "Reconnecting…"}>
          <span className={`dot ${connected ? "on" : ""}`} /> <span className="hide-sm">{connected ? "live" : fixtures ? "fixtures" : "offline"}</span>
        </span>
        <AccountChip account={account} signedIn={!!key} onSignUp={() => open("signup")} onSignOut={() => signIn(null)} />
      </header>

      <main className="main">
        {!markets ? <div className="empty">Connecting to the exchange…{import.meta.env.DEV && " (no server? tick “fixtures” in the header)"}</div> : <Outlet />}
      </main>

      {modal === "signup" && <SignUp onDone={(k) => (signIn(k), open(null))} onClose={() => open(null)} />}
    </div>
  );
}

/** Tell the user, wherever they are in the app, when risk processing touches their account. */
function useRiskToasts(account: AccountView | undefined) {
  const toast = useToast();
  const seen = useRef<number | null>(null);
  useEffect(() => {
    if (!account) return;
    const latest = Math.max(0, ...account.risk.map((e) => e.id));
    if (seen.current === null) {
      seen.current = latest; // don't replay history on load
      return;
    }
    const fresh = account.risk.filter((e) => e.id > seen.current! && ["liquidation", "bankrupt", "haircut", "adl", "settlement"].includes(e.kind));
    seen.current = Math.max(seen.current, latest);
    for (const e of fresh.reverse()) toast(e.text, e.kind === "bankrupt" || e.kind === "haircut" ? "down" : e.kind === "settlement" ? "info" : "warn");
  }, [account, toast]);
}

function AccountChip({ account, signedIn, onSignUp, onSignOut }: { account: AccountView | undefined; signedIn: boolean; onSignUp: () => void; onSignOut: () => void }) {
  const toast = useToast();
  const now = useNow(1000);
  if (!signedIn) {
    return (
      <button className="btn primary" onClick={onSignUp}>
        Sign up<span className="hide-sm"> · get $10k</span>
      </button>
    );
  }
  if (!account) return <span className="muted">…</span>;
  const wait = account.nextFaucet - now;
  return (
    <div className="acct">
      <div className="who">
        <span>
          <b>{account.id}</b> <Roll className={`mono ${tone(num(account.pnl))}`} text={usd(account.pnl, { sign: true })} value={num(account.pnl)} />
        </span>
        <small>
          equity <Roll text={usd(account.equity)} flash={false} /> · wallet {usd(account.wallet)}
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
