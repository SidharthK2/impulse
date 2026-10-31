import { useForm, useSelector } from "@tanstack/react-form";
import { Outlet } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { FormError, Input, useServerError } from "./components/form";
import { Header } from "./components/Header";
import { MarketSearch, useSearchShortcut } from "./components/MarketSearch";
import { api } from "./api";
import { Modal, useToast } from "./components/ui";
import { useFixtureDriver } from "./fixtures";
import { useConnected } from "./hooks";
import { useAccount, useMarkets } from "./queries";
import { usePrefs, useSession, useUi } from "./store";
import type { AccountView } from "./types";

export function Layout() {
  useFixtureDriver();
  useSearchShortcut();
  const key = useSession((s) => s.key);
  const signIn = useSession((s) => s.signIn);
  const modal = useUi((s) => s.modal);
  const open = useUi((s) => s.open);
  const markets = useMarkets();
  const account = useAccount();

  useRiskToasts(key ? account : undefined);

  return (
    <div className="app">
      <Header />

      <main className="main">
        {!markets ? (
          <div className="empty">
            Connecting to the exchange…
            {import.meta.env.DEV && " (no server? switch on fixtures in the status bar)"}
          </div>
        ) : (
          <Outlet />
        )}
      </main>

      <StatusBar />
      <MarketSearch />
      {modal === "signup" && (
        <SignUp onDone={(k) => (signIn(k), open(null))} onClose={() => open(null)} />
      )}
    </div>
  );
}

/** A slim bar along the bottom: connection state, what kind of money this is, the dev fixtures switch. */
function StatusBar() {
  const connected = useConnected();
  const fixtures = usePrefs((s) => s.fixtures);
  const markets = useMarkets();
  const state = connected ? "live" : fixtures ? "fixtures" : "down";
  return (
    <footer className="statusbar">
      <span
        className={`status-conn ${state}`}
        title={
          connected
            ? "Websocket connected: prices and fills stream live"
            : "Reconnecting to the exchange…"
        }
      >
        <span className={`dot ${connected ? "on" : ""}`} />{" "}
        {connected ? "Connected" : fixtures ? "Fixtures only, no server" : "Reconnecting…"}
      </span>
      <span className="faint hide-sm">{markets ? `${markets.length} markets` : ""}</span>
      <span className="faint hide-sm">Paper money only</span>
      <span className="spacer" />
      {import.meta.env.DEV && (
        <label
          className="dev-switch"
          title="Dev only: merge typed fixtures (web/src/fixtures) for contract fields a server doesn't send"
        >
          <input
            type="checkbox"
            role="switch"
            checked={fixtures}
            onChange={(e) => usePrefs.getState().setFixtures(e.target.checked)}
          />
          <span className="switch" aria-hidden="true" />
          fixtures
        </label>
      )}
      <button
        type="button"
        className="status-link hide-sm"
        onClick={() => useUi.getState().setSearch(true)}
      >
        <kbd>/</kbd> markets
      </button>
    </footer>
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
    const fresh = account.risk.filter(
      (e) =>
        e.id > seen.current! &&
        ["liquidation", "bankrupt", "haircut", "adl", "settlement"].includes(e.kind),
    );
    seen.current = Math.max(seen.current, latest);
    for (const e of fresh.reverse())
      toast(
        e.text,
        e.kind === "bankrupt" || e.kind === "haircut"
          ? "down"
          : e.kind === "settlement"
            ? "info"
            : "warn",
      );
  }, [account, toast]);
}

function SignUp({ onDone, onClose }: { onDone: (key: string) => void; onClose: () => void }) {
  const [created, setCreated] = useState<{ id: string; apiKey: string } | null>(null);
  const server = useServerError();
  const create = useForm({
    defaultValues: { name: "" },
    onSubmit: async ({ value }) => {
      server.clear();
      try {
        setCreated(
          await api<{ id: string; apiKey: string }>("POST", "/api/accounts", {
            name: value.name.trim(),
          }),
        );
      } catch (e) {
        server.fail(e);
      }
    },
  });
  const signIn = useForm({
    defaultValues: { key: "" },
    onSubmit: ({ value }) => onDone(value.key.trim()),
  });
  const pending = useSelector(create.store, (s) => s.isSubmitting);
  if (created) {
    return (
      <Modal onClose={() => onDone(created.apiKey)}>
        <h2>Welcome, {created.id}</h2>
        <p>
          Your account holds $10,000 of paper USDC. This API key is your login, and it's stored in
          this browser. Copy it if you want to sign in elsewhere or trade from a script.
        </p>
        <input
          className="input mono"
          readOnly
          value={created.apiKey}
          onFocus={(e) => e.target.select()}
        />
        <button type="button" className="btn primary block" onClick={() => onDone(created.apiKey)}>
          Start trading
        </button>
      </Modal>
    );
  }
  return (
    <Modal onClose={onClose}>
      <h2>Open a paper account</h2>
      <p>
        Pick a name. You get $10,000 of paper USDC, with more from the faucet. Nothing here is real
        money.
      </p>
      <form
        className="col"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void create.handleSubmit();
        }}
      >
        <create.Field
          name="name"
          validators={{
            onChange: ({ value }) =>
              /^[A-Za-z0-9_]{3,16}$/.test(value.trim()) ? undefined : "3–16 letters, digits or _",
          }}
        >
          {(f) => (
            <Input
              field={f}
              autoFocus
              placeholder="name (3–16 letters, digits, _)"
              aria-label="Account name"
            />
          )}
        </create.Field>
        <FormError error={server.error} />
        <button type="submit" className="btn primary block" disabled={pending}>
          {pending ? "Creating…" : "Create account"}
        </button>
      </form>
      <div className="faint" style={{ fontSize: 12 }}>
        Already have one? Paste your API key:
      </div>
      <form
        className="row top"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void signIn.handleSubmit();
        }}
      >
        <signIn.Field
          name="key"
          validators={{
            onChange: ({ value }) => (value.trim() ? undefined : "Paste your API key"),
          }}
        >
          {(f) => (
            <Input
              field={f}
              className="mono"
              placeholder="API key"
              aria-label="API key"
              transform={(v) => v.trim()}
              wrap={{ flex: 1 }}
            />
          )}
        </signIn.Field>
        <button type="submit" className="btn">
          Sign in
        </button>
      </form>
    </Modal>
  );
}
