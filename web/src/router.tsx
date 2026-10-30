// Routes. Every page is its own lazily loaded chunk; the layout (App.tsx) is the only eager one.

import { createRootRoute, createRoute, createRouter, lazyRouteComponent, redirect } from "@tanstack/react-router";
import { Layout } from "./App";
import { usePrefs } from "./store";

const root = createRootRoute({ component: Layout });

const home = createRoute({ getParentRoute: () => root, path: "/", component: lazyRouteComponent(() => import("./routes/home"), "HomePage") });

const tradeIndex = createRoute({
  getParentRoute: () => root,
  path: "/trade",
  beforeLoad: () => {
    throw redirect({ to: "/trade/$market", params: { market: usePrefs.getState().lastMarket ?? "BTC-PERP" } });
  },
});

export const trade = createRoute({ getParentRoute: () => root, path: "/trade/$market", component: lazyRouteComponent(() => import("./routes/trade"), "TradePage") });

const portfolio = createRoute({ getParentRoute: () => root, path: "/portfolio", component: lazyRouteComponent(() => import("./routes/portfolio"), "PortfolioPage") });

const leaderboard = createRoute({ getParentRoute: () => root, path: "/leaderboard", component: lazyRouteComponent(() => import("./routes/leaderboard"), "LeaderboardPage") });

const admin = createRoute({ getParentRoute: () => root, path: "/admin", component: lazyRouteComponent(() => import("./routes/admin"), "AdminPage") });

const feed = createRoute({ getParentRoute: () => root, path: "/feed", component: lazyRouteComponent(() => import("./pages"), "FeedPage") });

const about = createRoute({ getParentRoute: () => root, path: "/about", component: lazyRouteComponent(() => import("./pages"), "AboutPage") });

const tree = root.addChildren([home, tradeIndex, trade, portfolio, leaderboard, admin, feed, about]);

// Links from the old hash router (#/trade/BTC-PERP) still land on the right page.
if (typeof location !== "undefined" && location.hash.startsWith("#/")) {
  history.replaceState(null, "", location.hash.slice(1));
}

export const router = createRouter({ routeTree: tree, defaultPreload: "intent", scrollRestoration: true });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
