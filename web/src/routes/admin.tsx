import { type AnyFieldApi, useForm, useSelector } from "@tanstack/react-form";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import { api, getAdminToken, setAdminToken } from "../api";
import {
  FieldError,
  FormError,
  Input,
  invalid,
  positive,
  useServerError,
} from "../components/form";
import { useToast } from "../components/ui";
import { num, price, toInput, usd } from "../format";
import { act, NO_MARKETS, useMarkets } from "../queries";
import type { MarketView } from "../types";

// ---------- admin ----------

type Status = {
  bots: { enabled: boolean; accounts: { id: string; wallet: string }[] } | null;
} | null;

const adminPost = <T = unknown,>(path: string, body: Record<string, unknown>) =>
  act<T>("POST", path, body, { admin: true });

/** The chosen market if it's still in the list, else the first one. */
const pick = (id: string, list: MarketView[]) =>
  list.some((m) => m.id === id) ? id : (list[0]?.id ?? "");

const HANDLE = /^@?[A-Za-z0-9_]{2,20}$/;

function holdError(v: string) {
  if (!/^\d+$/.test(v.trim())) return "Whole seconds, 0 or more";
  return undefined;
}

export function AdminPage() {
  const markets = useMarkets() ?? NO_MARKETS;
  const toast = useToast();
  // Null without a token or when the token is refused. Fetched fresh each time the page opens.
  const statusQuery = useQuery({
    queryKey: ["admin", "status"],
    queryFn: async (): Promise<Status> => {
      if (!getAdminToken()) return null;
      return api<Status>("GET", "/api/admin/status", undefined, { admin: true }).catch(() => null);
    },
    staleTime: 0,
    retry: false,
  });
  const status = statusQuery.data ?? null;
  const refresh = () => statusQuery.refetch();

  // One-click buttons (gaps, release, resolve, bots) aren't forms; they report through toasts.
  const call = async (path: string, body: Record<string, unknown>, ok: string) => {
    try {
      await adminPost(path, body);
      toast(ok, "up");
      void refresh();
    } catch (e) {
      toast((e as Error).message, "down");
    }
  };

  const hold = useForm({ defaultValues: { seconds: "120" } });
  const holdSeconds = useSelector(hold.store, (s) =>
    holdError(s.values.seconds) ? 0 : Number(s.values.seconds),
  );

  const gap = (m: MarketView, factor: number) => {
    const p = num(m.mark) * factor;
    const v = m.kind === "binary" ? Math.min(1, Math.max(0, p)) : p;
    void call(
      "/api/admin/price",
      { market: m.id, price: toInput(v, 9), holdSeconds },
      `${m.id} → ${toInput(v, m.priceDecimals)}`,
    );
  };

  return (
    <div className="page">
      <h1>Admin</h1>
      <p className="lead">
        Force oracle gaps, resolve markets, list markets and run the house bots. The server prints
        its admin token at startup (default <code>impulse-admin</code>).
      </p>
      <TokenForm authorized={!!status} onSaved={() => void refresh()} />

      <DemoControls markets={markets} />

      <h2>Oracle overrides</h2>
      <div className="row hold-row">
        <span>Set a price and hold the feed for</span>
        <hold.Field name="seconds" validators={{ onChange: ({ value }) => holdError(value) }}>
          {(f) => (
            <Input
              field={f}
              className="mono"
              style={{ width: 70 }}
              inputMode="numeric"
              aria-label="Hold seconds"
            />
          )}
        </hold.Field>
        <span>seconds (0 = the feed takes over on its next poll).</span>
      </div>
      <p>When the hold ends, the live feed snaps the price back. That's a wick, scenario C.</p>
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
                    <PriceForm
                      market={m}
                      holdSeconds={holdSeconds}
                      onRelease={() =>
                        call("/api/admin/release", { market: m.id }, `${m.id} released to feed`)
                      }
                    />
                  )}
                </td>
                <td>
                  {!m.curve && m.status === "open" && (
                    <div className="row" style={{ gap: 4 }}>
                      {(m.kind === "binary" ? [0.2, 0.5, 1.5] : [0.7, 0.85, 1.15, 1.4]).map((f) => (
                        <button
                          type="button"
                          key={f}
                          className={`btn small ${f < 1 ? "danger" : ""}`}
                          onClick={() => gap(m, f)}
                        >
                          {f < 1
                            ? `−${Math.round((1 - f) * 100)}%`
                            : `+${Math.round((f - 1) * 100)}%`}
                        </button>
                      ))}
                    </div>
                  )}
                </td>
                <td>
                  {m.resolvable && m.status === "open" && (
                    <div className="row" style={{ gap: 4 }}>
                      <button
                        type="button"
                        className="btn small"
                        onClick={() =>
                          confirm(`Resolve ${m.id} at 0?`) &&
                          call(
                            "/api/admin/resolve",
                            { market: m.id, price: "0" },
                            `${m.id} resolved 0`,
                          )
                        }
                      >
                        → 0
                      </button>
                      <button
                        type="button"
                        className="btn small"
                        onClick={() =>
                          confirm(`Resolve ${m.id} at 1?`) &&
                          call(
                            "/api/admin/resolve",
                            { market: m.id, price: "1" },
                            `${m.id} resolved 1`,
                          )
                        }
                      >
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

      <MirrorMarket />

      <CreateMarket />

      <h2>House bots</h2>
      {status?.bots ? (
        <div className="col">
          <div className="row">
            <span>
              Bots are{" "}
              {status.bots.enabled ? (
                <b className="up">running</b>
              ) : (
                <b className="muted">paused</b>
              )}
            </span>
            <button
              type="button"
              className="btn small"
              onClick={() =>
                call(
                  "/api/admin/bots",
                  { enabled: !status.bots!.enabled },
                  status.bots!.enabled ? "bots paused" : "bots running",
                )
              }
            >
              {status.bots.enabled ? "Pause" : "Resume"}
            </button>
          </div>
          <div className="faint">
            {status.bots.accounts.map((a) => `${a.id} ${usd(a.wallet)}`).join(" · ")}
          </div>
        </div>
      ) : (
        <p>
          {status ? "Bots are disabled on this server (BOTS=0)." : "Authorize to see bot status."}
        </p>
      )}

      <Deposit />
    </div>
  );
}

/** A form element that submits through TanStack Form. */
function FormBox({
  form,
  className,
  children,
}: {
  form: { handleSubmit: () => Promise<void> };
  className?: string;
  children: ReactNode;
}) {
  return (
    <form
      className={className}
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void form.handleSubmit();
      }}
    >
      {children}
    </form>
  );
}

function Select({
  field,
  list,
  empty,
  label,
}: {
  field: AnyFieldApi;
  list: MarketView[];
  empty: string;
  label?: (m: MarketView) => string;
}) {
  return (
    <div className="field-wrap">
      <select
        className={`input ${invalid(field) ? "bad" : ""}`}
        value={pick(field.state.value as string, list)}
        onChange={(e) => field.handleChange(e.target.value)}
        onBlur={field.handleBlur}
        disabled={!list.length}
      >
        {list.length === 0 && <option value="">{empty}</option>}
        {list.map((m) => (
          <option key={m.id} value={m.id}>
            {label ? label(m) : m.id}
          </option>
        ))}
      </select>
      <FieldError field={field} />
    </div>
  );
}

function TokenForm({ authorized, onSaved }: { authorized: boolean; onSaved: () => void }) {
  const form = useForm({
    defaultValues: { token: getAdminToken() },
    onSubmit: ({ value }) => {
      setAdminToken(value.token.trim());
      onSaved();
    },
  });
  return (
    <FormBox form={form} className="row token-form">
      <form.Field
        name="token"
        validators={{
          onChange: ({ value }) => (value.trim() ? undefined : "Enter the admin token"),
        }}
      >
        {(f) => (
          <Input
            field={f}
            className="mono"
            type="password"
            placeholder="admin token"
            aria-label="Admin token"
            wrap={{ flex: 1 }}
          />
        )}
      </form.Field>
      <button type="submit" className="btn">
        Save
      </button>
      <span className={authorized ? "up" : "muted"}>
        {authorized ? "authorized" : "not authorized"}
      </span>
    </FormBox>
  );
}

function PriceForm({
  market: m,
  holdSeconds,
  onRelease,
}: {
  market: MarketView;
  holdSeconds: number;
  onRelease: () => void;
}) {
  const toast = useToast();
  const server = useServerError();
  const form = useForm({
    defaultValues: { price: "" },
    onSubmit: async ({ value, formApi }) => {
      server.clear();
      try {
        await adminPost("/api/admin/price", { market: m.id, price: value.price, holdSeconds });
        toast(`${m.id} set to ${value.price}`, "up");
        formApi.reset();
      } catch (e) {
        server.fail(e);
      }
    },
  });
  const pending = useSelector(form.store, (s) => s.isSubmitting);
  return (
    <FormBox form={form} className="row price-form">
      <form.Field
        name="price"
        validators={{
          onChange: ({ value }) => {
            if (m.kind === "binary") {
              if (!value.trim() || !(Number(value) >= 0 && Number(value) <= 1))
                return "Between 0 and 1";
              return undefined;
            }
            return positive(value, "Price");
          },
        }}
      >
        {(f) => (
          <Input
            field={f}
            className="mono"
            style={{ width: 110 }}
            placeholder={m.mark ?? ""}
            inputMode="decimal"
            aria-label={`New price for ${m.id}`}
          />
        )}
      </form.Field>
      <button type="submit" className="btn small" disabled={pending || m.status !== "open"}>
        Set
      </button>
      {m.heldUntil && (
        <button type="button" className="btn small ghost" onClick={onRelease}>
          Release
        </button>
      )}
      <FormError error={server.error} />
    </FormBox>
  );
}

function MirrorMarket() {
  const toast = useToast();
  const pmServer = useServerError();
  const hlServer = useServerError();
  const pm = useForm({
    defaultValues: { ref: "" },
    onSubmit: async ({ value, formApi }) => {
      pmServer.clear();
      try {
        await adminPost("/api/admin/polymarket", { ref: value.ref.trim() });
        toast(`listed ${value.ref}`, "up");
        formApi.reset();
      } catch (e) {
        pmServer.fail(e);
      }
    },
  });
  const hl = useForm({
    defaultValues: { coin: "" },
    onSubmit: async ({ value, formApi }) => {
      hlServer.clear();
      try {
        await adminPost("/api/admin/hyperliquid", { coin: value.coin.trim() });
        toast(`listed ${value.coin}`, "up");
        formApi.reset();
      } catch (e) {
        hlServer.fail(e);
      }
    },
  });
  const pmPending = useSelector(pm.store, (s) => s.isSubmitting);
  const hlPending = useSelector(hl.store, (s) => s.isSubmitting);
  return (
    <>
      <h2>Mirror a live market</h2>
      <p>
        List any Polymarket market (paste its market URL, slug or id) or any Hyperliquid perp (a
        coin, or <code>xyz:TSLA</code> for a HIP-3 market). The venue's price becomes the oracle;
        the order book here is Impulse's own.
      </p>
      <div className="row mirror-forms">
        <FormBox form={pm} className="row grow">
          <pm.Field
            name="ref"
            validators={{
              onChange: ({ value }) =>
                value.trim() ? undefined : "Paste a market URL, slug or id",
            }}
          >
            {(f) => (
              <Input
                field={f}
                placeholder="polymarket.com/market/… or id"
                aria-label="Polymarket market"
                wrap={{ flex: "2 1 260px" }}
              />
            )}
          </pm.Field>
          <button type="submit" className="btn" disabled={pmPending}>
            Mirror Polymarket
          </button>
          <FormError error={pmServer.error} />
        </FormBox>
        <FormBox form={hl} className="row grow">
          <hl.Field
            name="coin"
            validators={{
              onChange: ({ value }) =>
                /^[A-Za-z0-9:]{1,24}$/.test(value.trim())
                  ? undefined
                  : "A coin like DOGE, or xyz:TSLA",
            }}
          >
            {(f) => (
              <Input
                field={f}
                className="mono"
                placeholder="DOGE or xyz:TSLA"
                aria-label="Hyperliquid coin"
                wrap={{ flex: "1 1 140px" }}
              />
            )}
          </hl.Field>
          <button type="submit" className="btn" disabled={hlPending}>
            Mirror Hyperliquid
          </button>
          <FormError error={hlServer.error} />
        </FormBox>
      </div>
    </>
  );
}

/** Validates a minutes field: blank, or a number 0 or more. */
const minutes = (v: string, what: string) =>
  v.trim() === "" || (Number(v) >= 0 && Number.isFinite(Number(v)))
    ? undefined
    : `${what} must be 0 or more minutes`;

/** Validates a market picker: something from the list must be picked. */
const marketRequired =
  (list: MarketView[], what: string) =>
  ({ value }: { value: string }) =>
    pick(value, list) ? undefined : `No ${what} to pick`;

function CreateMarket() {
  const toast = useToast();
  const server = useServerError();
  const form = useForm({
    defaultValues: {
      id: "",
      name: "",
      kind: "binary" as "binary" | "perp",
      price: "0.5",
      resolvesInMinutes: "30",
      taperMinutes: "10",
      adl: "pnl" as "pnl" | "size",
      volBps: "20",
    },
    onSubmit: async ({ value: f, formApi }) => {
      server.clear();
      try {
        await adminPost("/api/admin/market", {
          id: f.id,
          name: f.name || f.id,
          kind: f.kind,
          price: f.price,
          adl: f.adl,
          ...(f.kind === "binary"
            ? {
                ...(num(f.resolvesInMinutes) > 0 && {
                  resolvesInMinutes: num(f.resolvesInMinutes),
                }),
                ...(num(f.taperMinutes) > 0 &&
                  num(f.resolvesInMinutes) > 0 && { taperMinutes: num(f.taperMinutes) }),
              }
            : { szDecimals: 2, volBps: num(f.volBps) }),
        });
        toast(`listed ${f.id}`, "up");
        formApi.reset();
      } catch (e) {
        server.fail(e);
      }
    },
  });
  const kind = useSelector(form.store, (s) => s.values.kind);
  const pending = useSelector(form.store, (s) => s.isSubmitting);
  return (
    <>
      <h2>List a market</h2>
      <p>
        Binary markets move only when you set the price here, and can resolve on a schedule with a
        taper. Perps follow a random walk.
      </p>
      <FormBox form={form} className="panel panel-body create-market">
        <form.Field
          name="id"
          validators={{
            onChange: ({ value }) =>
              /^[A-Za-z0-9_-]{2,32}$/.test(value) ? undefined : "2–32 letters, digits, - or _",
          }}
        >
          {(f) => (
            <div className="field">
              <label htmlFor={`create-${f.name}`}>Id</label>
              <Input field={f} id={`create-${f.name}`} placeholder="ELECTION-24" />
            </div>
          )}
        </form.Field>
        <form.Field name="name">
          {(f) => (
            <div className="field">
              <label htmlFor={`create-${f.name}`}>Name</label>
              <Input field={f} id={`create-${f.name}`} placeholder="Will X happen?" />
            </div>
          )}
        </form.Field>
        <form.Field name="kind">
          {(f) => (
            <div className="field">
              <label htmlFor={`create-${f.name}`}>Kind</label>
              <select
                id={`create-${f.name}`}
                className="input"
                value={f.state.value}
                onChange={(e) => f.handleChange(e.target.value as "binary" | "perp")}
              >
                <option value="binary">binary</option>
                <option value="perp">perp (random walk)</option>
              </select>
            </div>
          )}
        </form.Field>
        <form.Field
          name="price"
          validators={{
            onChangeListenTo: ["kind"],
            onChange: ({ value, fieldApi }) => {
              const bad = positive(value, "Start price");
              if (bad) return bad;
              if (fieldApi.form.getFieldValue("kind") === "binary" && !(Number(value) < 1))
                return "A binary starts between 0 and 1";
              return undefined;
            },
          }}
        >
          {(f) => (
            <div className="field">
              <label htmlFor={`create-${f.name}`}>Start price</label>
              <Input field={f} id={`create-${f.name}`} className="mono" inputMode="decimal" />
            </div>
          )}
        </form.Field>
        {kind === "binary" ? (
          <>
            <form.Field
              name="resolvesInMinutes"
              validators={{ onChange: ({ value }) => minutes(value, "Resolution") }}
            >
              {(f) => (
                <div className="field">
                  <label htmlFor={`create-${f.name}`}>Resolves in (min)</label>
                  <Input
                    id={`create-${f.name}`}
                    field={f}
                    className="mono"
                    placeholder="blank = whenever"
                    inputMode="decimal"
                  />
                </div>
              )}
            </form.Field>
            <form.Field
              name="taperMinutes"
              validators={{
                onChangeListenTo: ["resolvesInMinutes"],
                onChange: ({ value, fieldApi }) => {
                  const bad = minutes(value, "Taper");
                  if (bad) return bad;
                  const r = num(fieldApi.form.getFieldValue("resolvesInMinutes"));
                  if (num(value) > 0 && r > 0 && num(value) > r)
                    return "Taper can't be longer than the time to resolution";
                  return undefined;
                },
              }}
            >
              {(f) => (
                <div className="field">
                  <label htmlFor={`create-${f.name}`}>Taper (min)</label>
                  <Input
                    field={f}
                    id={`create-${f.name}`}
                    className="mono"
                    placeholder="0 = none"
                    inputMode="decimal"
                  />
                </div>
              )}
            </form.Field>
          </>
        ) : (
          <form.Field
            name="volBps"
            validators={{ onChange: ({ value }) => positive(value, "Volatility") }}
          >
            {(f) => (
              <div className="field">
                <label htmlFor={`create-${f.name}`}>Volatility / step (bps)</label>
                <Input field={f} id={`create-${f.name}`} className="mono" inputMode="decimal" />
              </div>
            )}
          </form.Field>
        )}
        <form.Field name="adl">
          {(f) => (
            <div className="field">
              <label htmlFor={`create-${f.name}`}>ADL rule</label>
              <select
                id={`create-${f.name}`}
                className="input"
                value={f.state.value}
                onChange={(e) => f.handleChange(e.target.value as "pnl" | "size")}
              >
                <option value="pnl">capped PnL</option>
                <option value="size">size pro-rata</option>
              </select>
            </div>
          )}
        </form.Field>
        <div className="field" style={{ justifyContent: "flex-end" }}>
          <button type="submit" className="btn primary" disabled={pending}>
            List
          </button>
        </div>
        <div style={{ gridColumn: "1 / -1" }}>
          <FormError error={server.error} />
        </div>
      </FormBox>
    </>
  );
}

function Deposit() {
  const toast = useToast();
  const server = useServerError();
  const form = useForm({
    defaultValues: { account: "", amount: "10000" },
    onSubmit: async ({ value, formApi }) => {
      server.clear();
      try {
        await adminPost("/api/admin/deposit", {
          account: value.account.trim(),
          amount: value.amount,
        });
        toast(`deposited $${value.amount} to ${value.account}`, "up");
        formApi.reset();
      } catch (e) {
        server.fail(e);
      }
    },
  });
  const pending = useSelector(form.store, (s) => s.isSubmitting);
  return (
    <>
      <h2>Deposit paper USDC</h2>
      <FormBox form={form} className="row deposit-form">
        <form.Field
          name="account"
          validators={{ onChange: ({ value }) => (value.trim() ? undefined : "Which account?") }}
        >
          {(f) => <Input field={f} placeholder="account" aria-label="Account" />}
        </form.Field>
        <form.Field
          name="amount"
          validators={{ onChange: ({ value }) => positive(value, "Amount") }}
        >
          {(f) => (
            <Input
              field={f}
              className="mono"
              placeholder="amount"
              inputMode="decimal"
              aria-label="Amount"
            />
          )}
        </form.Field>
        <button type="submit" className="btn" disabled={pending}>
          Deposit
        </button>
        <FormError error={server.error} />
      </FormBox>
    </>
  );
}

type Effects = { title: string; lines: string[]; time: number };

/** The demo in a few clicks: launch a coin, pump or dump it, crash a market, list and IPO a pre-IPO, resolve a binary. */
function DemoControls({ markets }: { markets: MarketView[] }) {
  const toast = useToast();
  const navigate = useNavigate();
  const [last, setLast] = useState<Effects | null>(null);
  const live = markets.filter((m) => m.kind === "attention" && m.status === "open" && !m.snipe);
  const crashable = markets.filter((m) => !m.curve && m.status === "open" && m.mark);
  const privates = markets.filter((m) => m.preipo?.status === "private");
  const binaries = markets.filter((m) => m.kind === "binary" && m.status === "open");

  /** Post an admin action and list the effects it returns. Throws, so each form can show the error itself. */
  async function run<T>(title: string, path: string, body: Record<string, unknown>): Promise<T> {
    const r = await adminPost<T>(path, body);
    const effects = (r as { effects?: string[] } | null)?.effects;
    // oxlint-disable-next-line react/purity -- run() is only called from submit handlers, never during render
    setLast({ title, lines: Array.isArray(effects) ? effects : [], time: Date.now() });
    toast(title, "up");
    return r;
  }

  const coinServer = useServerError();
  const coin = useForm({
    defaultValues: { handle: "" },
    onSubmit: async ({ value, formApi }) => {
      coinServer.clear();
      try {
        const m = await run<MarketView>(
          "Demo coin listed",
          "/api/admin/demo-coin",
          value.handle ? { handle: value.handle } : {},
        );
        formApi.reset();
        if (m?.id) void navigate({ to: "/trade/$market", params: { market: m.id } });
      } catch (e) {
        coinServer.fail(e);
      }
    },
  });

  const pumpServer = useServerError();
  const pump = useForm({
    defaultValues: { market: "", usdc: "5000", dir: "up" as "up" | "down" },
    onSubmit: async ({ value }) => {
      pumpServer.clear();
      const id = pick(value.market, live);
      try {
        await run(`${value.dir === "up" ? "Pumped" : "Dumped"} ${id}`, "/api/admin/pump", {
          market: id,
          usdc: `${value.dir === "down" ? "-" : ""}${value.usdc}`,
        });
      } catch (e) {
        pumpServer.fail(e);
      }
    },
  });

  const crashServer = useServerError();
  const crash = useForm({
    defaultValues: { market: "", factor: 0.5 },
    onSubmit: async ({ value }) => {
      crashServer.clear();
      const m = crashable.find((x) => x.id === pick(value.market, crashable));
      if (!m) return;
      const p = num(m.mark) * value.factor;
      const v = m.kind === "binary" ? Math.min(1, Math.max(0, p)) : p;
      try {
        await run(`${m.id} → ${toInput(v, m.priceDecimals)}`, "/api/admin/price", {
          market: m.id,
          price: toInput(v, 9),
          holdSeconds: 60,
        });
      } catch (e) {
        crashServer.fail(e);
      }
    },
  });

  const preServer = useServerError();
  const pre = useForm({
    defaultValues: { id: "", name: "", price: "", description: "" },
    onSubmit: async ({ value, formApi }) => {
      preServer.clear();
      try {
        await run<MarketView>(`Listed ${value.id}`, "/api/admin/preipo", {
          id: value.id,
          name: value.name || value.id,
          price: value.price,
          ...(value.description && { description: value.description }),
        });
        formApi.reset();
      } catch (e) {
        preServer.fail(e);
      }
    },
  });

  const ipoServer = useServerError();
  const ipo = useForm({
    defaultValues: { market: "", price: "" },
    onSubmit: async ({ value, formApi }) => {
      ipoServer.clear();
      const id = pick(value.market, privates);
      try {
        await run(`${id} IPO at ${value.price}`, "/api/admin/ipo", {
          market: id,
          price: value.price,
        });
        formApi.reset();
      } catch (e) {
        ipoServer.fail(e);
      }
    },
  });

  const resolveServer = useServerError();
  const resolve = useForm({
    defaultValues: { market: "", outcome: "1" as "0" | "1" },
    onSubmit: async ({ value }) => {
      resolveServer.clear();
      const id = pick(value.market, binaries);
      if (!confirm(`Resolve ${id} at ${value.outcome}?`)) return;
      try {
        await run(`${id} resolved ${value.outcome}`, "/api/admin/resolve", {
          market: id,
          price: value.outcome,
        });
      } catch (e) {
        resolveServer.fail(e);
      }
    },
  });

  const pending = {
    coin: useSelector(coin.store, (s) => s.isSubmitting),
    pump: useSelector(pump.store, (s) => s.isSubmitting),
    crash: useSelector(crash.store, (s) => s.isSubmitting),
    pre: useSelector(pre.store, (s) => s.isSubmitting),
    ipo: useSelector(ipo.store, (s) => s.isSubmitting),
    resolve: useSelector(resolve.store, (s) => s.isSubmitting),
  };
  const usdc = useSelector(pump.store, (s) => s.values.usdc);
  return (
    <>
      <h2>Demo</h2>
      <div className="demo-grid">
        <FormBox form={coin} className="panel panel-body col">
          <h3>Launch a demo coin</h3>
          <p className="small">Lists a creator coin with a snipe window and a few house snipes.</p>
          <div className="row top">
            <coin.Field
              name="handle"
              validators={{
                onChange: ({ value }) =>
                  value.trim() === "" || HANDLE.test(value.trim())
                    ? undefined
                    : "2–20 letters, digits or _",
              }}
            >
              {(f) => (
                <Input
                  field={f}
                  placeholder="@handle (blank = random)"
                  aria-label="Demo coin handle"
                  wrap={{ flex: 1 }}
                />
              )}
            </coin.Field>
            <button type="submit" className="btn primary" disabled={pending.coin}>
              Launch
            </button>
          </div>
          <FormError error={coinServer.error} />
        </FormBox>

        <FormBox form={pump} className="panel panel-body col">
          <h3>Pump or dump a creator coin</h3>
          <p className="small">A house account buys or sells spot on the curve.</p>
          <div className="row top">
            <pump.Field name="market" validators={{ onSubmit: marketRequired(live, "live coin") }}>
              {(f) => <Select field={f} list={live} empty="no live coins" />}
            </pump.Field>
            <pump.Field
              name="usdc"
              validators={{ onChange: ({ value }) => positive(value, "Amount") }}
            >
              {(f) => (
                <Input
                  field={f}
                  className="mono"
                  inputMode="decimal"
                  aria-label="USDC"
                  wrap={{ width: 120 }}
                />
              )}
            </pump.Field>
          </div>
          <div className="row">
            <button
              type="submit"
              className="btn buy grow"
              disabled={pending.pump}
              onClick={() => pump.setFieldValue("dir", "up")}
            >
              Pump +${usdc}
            </button>
            <button
              type="submit"
              className="btn sell grow"
              disabled={pending.pump}
              onClick={() => pump.setFieldValue("dir", "down")}
            >
              Dump −${usdc}
            </button>
          </div>
          <FormError error={pumpServer.error} />
        </FormBox>

        <FormBox form={crash} className="panel panel-body col">
          <h3>Crash a market</h3>
          <p className="small">
            Forces the oracle and holds it for 60 s. Longs past their bankruptcy price go bust and
            the shorts pay.
          </p>
          <crash.Field name="market" validators={{ onSubmit: marketRequired(crashable, "market") }}>
            {(f) => (
              <Select
                field={f}
                list={crashable}
                empty="no markets"
                label={(m) => (m.kind === "binary" ? `${m.id} · ${m.name}` : m.id)}
              />
            )}
          </crash.Field>
          <div className="row">
            {[0.5, 0.7, 1.3, 1.6].map((f) => (
              <button
                key={f}
                type="submit"
                className={`btn small grow ${f < 1 ? "danger" : ""}`}
                disabled={pending.crash}
                onClick={() => crash.setFieldValue("factor", f)}
              >
                {f < 1 ? `−${Math.round((1 - f) * 100)}%` : `+${Math.round((f - 1) * 100)}%`}
              </button>
            ))}
          </div>
          <FormError error={crashServer.error} />
        </FormBox>

        <FormBox form={pre} className="panel panel-body col">
          <h3>List a pre-IPO market</h3>
          <div className="row top">
            <pre.Field
              name="id"
              validators={{
                onChange: ({ value }) =>
                  /^[A-Z0-9_-]{2,32}$/.test(value) ? undefined : "2–32 capitals, digits, - or _",
              }}
            >
              {(f) => (
                <Input
                  field={f}
                  className="mono"
                  placeholder="ID-PRE"
                  aria-label="Market id"
                  transform={(v) => v.toUpperCase().trim()}
                  wrap={{ flex: 1 }}
                />
              )}
            </pre.Field>
            <pre.Field
              name="price"
              validators={{ onChange: ({ value }) => positive(value, "Seed price") }}
            >
              {(f) => (
                <Input
                  field={f}
                  className="mono"
                  placeholder="seed price"
                  inputMode="decimal"
                  aria-label="Seed price"
                  wrap={{ flex: 1 }}
                />
              )}
            </pre.Field>
          </div>
          <pre.Field
            name="name"
            validators={{
              onChange: ({ value }) => (value.trim() ? undefined : "Name the company"),
            }}
          >
            {(f) => <Input field={f} placeholder="Company name" aria-label="Company name" />}
          </pre.Field>
          <pre.Field name="description">
            {(f) => (
              <Input field={f} placeholder="Description (optional)" aria-label="Description" />
            )}
          </pre.Field>
          <button type="submit" className="btn primary" disabled={pending.pre}>
            List pre-IPO
          </button>
          <FormError error={preServer.error} />
        </FormBox>

        <FormBox form={ipo} className="panel panel-body col">
          <h3>IPO a pre-IPO market</h3>
          <p className="small">
            Reprices it in one step to the IPO price. Whoever is on the wrong side of the gap pays.
          </p>
          <div className="row top">
            <ipo.Field
              name="market"
              validators={{ onSubmit: marketRequired(privates, "private market") }}
            >
              {(f) => <Select field={f} list={privates} empty="no private markets" />}
            </ipo.Field>
            <ipo.Field
              name="price"
              validators={{ onChange: ({ value }) => positive(value, "IPO price") }}
            >
              {(f) => (
                <Input
                  field={f}
                  className="mono"
                  placeholder={privates[0]?.mark ?? "price"}
                  inputMode="decimal"
                  aria-label="IPO price"
                  wrap={{ width: 120 }}
                />
              )}
            </ipo.Field>
          </div>
          <button type="submit" className="btn primary" disabled={pending.ipo || !privates.length}>
            IPO
          </button>
          <FormError error={ipoServer.error} />
        </FormBox>

        <FormBox form={resolve} className="panel panel-body col">
          <h3>Resolve a binary</h3>
          <resolve.Field
            name="market"
            validators={{ onSubmit: marketRequired(binaries, "open binary") }}
          >
            {(f) => (
              <Select
                field={f}
                list={binaries}
                empty="no open binaries"
                label={(m) => `${m.id} · ${m.name}`}
              />
            )}
          </resolve.Field>
          <div className="row">
            {(["0", "1"] as const).map((p) => (
              <button
                key={p}
                type="submit"
                className="btn grow"
                disabled={pending.resolve || !binaries.length}
                onClick={() => resolve.setFieldValue("outcome", p)}
              >
                {p === "1" ? "YES → 1" : "NO → 0"}
              </button>
            ))}
          </div>
          <FormError error={resolveServer.error} />
        </FormBox>
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
