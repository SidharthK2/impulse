// Creator coin launch: the snipe window before the open, and the launch facts after it.

import { useForm, useSelector } from "@tanstack/react-form";
import { useLayoutEffect, useRef } from "react";
import { ago, compact, countdown, num, price, usd } from "../format";
import { useNow } from "../hooks";
import { act } from "../queries";
import type { AccountView, MarketView } from "../types";
import { FieldError, FormError, invalid, positive, useServerError } from "./form";
import { Roll } from "./Roll";
import { useToast } from "./ui";

const QUICK = [50, 250, 1000];

export function SnipePanel({
  market,
  account,
  canTrade,
  onSignUp,
}: {
  market: MarketView;
  account: AccountView | undefined;
  canTrade: boolean;
  onSignUp: () => void;
}) {
  const toast = useToast();
  const now = useNow(250);
  const server = useServerError();
  const s = market.snipe!;
  // The latest values, for the submit handler.
  const latest = { opensAt: s.opensAt, wallet: account?.wallet ?? null };
  const live = useRef(latest);
  useLayoutEffect(() => {
    live.current = latest;
  });
  const form = useForm({
    defaultValues: { usdc: "" },
    onSubmit: async ({ value, formApi }) => {
      server.clear();
      try {
        await act("POST", "/api/snipe", { market: market.id, usdc: value.usdc });
        toast(`Sniped ${usd(value.usdc)} of ${market.id}`, "up");
        formApi.reset();
      } catch (e) {
        server.fail(e);
      }
    },
  });
  const pending = useSelector(form.store, (st) => st.isSubmitting);
  const left = s.opensAt - now;
  const open = left <= 0;
  const window = Math.max(1, s.opensAt - market.createdAt);
  const elapsed = Math.min(1, Math.max(0, 1 - left / window));
  const mine = (account?.snipes ?? [])
    .filter((x) => x.market === market.id)
    .reduce((t, x) => t + num(x.usdc), 0);
  const share = num(s.total) > 0 ? mine / num(s.total) : 0;
  const d = Math.max(market.priceDecimals, 6);

  return (
    <div className="panel chart-panel snipe-panel">
      <div className="panel-head">
        <h3>Snipe window</h3>
        <span className="spacer" />
        <span className="chip snipe">
          <i className="pulse" /> {open ? "opening…" : "bids open"}
        </span>
      </div>
      <div className="snipe-body">
        <div className="snipe-clock">
          <div className="label">{open ? "Opening now" : "Opens in"}</div>
          <div className="countdown mono">{open ? "0s" : countdown(left)}</div>
          <div className="bar">
            <i style={{ width: `${elapsed * 100}%`, background: "var(--warn)" }} />
          </div>
          <div className="faint small">
            {new Date(s.opensAt).toLocaleTimeString("en-US", { hour12: false })} · every bid fills
            at one open price, so being first doesn't cost more
          </div>
        </div>

        <div className="snipe-stats">
          <div className="stat-tile">
            <span className="label">Total bid</span>
            <Roll className="v mono" text={usd(s.total)} value={num(s.total)} />
          </div>
          <div className="stat-tile">
            <span className="label">Snipers</span>
            <span className="v mono">{s.snipers}</span>
          </div>
          <div className="stat-tile">
            <span className="label" title="Where the curve opens once the whole pool buys">
              Projected open
            </span>
            <Roll
              className="v mono"
              text={price(s.projectedOpenPrice, d)}
              value={num(s.projectedOpenPrice)}
            />
          </div>
          <div className="stat-tile">
            <span className="label">Your bid</span>
            <span className="v mono">
              {mine > 0 ? usd(mine) : "—"}
              {mine > 0 && (
                <small className="faint block">{(share * 100).toFixed(1)}% of the pool</small>
              )}
            </span>
          </div>
        </div>

        <form
          className="snipe-form"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            if (!canTrade) return onSignUp();
            void form.handleSubmit();
          }}
        >
          <form.Field
            name="usdc"
            validators={{
              onChange: ({ value }) => {
                const bad = positive(value, "Amount");
                if (bad) return bad;
                const { wallet, opensAt } = live.current;
                if (wallet !== null && num(value) > num(wallet))
                  return `More than your wallet (${usd(wallet)})`;
                if (Date.now() >= opensAt) return "The snipe window has closed";
                return undefined;
              },
            }}
          >
            {(f) => (
              <div className="snipe-input grow">
                <div className="adorn">
                  <span className="prefix">$</span>
                  <input
                    className={`input mono ${invalid(f) ? "bad" : ""}`}
                    inputMode="decimal"
                    placeholder="USDC to bid"
                    value={f.state.value}
                    onChange={(e) => f.handleChange(e.target.value.trim())}
                    onBlur={f.handleBlur}
                    aria-label="Snipe amount in USDC"
                    aria-invalid={invalid(f)}
                    disabled={open}
                  />
                </div>
                <FieldError field={f} />
              </div>
            )}
          </form.Field>
          {QUICK.map((q) => (
            <button
              key={q}
              type="button"
              className="btn small ghost"
              onClick={() => form.setFieldValue("usdc", String(q))}
              disabled={open}
            >
              ${compact(q)}
            </button>
          ))}
          <button type="submit" className="btn primary" disabled={open || pending}>
            {!canTrade
              ? "Sign up to snipe"
              : pending
                ? "Bidding…"
                : mine > 0
                  ? "Add to bid"
                  : "Snipe"}
          </button>
          <FormError error={server.error} />
        </form>

        <div className="snipe-lists">
          <div>
            <div className="label">Top snipes</div>
            <SnipeRows rows={s.top} total={num(s.total)} me={account?.id} />
          </div>
          <div>
            <div className="label">Recent</div>
            <SnipeRows rows={s.recent} total={num(s.total)} me={account?.id} now={now} />
          </div>
        </div>
      </div>
    </div>
  );
}

function SnipeRows({
  rows,
  total,
  me,
  now,
}: {
  rows: { account: string; usdc: string; time?: number }[];
  total: number;
  me?: string;
  now?: number;
}) {
  if (rows.length === 0)
    return (
      <div className="faint small" style={{ padding: "8px 0" }}>
        No bids yet.
      </div>
    );
  return (
    <div className="snipe-rows">
      {rows.map((r, i) => (
        <div
          key={`${r.account}-${r.time ?? i}`}
          className={`snipe-row ${r.account === me ? "me" : ""}`}
        >
          <span className="who">
            {r.account}
            {r.account === me && <span className="badge up">you</span>}
          </span>
          {now === undefined ? (
            <span className="bar grow">
              <i
                style={{
                  width: `${total > 0 ? (num(r.usdc) / total) * 100 : 0}%`,
                  background: "var(--warn)",
                }}
              />
            </span>
          ) : (
            <span className="faint small grow right">{ago(r.time!, now)}</span>
          )}
          <span className="mono">{usd(r.usdc)}</span>
        </div>
      ))}
    </div>
  );
}

/** After the open: what the snipe pool became. */
export function LaunchPanel({ market }: { market: MarketView }) {
  const now = useNow(5000);
  const l = market.launch!;
  const since = num(market.mark) / num(l.openPrice) - 1;
  const d = Math.max(market.priceDecimals, 6);
  return (
    <div className="panel">
      <div className="panel-head">
        <h3>Launch</h3>
        <span className="spacer" />
        <span className="faint small">opened {ago(l.openedAt, now)}</span>
      </div>
      <div className="panel-body">
        <dl className="kv">
          <dt>Open price</dt>
          <dd>{price(l.openPrice, d)}</dd>
          <dt>Since open</dt>
          <dd className={since > 0 ? "up" : since < 0 ? "down" : ""}>
            {Number.isFinite(since)
              ? `${since >= 0 ? "+" : "−"}${Math.abs(since * 100).toFixed(1)}%`
              : "—"}
          </dd>
          <dt>Sniped</dt>
          <dd>{usd(l.sniped)}</dd>
          <dt title="USDC the snipe pool left in the curve">Launch reserve</dt>
          <dd>{usd(l.reserve)}</dd>
          <dt>Tokens sold at open</dt>
          <dd>{compact(l.tokensSold)}</dd>
        </dl>
      </div>
    </div>
  );
}
