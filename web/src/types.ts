// Shapes of the server's JSON views (server/src/views.ts, plus the additions in docs/API-CONTRACT.md).
// Money and prices are exact decimal strings in USD; times are ms since epoch. normalize.ts fills in any
// contract field an older server leaves out, so components can rely on every field below being present.

export type Kind = "perp" | "binary" | "attention" | "preipo";

export interface SnipeView {
  opensAt: number;
  total: string;
  snipers: number;
  projectedOpenPrice: string;
  top: { account: string; usdc: string }[];
  recent: { account: string; usdc: string; time: number }[];
}

export interface LaunchView {
  openPrice: string;
  openedAt: number;
  sniped: string;
  tokensSold: string;
  reserve: string;
}

export interface PreIpoView {
  seedPrice: string;
  impliedValuation: string;
  status: "private" | "public";
  ipoAt: number | null;
  ipoPrice: string | null;
}

export interface Setting {
  label: string;
  value: string;
  ours: boolean;
}

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
  snipe: SnipeView | null;
  launch: LaunchView | null;
  preipo: PreIpoView | null;
  settings: Setting[];
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

export type RiskKind = "liquidation" | "bankrupt" | "haircut" | "adl" | "settlement" | "graduation" | "gap" | "listing" | "open" | "ipo";

export interface RiskEvent {
  id: number;
  time: number;
  market: string;
  kind: RiskKind;
  accounts: string[];
  text: string;
  amount: string | null;
  /** Mark at the event, for chart markers. */
  price: string | null;
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
  /** Snipe bids still waiting for their market to open. */
  snipes: { market: string; usdc: string; time: number }[];
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
