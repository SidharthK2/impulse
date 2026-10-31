// The top bar: brand, the main pages (secondary ones under More), market search, theme, and the account menu.

import { Link, useRouterState } from "@tanstack/react-router";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { api, getKey } from "../api";
import { countdown, num, tone, usd } from "../format";
import { useNow } from "../hooks";
import { useAccount, useMarkets } from "../queries";
import { usePrefs, useSession, useUi } from "../store";
import { ChevronDown, DropIcon, KeyIcon, LogoutIcon, MenuIcon, MoonIcon, PieIcon, SearchIcon, SunIcon } from "./icons";
import { Roll } from "./Roll";
import { useToast } from "./ui";

const MORE = [
  { to: "/feed", label: "Who paid", hint: "Every liquidation, bankruptcy and haircut" },
  { to: "/about", label: "How it works", hint: "Margin, ADL, oracles and launches" },
  { to: "/admin", label: "Admin", hint: "Gaps, IPOs, demo coins" },
] as const;

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.userAgent);

/** Close a popover on an outside click or Escape. */
function useDismiss(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const click = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && close();
    const key = (e: KeyboardEvent) => e.key === "Escape" && close();
    document.addEventListener("mousedown", click);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("mousedown", click);
      document.removeEventListener("keydown", key);
    };
  }, [open, close]);
  return ref;
}

function Menu({ label, className = "", active = false, children, align = "left" }: { label: ReactNode; className?: string; active?: boolean; children: (close: () => void) => ReactNode; align?: "left" | "right" }) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const ref = useDismiss(open, close);
  return (
    <div className={`menu ${open ? "open" : ""}`} ref={ref}>
      <button className={`${className} ${active ? "active" : ""}`} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
        {label}
      </button>
      {open && (
        <div className={`menu-pop ${align}`} role="menu">
          {children(close)}
        </div>
      )}
    </div>
  );
}

export function Header() {
  const theme = usePrefs((s) => s.theme);
  const setTheme = usePrefs((s) => s.setTheme);
  const lastMarket = usePrefs((s) => s.lastMarket);
  const setSearch = useUi((s) => s.setSearch);
  const markets = useMarkets();
  const path = useRouterState({ select: (s) => s.location.pathname });
  const tradeTo = lastMarket ?? markets?.[0]?.id ?? "BTC-PERP";
  const is = (to: string) => (to === "/" ? path === "/" : path.startsWith(to));

  return (
    <header className="header">
      <Link className="brand" to="/" aria-label="Impulse home">
        <svg width="24" height="24" viewBox="0 0 32 32" aria-hidden="true">
          <rect width="32" height="32" rx="8" fill="var(--brand-tile)" />
          <path d="M4 18h6l3-9 5 15 3-8h7" fill="none" stroke="var(--accent)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span className="brand-name">Impulse</span>
        <span className="brand-tag">paper</span>
      </Link>

      <nav className="nav" aria-label="Main">
        <Link to="/" className={is("/") ? "active" : ""}>
          Markets
        </Link>
        <Link to="/trade/$market" params={{ market: tradeTo }} className={is("/trade") ? "active" : ""}>
          Trade
        </Link>
        <Link to="/portfolio" className={is("/portfolio") ? "active" : ""}>
          Portfolio
        </Link>
        <Link to="/leaderboard" className={is("/leaderboard") ? "active" : ""}>
          Leaderboard
        </Link>
        <Menu
          className="nav-more"
          active={MORE.some((m) => is(m.to))}
          label={
            <>
              More <ChevronDown />
            </>
          }
        >
          {(close) =>
            MORE.map((m) => (
              <Link key={m.to} to={m.to} className={`menu-item ${is(m.to) ? "on" : ""}`} onClick={close} role="menuitem">
                <span>{m.label}</span>
                <small>{m.hint}</small>
              </Link>
            ))
          }
        </Menu>
      </nav>

      <span className="spacer" />

      <button className="search-btn" onClick={() => setSearch(true)} aria-label="Search markets" title="Search markets">
        <SearchIcon />
        <span className="search-label">Search markets</span>
        <kbd>{isMac ? "⌘K" : "Ctrl K"}</kbd>
      </button>
      <button className="icon-btn" onClick={() => setTheme(theme === "dark" ? "light" : "dark")} aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`} title={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}>
        {theme === "dark" ? <SunIcon /> : <MoonIcon />}
      </button>
      <AccountButton />
      <div className="nav-burger">
        <Menu align="right" className="icon-btn" label={<MenuIcon />}>
          {(close) => (
            <>
              {(
                [
                  ["/", "Markets"],
                  ["/portfolio", "Portfolio"],
                  ["/leaderboard", "Leaderboard"],
                ] as const
              ).map(([to, label]) => (
                <Link key={to} to={to} className={`menu-item ${is(to) ? "on" : ""}`} onClick={close} role="menuitem">
                  {label}
                </Link>
              ))}
              <Link to="/trade/$market" params={{ market: tradeTo }} className={`menu-item ${is("/trade") ? "on" : ""}`} onClick={close} role="menuitem">
                Trade
              </Link>
              <div className="menu-sep" />
              {MORE.map((m) => (
                <Link key={m.to} to={m.to} className={`menu-item ${is(m.to) ? "on" : ""}`} onClick={close} role="menuitem">
                  {m.label}
                </Link>
              ))}
            </>
          )}
        </Menu>
      </div>
    </header>
  );
}

function AccountButton() {
  const key = useSession((s) => s.key);
  const signIn = useSession((s) => s.signIn);
  const openModal = useUi((s) => s.open);
  const account = useAccount();
  const toast = useToast();
  const now = useNow(1000);

  if (!key) {
    return (
      <div className="row acct-out">
        <button className="btn ghost hide-sm" onClick={() => openModal("signup")}>
          Sign in
        </button>
        <button className="btn primary" onClick={() => openModal("signup")}>
          Sign up<span className="hide-sm"> · $10k</span>
        </button>
      </div>
    );
  }
  if (!account) return <span className="acct-loading" aria-label="Loading account" />;

  const pnl = num(account.pnl);
  const wait = account.nextFaucet - now;
  const inUse = num(account.equity) - num(account.wallet);
  const faucet = () =>
    api<{ amount: string }>("POST", "/api/faucet")
      .then((r) => toast(`+${usd(r.amount)} paper USDC`, "up"))
      .catch((e) => toast((e as Error).message, "down"));

  return (
    <Menu
      align="right"
      className="acct-btn"
      label={
        <>
          <span className="avatar" aria-hidden="true">
            {account.id.slice(0, 1).toUpperCase()}
          </span>
          <span className="acct-figs">
            <Roll className="mono acct-equity" text={usd(account.equity)} value={num(account.equity)} flash={false} />
            <Roll className={`mono acct-pnl ${tone(pnl)}`} text={usd(pnl, { sign: true })} value={pnl} />
          </span>
          <ChevronDown />
        </>
      }
    >
      {(close) => (
        <div className="acct-pop">
          <div className="acct-pop-head">
            <span className="avatar lg" aria-hidden="true">
              {account.id.slice(0, 1).toUpperCase()}
            </span>
            <div>
              <b>{account.id}</b>
              <div className="faint small">Paper account</div>
            </div>
          </div>
          <dl className="acct-pop-figs">
            <dt>Equity</dt>
            <dd className="mono">{usd(account.equity)}</dd>
            <dt>Total PnL</dt>
            <dd className={`mono ${tone(pnl)}`}>{usd(pnl, { sign: true })}</dd>
            <dt>Wallet</dt>
            <dd className="mono">{usd(account.wallet)}</dd>
            <dt>In positions</dt>
            <dd className="mono">{usd(inUse)}</dd>
            {num(account.ledger.adlPaid) > 0 && (
              <>
                <dt>ADL haircuts paid</dt>
                <dd className="mono down">{usd(account.ledger.adlPaid)}</dd>
              </>
            )}
          </dl>
          <button className="btn primary block" disabled={wait > 0} onClick={faucet} title="Paper USDC: $10,000 a minute, up to a $100k wallet">
            <DropIcon /> {wait > 0 ? `Faucet ready in ${countdown(wait)}` : "Get $10,000 paper USDC"}
          </button>
          <div className="menu-sep" />
          <Link to="/portfolio" className="menu-item row-item" onClick={close} role="menuitem">
            <PieIcon /> Portfolio
          </Link>
          <button
            className="menu-item row-item"
            role="menuitem"
            onClick={() => {
              const k = getKey();
              if (k)
                void navigator.clipboard
                  ?.writeText(k)
                  .then(() => toast("API key copied", "info"))
                  .catch(() => toast("Couldn't copy the key", "warn"));
              close();
            }}
          >
            <KeyIcon /> Copy API key
          </button>
          <button
            className="menu-item row-item danger"
            role="menuitem"
            onClick={() => {
              signIn(null);
              close();
            }}
            title="Forget the API key in this browser"
          >
            <LogoutIcon /> Sign out
          </button>
        </div>
      )}
    </Menu>
  );
}
