// Shapes of the server's JSON views (server/src/views.ts). Money and prices are exact decimal strings.

export type Kind = "perp" | "binary" | "attention";

export interface MarketView {
  id: string;
  name: string;
  kind: Kind;
  base: string;
  description: string;
  url: string | null;
  creator: string | null;
  source: { kind: string; label: string; coin?: string };
  status: "open" | "resolved";
  szDecimals: number;
  tick: string;
  priceDecimals: number;
  bounds: [string | null, string | null];
  mark: string | null;
  last: string | null;
  open24h: string | null;
  bestBid: string | null;
  bestAsk: string | null;
  volume24h: string;
  volume: string;
  openInterest: string;
  openInterestUsd: string;
  maxLeverage: number;
  maintenanceLeverage: number;
  tier: number;
  graduation: { next: { leverage: number; volume: string; depth: string } | null; volume: string; depth: string } | null;
  funding: { enabled: boolean; ratePerHour: number; baseRatePerHour: number };
  adl: "size" | "pnl";
  resolvable: boolean;
  resolvesAt: number | null;
  taper: { seconds: number; progress: number } | null;
  curve: { price: string; usdcIn: string; tokensSold: string; supply: string; feeBps: number; oracleWindow: number; marketCap: string } | null;
  heldUntil: number | null;
  createdAt: number;
  positions: number;
}

export interface Level {
  price: string;
  size: string;
  orders: number;
}

export interface BookView {
  market: string;
  bids: Level[];
  asks: Level[];
  mark: string | null;
}

export interface FillView {
  id: number;
  time: number;
  market: string;
  kind: "perp" | "spot";
  price: string;
  size: string;
  notional: string;
  side: "buy" | "sell";
  taker: string;
  maker: string;
  mySide?: "buy" | "sell";
  liquidity?: "taker" | "maker";
}

export interface OrderView {
  id: number;
  market: string;
  side: "buy" | "sell";
  price: string;
  size: string;
  filled: string;
  leverage: number;
  reduceOnly: boolean;
  tif: string;
  time: number;
}

export interface PositionView {
  market: string;
  kind: Kind;
  size: string;
  side: "long" | "short" | "flat";
  entry: string | null;
  mark: string | null;
  notional: string;
  collateral: string;
  equity: string;
  unrealized: string;
  realized: string;
  funding: string;
  adl: string;
  allocated: string;
  pnl: string;
  initialMargin: string;
  maintenanceMargin: string;
  leverage: number | null;
  liquidationPrice: string | null;
  bankruptcyPrice: string | null;
  releasable: string;
}

export type RiskKind = "liquidation" | "bankrupt" | "haircut" | "adl" | "settlement" | "graduation" | "gap" | "listing";

export interface RiskEvent {
  id: number;
  time: number;
  market: string;
  kind: RiskKind;
  accounts: string[];
  text: string;
  amount: string | null;
}

export interface AccountView {
  id: string;
  bot: boolean;
  createdAt: number;
  nextFaucet: number;
  wallet: string;
  deposited: string;
  withdrawn: string;
  equity: string;
  pnl: string;
  positions: PositionView[];
  ledger: { realized: string; funding: string; adlPaid: string; adlCovered: string };
  spot: { market: string; tokens: string; value: string; price: string | null }[];
  orders: OrderView[];
  fills: FillView[];
  risk: RiskEvent[];
}

export interface Candle {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export interface LeaderRow {
  id: string;
  bot: boolean;
  equity: string;
  pnl: string;
  haircuts: string;
  open: number;
}

export interface ConfigView {
  genesis: number;
  graduation: { leverage: number; volume: string; depth: string }[];
  fundingBasePerHour: number[];
}
