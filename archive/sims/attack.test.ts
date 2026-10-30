// Pump-attack sweep from the research phase (moved out of the app's engine tests). Run with
// `pnpm archive:test`.

import { describe, expect, it } from "vitest";
import { parseFixed as usd } from "../reference/engine/fixed.js";

describe("pump attack sweep", async () => {
  const { runAttack } = await import("./attack.js");

  it("instant oracle: a modest pump extracts all victim collateral for fees only", () => {
    const r = runAttack({ pump: 5_000, window: 0, feeBps: 100, retrace: 0 });
    expect(r.victimLoss).toBe(r.victimCollateral);
    const gap = r.victimCollateral - r.attackerFees - r.attackerPnl; // curve rounds a few nano-dollars in its own favour
    expect(gap >= 0n && gap < usd("0.001")).toBe(true);
  });

  it("TWAP without arbitrage only delays the attack", () => {
    expect(runAttack({ pump: 5_000, window: 3600, feeBps: 100, retrace: 0 }).attackerPnl).toBeGreaterThan(0n);
  });

  it("TWAP with strong arbitrage makes the attack unprofitable", () => {
    for (const pump of [2_000, 5_000, 20_000]) {
      expect(runAttack({ pump, window: 600, feeBps: 100, retrace: 0.9 }).attackerPnl).toBeLessThan(0n);
    }
  });
});
