import { useForm, useSelector } from "@tanstack/react-form";
import { useDebouncedValue } from "@tanstack/react-pacer";
import { useEffect, useRef, useState } from "react";
import { num, price as fmtPrice, size as fmtSize, toInput, usd } from "../format";
import { act } from "../queries";
import { usePrefs } from "../store";
import type { AccountView, FillView, MarketView, PositionView } from "../types";
import {
  FieldError,
  FormError,
  decimals,
  invalid,
  multipleOf,
  positive,
  useServerError,
} from "./form";
import { useToast } from "./ui";

interface Props {
  market: MarketView;
  account: AccountView | undefined;
  signedIn: boolean;
  picked: { price: string; n: number } | null;
  onSignUp: () => void;
  /** Which side the form opens on (the phone layout opens it from Long or Short). */
  initialSide?: Side;
  /** Called after an order was accepted (filled, partly filled or resting): the phone sheet closes. */
  onDone?: () => void;
}

type Side = "buy" | "sell";

interface Values {
  side: Side;
  type: "market" | "limit";
  price: string;
  size: string;
  unit: "usd" | "coin";
  leverage: number;
  reduceOnly: boolean;
  postOnly: boolean;
}

const floorTo = (v: number, d: number) => Math.floor(v * 10 ** d + 1e-9) / 10 ** d;

/** The reference price for sizing: the limit price, or the touch (falling back to the mark) for a market order. */
function refPrice(m: MarketView, v: Pick<Values, "side" | "type" | "price">): number {
  if (v.type === "limit") return num(v.price);
  const touch = v.side === "buy" ? num(m.bestAsk) : num(m.bestBid);
  return Number.isFinite(touch) ? touch : num(m.mark);
}

/** Size in coins, floored to the market's lot. */
function coins(m: MarketView, v: Values): number {
  const ref = refPrice(m, v);
  return v.unit === "coin"
    ? floorTo(num(v.size), m.szDecimals)
    : Number.isFinite(ref) && ref > 0
      ? floorTo(num(v.size) / ref, m.szDecimals)
      : NaN;
}

export function OrderForm({
  market,
  account,
  signedIn,
  picked,
  onSignUp,
  initialSide = "buy",
  onDone,
}: Props) {
  const toast = useToast();
  const defaults = usePrefs((s) => s.order);
  const saveDefaults = usePrefs((s) => s.setOrder);
  const server = useServerError();
  const position = account?.positions.find((p) => p.market === market.id && p.side !== "flat");

  // Validators read the live market and position through a ref, so they always check against the latest view.
  const live = useRef({ market, position });
  live.current = { market, position };

  // Stable for the form's life: useForm re-applies changed defaultValues to an untouched form on every render.
  const [initial] = useState<Values>(() => ({
    side: initialSide,
    type: defaults.type,
    price: "",
    size: "",
    unit: defaults.unit,
    leverage: Math.min(defaults.leverage ?? market.maxLeverage, market.maxLeverage),
    reduceOnly: false,
    postOnly: false,
  }));
  const form = useForm({
    defaultValues: initial,
    onSubmit: async ({ value, formApi }) => {
      server.clear();
      const m = live.current.market;
      const size = coins(m, value);
      try {
        const r = await act<{ status: string; reason: string | null; fills: FillView[] }>(
          "POST",
          "/api/orders",
          {
            market: m.id,
            side: value.side,
            type: value.type,
            size: size.toFixed(m.szDecimals),
            ...(value.type === "limit" && {
              price: value.price,
              tif: value.postOnly ? "alo" : "gtc",
            }),
            leverage: value.leverage,
            reduceOnly: value.reduceOnly,
          },
        );
        saveDefaults({ type: value.type, unit: value.unit, leverage: value.leverage });
        const filled = r.fills.reduce((s, f) => s + Number(f.size), 0);
        const avg =
          filled > 0
            ? r.fills.reduce((s, f) => s + Number(f.size) * Number(f.price), 0) / filled
            : 0;
        const verb = value.side === "buy" ? "Bought" : "Sold";
        if (r.status === "filled")
          toast(
            `${verb} ${fmtSize(filled, m.szDecimals)} ${m.base} @ ${fmtPrice(avg, m.priceDecimals)}`,
            "up",
          );
        else if (r.status === "partial")
          toast(
            `${verb} ${fmtSize(filled, m.szDecimals)} @ ${fmtPrice(avg, m.priceDecimals)}; ${value.type === "limit" ? "rest is on the book" : `rest cancelled: ${r.reason}`}`,
            "warn",
          );
        else if (r.status === "resting")
          toast(`Order resting at ${fmtPrice(value.price, m.priceDecimals)}`, "info");
        else toast(`Not filled: ${r.reason ?? "no liquidity"}`, "warn");
        // Start the next order clean: same side, type and leverage, empty size, no leftover errors.
        if (r.status !== "cancelled") {
          formApi.reset({ ...value, size: "" }, { keepDefaultValues: true });
          onDone?.();
        }
      } catch (err) {
        server.fail(err);
      }
    },
  });

  // A new market starts clean, from the saved defaults.
  useEffect(() => {
    form.reset(
      {
        ...form.state.values,
        price: "",
        size: "",
        reduceOnly: false,
        leverage: Math.min(defaults.leverage ?? market.maxLeverage, market.maxLeverage),
      },
      { keepDefaultValues: true },
    );
    server.clear();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [market.id]);

  // The market moved under the form (graduation, a new tick, a position opened or closed): check again. Only
  // fields the user has touched (validateAllFields would mark every field touched and flag empty ones).
  const hasPosition = position?.side ?? "none";
  useEffect(() => {
    for (const name of ["price", "size", "leverage", "reduceOnly"] as const)
      void form.getFieldInfo(name).instance?.validate("change");
  }, [
    form,
    market.maxLeverage,
    market.tick,
    market.bounds[0],
    market.bounds[1],
    market.szDecimals,
    hasPosition,
  ]);

  useEffect(() => {
    if (!picked) return;
    form.setFieldValue("type", "limit");
    form.setFieldValue("price", picked.price);
  }, [picked, form]);

  const v = useSelector(form.store, (s) => s.values);
  const submitting = useSelector(form.store, (s) => s.isSubmitting);

  // The preview (size, notional, margin, liquidation) follows the inputs 150 ms behind, so typing stays smooth.
  // Inputs, validation and submit always use the live values.
  const [pv] = useDebouncedValue(v, { wait: 150 });

  const binary = market.kind === "binary";
  const ref = refPrice(market, pv);
  const sizeCoins = coins(market, pv);
  const lev = pv.leverage;
  const notional = sizeCoins * ref;
  const maxLoss = binary ? sizeCoins * (pv.side === "buy" ? ref : 1 - ref) : Infinity;
  const capped = notional / lev >= maxLoss;
  const margin = capped ? maxLoss * 1.05 : notional / lev;
  const wallet = num(account?.wallet);
  const reducing =
    position &&
    ((position.side === "long" && pv.side === "sell") ||
      (position.side === "short" && pv.side === "buy"));
  const mmLev = market.maintenanceLeverage; // liquidation is at the market's maintenance margin whatever leverage you chose
  const liq = capped
    ? null
    : pv.side === "buy"
      ? (ref * (1 - 1 / lev)) / (1 - 1 / Math.max(mmLev, 1.0001))
      : (ref * (1 + 1 / lev)) / (1 + 1 / Math.max(mmLev, 1.0001));
  const effOnMaxLoss = binary && Number.isFinite(maxLoss) && margin > 0 ? maxLoss / margin : null;

  const setPct = (p: number) => {
    // The live inputs, not the debounced preview values above.
    const liveRef = refPrice(market, v);
    const liveLev = v.leverage;
    if (!Number.isFinite(wallet) || !Number.isFinite(liveRef) || liveRef <= 0) return;
    if (v.reduceOnly && position) {
      form.setFieldValue("unit", "coin");
      form.setFieldValue(
        "size",
        toInput(floorTo(Math.abs(num(position.size)) * p, market.szDecimals), market.szDecimals),
      );
      return;
    }
    const perCoin = binary
      ? Math.min(liveRef / liveLev, (v.side === "buy" ? liveRef : 1 - liveRef) * 1.05)
      : liveRef / liveLev;
    const n = floorTo(((wallet * 0.98) / perCoin) * p, market.szDecimals);
    form.setFieldValue(
      "size",
      v.unit === "coin" ? toInput(n, market.szDecimals) : toInput(n * liveRef, 2),
    );
  };

  const closed = market.status !== "open";
  return (
    <form
      className="panel"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        if (!signedIn) return onSignUp(); // signing up comes before validating an order
        void form.handleSubmit();
      }}
    >
      <div className="panel-head">
        <h3>Trade</h3>
        <span className="spacer" />
        <span className="badge" title="Max leverage now (graduation tier)">
          max {market.maxLeverage}×
        </span>
      </div>
      <div className="panel-body col" style={{ gap: 12 }}>
        <form.Field name="side">
          {(f) => (
            <div className="seg">
              <button
                type="button"
                className={f.state.value === "buy" ? "on buy" : ""}
                onClick={() => f.handleChange("buy")}
              >
                {binary ? `Long ${market.base}` : "Long"}
              </button>
              <button
                type="button"
                className={f.state.value === "sell" ? "on sell" : ""}
                onClick={() => f.handleChange("sell")}
              >
                {binary ? `Short ${market.base}` : "Short"}
              </button>
            </div>
          )}
        </form.Field>
        <form.Field name="type">
          {(f) => (
            <div className="seg">
              <button
                type="button"
                className={f.state.value === "market" ? "on" : ""}
                onClick={() => f.handleChange("market")}
              >
                Market
              </button>
              <button
                type="button"
                className={f.state.value === "limit" ? "on" : ""}
                onClick={() => {
                  f.handleChange("limit");
                  if (!form.getFieldValue("price") && Number.isFinite(num(market.mark)))
                    form.setFieldValue("price", toInput(num(market.mark), market.priceDecimals));
                }}
              >
                Limit
              </button>
            </div>
          )}
        </form.Field>

        {v.type === "limit" && (
          <form.Field
            name="price"
            validators={{
              onChangeListenTo: ["type"],
              onChange: ({ value, fieldApi }) => {
                if (fieldApi.form.getFieldValue("type") !== "limit") return undefined;
                const m = live.current.market;
                const bad = positive(value, "Price");
                if (bad) return bad;
                if (!multipleOf(value, m.tick))
                  return `Price must be a multiple of the tick (${m.tick})`;
                const [lo, hi] = m.bounds;
                if (lo !== null && num(value) < num(lo)) return `Price must be at least ${lo}`;
                if (hi !== null && num(value) > num(hi)) return `Price must be at most ${hi}`;
                return undefined;
              },
            }}
          >
            {(f) => (
              <div className="field">
                <label htmlFor="px">Price</label>
                <div className="adorn">
                  <input
                    id="px"
                    className={`input mono ${invalid(f) ? "bad" : ""}`}
                    inputMode="decimal"
                    value={f.state.value}
                    onChange={(e) => f.handleChange(e.target.value.trim())}
                    onBlur={f.handleBlur}
                    placeholder={market.mark ?? ""}
                    aria-invalid={invalid(f)}
                  />
                  <span>tick {market.tick}</span>
                </div>
                <FieldError field={f} />
              </div>
            )}
          </form.Field>
        )}

        <form.Field
          name="size"
          validators={{
            onChangeListenTo: ["unit", "price", "type", "side"],
            onChange: ({ value, fieldApi }) => {
              const m = live.current.market;
              const vals = fieldApi.form.state.values;
              const bad = positive(value, "Size");
              if (bad) return bad;
              if (vals.unit === "coin") {
                if (decimals(value) > m.szDecimals)
                  return `Size must be a multiple of the lot (${m.szDecimals > 0 ? (10 ** -m.szDecimals).toFixed(m.szDecimals) : "1"} ${m.base})`;
                return undefined;
              }
              const c = coins(m, { ...vals, size: value });
              if (!Number.isFinite(c))
                return vals.type === "limit"
                  ? "Set a price to size in USD"
                  : "No price to size against yet";
              if (!(c > 0))
                return `Too small: under one lot (${m.szDecimals > 0 ? (10 ** -m.szDecimals).toFixed(m.szDecimals) : "1"} ${m.base})`;
              return undefined;
            },
          }}
        >
          {(f) => (
            <div className="field">
              <label htmlFor="sz" className="row">
                <span>Size</span>
                <span className="spacer" />
                <form.Field name="unit">
                  {(u) => (
                    <span className="seg" style={{ padding: 1 }}>
                      <button
                        type="button"
                        className={u.state.value === "usd" ? "on" : ""}
                        onClick={() => u.handleChange("usd")}
                        style={{ padding: "1px 8px", fontSize: 11 }}
                      >
                        USD
                      </button>
                      <button
                        type="button"
                        className={u.state.value === "coin" ? "on" : ""}
                        onClick={() => u.handleChange("coin")}
                        style={{ padding: "1px 8px", fontSize: 11 }}
                      >
                        {market.base.length > 10 ? "units" : market.base}
                      </button>
                    </span>
                  )}
                </form.Field>
              </label>
              <div className="adorn">
                <input
                  id="sz"
                  className={`input mono ${invalid(f) ? "bad" : ""}`}
                  inputMode="decimal"
                  value={f.state.value}
                  onChange={(e) => f.handleChange(e.target.value.trim())}
                  onBlur={f.handleBlur}
                  placeholder="0"
                  aria-invalid={invalid(f)}
                />
                <span>{v.unit === "usd" ? "USD" : market.base.slice(0, 8)}</span>
              </div>
              <FieldError field={f} />
              <div className="row" style={{ gap: 4 }}>
                {[0.1, 0.25, 0.5, 1].map((p) => (
                  <button
                    type="button"
                    key={p}
                    className="btn small ghost grow"
                    onClick={() => setPct(p)}
                    disabled={!signedIn}
                  >
                    {p * 100}%
                  </button>
                ))}
              </div>
            </div>
          )}
        </form.Field>

        <form.Field
          name="leverage"
          validators={{
            onChange: ({ value }) => {
              const max = live.current.market.maxLeverage;
              if (!Number.isInteger(value) || value < 1) return "Leverage must be at least 1×";
              if (value > max) return `Max leverage is ${max}× right now`;
              return undefined;
            },
          }}
        >
          {(f) => (
            <div className="field">
              <label className="row">
                <span>Leverage</span>
                <span className="spacer" />
                <span className="mono" style={{ color: "var(--text)" }}>
                  {f.state.value}×
                </span>
              </label>
              <input
                type="range"
                min={1}
                max={market.maxLeverage}
                step={1}
                value={Math.min(f.state.value, market.maxLeverage)}
                onChange={(e) => f.handleChange(Number(e.target.value))}
                onBlur={f.handleBlur}
                aria-label="Leverage"
              />
              <FieldError field={f} />
            </div>
          )}
        </form.Field>

        <div className="row" style={{ gap: 16, flexWrap: "wrap" }}>
          <form.Field
            name="reduceOnly"
            validators={{
              onChangeListenTo: ["side"],
              onChange: ({ value, fieldApi }) => {
                if (!value) return undefined;
                const p: PositionView | undefined = live.current.position;
                if (!p) return "Reduce-only needs an open position to reduce";
                const side = fieldApi.form.getFieldValue("side");
                if (
                  (p.side === "long" && side === "buy") ||
                  (p.side === "short" && side === "sell")
                )
                  return `You're ${p.side}: a reduce-only order must ${p.side === "long" ? "sell" : "buy"}`;
                return undefined;
              },
            }}
          >
            {(f) => (
              <div className="col" style={{ gap: 2 }}>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={f.state.value}
                    onChange={(e) => f.handleChange(e.target.checked)}
                    onBlur={f.handleBlur}
                  />{" "}
                  Reduce only
                </label>
                <FieldError field={f} />
              </div>
            )}
          </form.Field>
          {v.type === "limit" && (
            <form.Field name="postOnly">
              {(f) => (
                <label className="check">
                  <input
                    type="checkbox"
                    checked={f.state.value}
                    onChange={(e) => f.handleChange(e.target.checked)}
                  />{" "}
                  Post only
                </label>
              )}
            </form.Field>
          )}
        </div>

        <dl className="kv">
          <dt>Size</dt>
          <dd>
            {sizeCoins > 0
              ? `${fmtSize(sizeCoins, market.szDecimals)} ${market.base.slice(0, 10)}`
              : "—"}
          </dd>
          <dt>Notional</dt>
          <dd>{notional > 0 ? usd(notional) : "—"}</dd>
          <dt>{reducing || pv.reduceOnly ? "Margin" : "Margin posted"}</dt>
          <dd>{reducing || pv.reduceOnly ? "none (reduces)" : margin > 0 ? usd(margin) : "—"}</dd>
          {binary && maxLoss > 0 && Number.isFinite(maxLoss) && (
            <>
              <dt>Max loss</dt>
              <dd>{usd(maxLoss)}</dd>
            </>
          )}
          {!reducing && !pv.reduceOnly && (
            <>
              <dt title="Approximate: ignores funding, the max-loss cap and any taper">
                Est. liquidation
              </dt>
              <dd>
                {capped
                  ? "none: fully collateralized"
                  : liq && Number.isFinite(liq) && sizeCoins > 0
                    ? fmtPrice(liq, market.priceDecimals)
                    : "—"}
              </dd>
            </>
          )}
          <dt>Available</dt>
          <dd>{signedIn ? usd(wallet) : "—"}</dd>
        </dl>

        {binary &&
          pv.side === "sell" &&
          effOnMaxLoss !== null &&
          effOnMaxLoss > lev * 1.5 &&
          !pv.reduceOnly && (
            <div className="note warn">
              {lev}× on notional is <b>{effOnMaxLoss.toFixed(1)}×</b> on this short's max loss (
              {usd(maxLoss)} if {market.base} resolves YES). If it does, the shortfall is charged to
              the longs as ADL.
            </div>
          )}
        {market.taper && market.taper.progress > 0 && (
          <div className="note warn">
            Pre-resolution taper is {Math.round(market.taper.progress * 100)}% in: margin
            requirements are rising toward full max loss.
          </div>
        )}

        <FormError error={server.error} />
        <button
          type="submit"
          className={`btn block ${v.side === "buy" ? "buy" : "sell"}`}
          disabled={submitting || closed}
        >
          {closed
            ? "Market resolved"
            : !signedIn
              ? "Sign up to trade"
              : submitting
                ? "Sending…"
                : `${v.side === "buy" ? "Buy / Long" : "Sell / Short"} ${v.type === "market" ? "at market" : ""}`}
        </button>
      </div>
    </form>
  );
}
