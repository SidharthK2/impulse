import { describe, expect, it } from "vitest";
import { allocate } from "../src/alloc.js";

const w = (...weights: number[]) => weights.map((x, i) => ({ key: `k${i}`, weight: BigInt(x) }));
const sum = (m: Map<string, bigint>) => [...m.values()].reduce((a, b) => a + b, 0n);

describe("allocate (largest remainder)", () => {
  it("sums to exactly the total", () => {
    const m = allocate(285_000_000n, w(700, 400, 200));
    expect(sum(m)).toBe(285_000_000n);
    expect(m.get("k0")).toBe(153_461_538n);
    expect(m.get("k1")).toBe(87_692_308n); // largest remainder gets the extra unit
    expect(m.get("k2")).toBe(43_846_154n);
  });

  it("gives each part floor or ceil of its exact share", () => {
    for (let total = 0n; total < 50n; total++) {
      const weights = w(3, 7, 11, 1);
      const m = allocate(total, weights);
      expect(sum(m)).toBe(total);
      weights.forEach(({ key, weight }) => {
        const exactFloor = (total * weight) / 22n;
        expect(m.get(key)! - exactFloor).toBeGreaterThanOrEqual(0n);
        expect(m.get(key)! - exactFloor).toBeLessThanOrEqual(1n);
      });
    }
  });

  it("breaks ties deterministically by input order", () => {
    const m = allocate(1n, w(1, 1, 1));
    expect([...m.values()]).toEqual([1n, 0n, 0n]);
  });

  it("rejects allocating something against nothing", () => {
    expect(() => allocate(5n, w(0, 0))).toThrow();
    expect(sum(allocate(0n, w(0, 0)))).toBe(0n);
  });
});
