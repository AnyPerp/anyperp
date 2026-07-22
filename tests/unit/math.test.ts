import { describe, expect, it } from "vitest";
import { requiredMargin, unrealizedPnl, wad } from "../../packages/sdk/src/index";

describe("protocol math", () => {
  it("computes long profit and loss", () => {
    expect(unrealizedPnl(wad("2"), wad("100"), wad("110"))).toBe(wad("20"));
    expect(unrealizedPnl(wad("2"), wad("100"), wad("90"))).toBe(wad("-20"));
  });
  it("computes short profit and loss", () => {
    expect(unrealizedPnl(-wad("2"), wad("100"), wad("90"))).toBe(wad("20"));
    expect(unrealizedPnl(-wad("2"), wad("100"), wad("110"))).toBe(wad("-20"));
  });
  it("rounds liabilities upward", () => {
    expect(requiredMargin(10_001n, 1_000n)).toBe(1_001n);
  });
});
