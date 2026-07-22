import { describe, expect, it } from "vitest";
import {
  clampBlockLookback,
  mergeAddresses,
  recentOrderIdWindow,
  recentRequestIdWindow,
} from "../../services/keepers/src/discovery.ts";

describe("keeper discovery helpers", () => {
  it("merges unique checksum-insensitive addresses", () => {
    const a = "0x1111111111111111111111111111111111111111";
    const b = "0x2222222222222222222222222222222222222222";
    const merged = mergeAddresses([a], [a.toUpperCase()], [b], ["not-an-address", "0x12"]);
    expect(merged).toEqual([a, b]);
  });

  it("computes recent order id window", () => {
    expect(recentOrderIdWindow(1n, 200n)).toEqual({ start: 1n, endExclusive: 1n });
    expect(recentOrderIdWindow(10n, 200n)).toEqual({ start: 1n, endExclusive: 10n });
    expect(recentOrderIdWindow(500n, 200n)).toEqual({ start: 300n, endExclusive: 500n });
  });

  it("computes withdrawal request window the same way", () => {
    expect(recentRequestIdWindow(5n, 100n)).toEqual({ start: 1n, endExclusive: 5n });
    expect(recentRequestIdWindow(150n, 100n)).toEqual({ start: 50n, endExclusive: 150n });
  });

  it("clamps block lookback without underflow", () => {
    expect(clampBlockLookback(100n, 50n)).toBe(51n);
    expect(clampBlockLookback(10n, 50n)).toBe(0n);
    expect(clampBlockLookback(0n, 50n)).toBe(0n);
    expect(clampBlockLookback(1000n, 0n)).toBe(1000n);
  });
});
