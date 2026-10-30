import { useEffect, useState } from "react";
import { act } from "../queries";
import { num, price as fmtPrice, size as fmtSize, toInput, usd } from "../format";
import type { AccountView, FillView, MarketView } from "../types";
import { useToast } from "./ui";

interface Props {
  market: MarketView;
  account: AccountView | undefined;
  signedIn: boolean;
  picked: { price: string; n: number } | null;
  onSignUp: () => void;
}

type Side = "buy" | "sell";

const floorTo = (v: number, d: number) => Math.floor(v * 10 ** d + 1e-9) / 10 ** d;

export function OrderForm({ market, account, signedIn, picked, onSignUp }: Props) {
  const toast = useToast();
  const [side, setSide] = useState<Side>("buy");
  const [type, setType] = useState<"market" | "limit">("market");
  const [priceStr, setPrice] = useState("");
  const [sizeStr, setSize] = useState("");
  const [unit, setUnit] = useState<"coin" | "usd">("usd");
  const [lev, setLev] = useState(market.maxLeverage);
  const [reduceOnly, setReduceOnly] = useState(false);
  const [postOnly, setPostOnly] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setLev(market.maxLeverage);
    setPrice("");
    setSize("");
    setReduceOnly(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [market.id]);
  useEffect(() => setLev((l) => Math.min(l, market.maxLeverage)), [market.maxLeverage]);
  useEffect(() => {
    if (!picked) return;
    setType("limit");
    setPrice(picked.price);
  }, [picked]);

  const binary = market.kind === "binary";
  const mark = num(market.mark);
  const touch = side === "buy" ? num(market.bestAsk) : num(market.bestBid);
  const ref = type === "limit" ? num(priceStr) : Number.isFinite(touch) ? touch : mark;
  const sizeCoins = unit === "coin" ? floorTo(num(sizeStr), market.szDecimals) : Number.isFinite(ref) && ref > 0 ? floorTo(num(sizeStr) / ref, market.szDecimals) : NaN;
  const notional = sizeCoins * ref;
  const maxLoss = binary ? sizeCoins * (side === "buy" ? ref : 1 - ref) : Infinity;
  const capped = notional / lev >= maxLoss;
  const margin = capped ? maxLoss * 1.05 : notional / lev;
  const wallet = num(account?.wallet);
  const position = account?.positions.find((p) => p.market === market.id && p.side !== "flat");
  const reducing = position && ((position.side === "long" && side === "sell") || (position.side === "short" && side === "buy"));
  const mmLev = market.maintenanceLeverage; // liquidation is at the market's maintenance margin whatever leverage you chose
  const liq = capped
    ? null
    : side === "buy"
      ? (ref * (1 - 1 / lev)) / (1 - 1 / Math.max(mmLev, 1.0001))
      : (ref * (1 + 1 / lev)) / (1 + 1 / Math.max(mmLev, 1.0001));
  const effOnMaxLoss = binary && Number.isFinite(maxLoss) && margin > 0 ? maxLoss / margin : null;

  const setPct = (p: number) => {
    if (!Number.isFinite(wallet) || !Number.isFinite(ref) || ref <= 0) return;
    if (reduceOnly && position) {
      const s = Math.abs(num(position.size)) * p;
      setUnit("coin");
      setSize(toInput(floorTo(s, market.szDecimals), market.szDecimals));
      return;
    }
    const perCoin = binary ? Math.min(ref / lev, (side === "buy" ? ref : 1 - ref) * 1.05) : ref / lev;
    const coins = floorTo(((wallet * 0.98) / perCoin) * p, market.szDecimals);
    if (unit === "coin") setSize(toInput(coins, market.szDecimals));
    else setSize(toInput(coins * ref, 2));
  };

  async function submit() {
    if (!signedIn) return onSignUp();
    if (!(sizeCoins > 0)) return toast("Enter a size", "warn");
    if (type === "limit" && !(num(priceStr) > 0)) return toast("Enter a limit price", "warn");
    setBusy(true);
    try {
      const r = await act<{ status: string; reason: string | null; fills: FillView[] }>("POST", "/api/orders", {
        market: market.id,
        side,
        type,
        size: sizeCoins.toFixed(market.szDecimals),
        ...(type === "limit" && { price: priceStr, tif: postOnly ? "alo" : "gtc" }),
        leverage: lev,
        reduceOnly,
      });
      const filled = r.fills.reduce((s, f) => s + Number(f.size), 0);
      const avg = filled > 0 ? r.fills.reduce((s, f) => s + Number(f.size) * Number(f.price), 0) / filled : 0;
      const verb = side === "buy" ? "Bought" : "Sold";
      if (r.status === "filled") toast(`${verb} ${fmtSize(filled, market.szDecimals)} ${market.base} @ ${fmtPrice(avg, market.priceDecimals)}`, "up");
      else if (r.status === "partial")
        toast(`${verb} ${fmtSize(filled, market.szDecimals)} @ ${fmtPrice(avg, market.priceDecimals)}; ${type === "limit" ? "rest is on the book" : `rest cancelled: ${r.reason}`}`, "warn");
      else if (r.status === "resting") toast(`Order resting at ${fmtPrice(priceStr, market.priceDecimals)}`, "info");
      else toast(`Not filled: ${r.reason ?? "no liquidity"}`, "warn");
      if (r.status !== "cancelled") setSize("");
    } catch (err) {
      toast((err as Error).message, "down");
    } finally {
      setBusy(false);
    }
  }

  const closed = market.status !== "open";
  return (
    <div className="panel">
      <div className="panel-head">
        <h3>Trade</h3>
        <span className="spacer" />
        <span className="badge" title="Max leverage now (graduation tier)">
          max {market.maxLeverage}×
        </span>
      </div>
      <div className="panel-body col" style={{ gap: 12 }}>
        <div className="seg">
          <button className={side === "buy" ? "on buy" : ""} onClick={() => setSide("buy")}>
            {binary ? `Long ${market.base}` : "Long"}
          </button>
          <button className={side === "sell" ? "on sell" : ""} onClick={() => setSide("sell")}>
            {binary ? `Short ${market.base}` : "Short"}
          </button>
        </div>
        <div className="seg">
          <button className={type === "market" ? "on" : ""} onClick={() => setType("market")}>
            Market
          </button>
          <button
            className={type === "limit" ? "on" : ""}
            onClick={() => {
              setType("limit");
              if (!priceStr && Number.isFinite(mark)) setPrice(toInput(mark, market.priceDecimals));
            }}
          >
            Limit
          </button>
        </div>

        {type === "limit" && (
          <div className="field">
            <label htmlFor="px">Price</label>
            <div className="adorn">
              <input id="px" className="input mono" inputMode="decimal" value={priceStr} onChange={(e) => setPrice(e.target.value.trim())} placeholder={market.mark ?? ""} />
              <span>tick {market.tick}</span>
            </div>
          </div>
        )}

        <div className="field">
          <label htmlFor="sz" className="row">
            <span>Size</span>
            <span className="spacer" />
            <span className="seg" style={{ padding: 1 }}>
              <button className={unit === "usd" ? "on" : ""} onClick={() => setUnit("usd")} style={{ padding: "1px 8px", fontSize: 11 }}>
                USD
              </button>
              <button className={unit === "coin" ? "on" : ""} onClick={() => setUnit("coin")} style={{ padding: "1px 8px", fontSize: 11 }}>
                {market.base.length > 10 ? "units" : market.base}
              </button>
            </span>
          </label>
          <div className="adorn">
            <input id="sz" className="input mono" inputMode="decimal" value={sizeStr} onChange={(e) => setSize(e.target.value.trim())} placeholder="0" />
            <span>{unit === "usd" ? "USD" : market.base.slice(0, 8)}</span>
          </div>
          <div className="row" style={{ gap: 4 }}>
            {[0.1, 0.25, 0.5, 1].map((p) => (
              <button key={p} className="btn small ghost grow" onClick={() => setPct(p)} disabled={!signedIn}>
                {p * 100}%
              </button>
            ))}
          </div>
        </div>

        <div className="field">
          <label className="row">
            <span>Leverage</span>
            <span className="spacer" />
            <span className="mono" style={{ color: "var(--text)" }}>
              {lev}×
            </span>
          </label>
          <input type="range" min={1} max={market.maxLeverage} step={1} value={lev} onChange={(e) => setLev(Number(e.target.value))} aria-label="Leverage" />
        </div>

        <div className="row" style={{ gap: 16 }}>
          <label className="check">
            <input type="checkbox" checked={reduceOnly} onChange={(e) => setReduceOnly(e.target.checked)} /> Reduce only
          </label>
          {type === "limit" && (
            <label className="check">
              <input type="checkbox" checked={postOnly} onChange={(e) => setPostOnly(e.target.checked)} /> Post only
            </label>
          )}
        </div>

        <dl className="kv">
          <dt>Size</dt>
          <dd>{sizeCoins > 0 ? `${fmtSize(sizeCoins, market.szDecimals)} ${market.base.slice(0, 10)}` : "—"}</dd>
          <dt>Notional</dt>
          <dd>{notional > 0 ? usd(notional) : "—"}</dd>
          <dt>{reducing || reduceOnly ? "Margin" : "Margin posted"}</dt>
          <dd>{reducing || reduceOnly ? "none (reduces)" : margin > 0 ? usd(margin) : "—"}</dd>
          {binary && maxLoss > 0 && Number.isFinite(maxLoss) && (
            <>
              <dt>Max loss</dt>
              <dd>{usd(maxLoss)}</dd>
            </>
          )}
          {!reducing && !reduceOnly && (
            <>
              <dt title="Approximate: ignores funding, the max-loss cap and any taper">Est. liquidation</dt>
              <dd>{capped ? "none: fully collateralized" : liq && Number.isFinite(liq) && sizeCoins > 0 ? fmtPrice(liq, market.priceDecimals) : "—"}</dd>
            </>
          )}
          <dt>Available</dt>
          <dd>{signedIn ? usd(wallet) : "—"}</dd>
        </dl>

        {binary && side === "sell" && effOnMaxLoss !== null && effOnMaxLoss > lev * 1.5 && !reduceOnly && (
          <div className="note warn">
            {lev}× on notional is <b>{effOnMaxLoss.toFixed(1)}×</b> on this short's max loss ({usd(maxLoss)} if {market.base} resolves YES). If it does, the shortfall is
            charged to the longs as ADL.
          </div>
        )}
        {market.taper && market.taper.progress > 0 && <div className="note warn">Pre-resolution taper is {Math.round(market.taper.progress * 100)}% in: margin requirements are rising toward full max loss.</div>}

        <button className={`btn block ${side === "buy" ? "buy" : "sell"}`} disabled={busy || closed} onClick={submit}>
          {closed ? "Market resolved" : !signedIn ? "Sign up to trade" : busy ? "Sending…" : `${side === "buy" ? "Buy / Long" : "Sell / Short"} ${type === "market" ? "at market" : ""}`}
        </button>
      </div>
    </div>
  );
}
