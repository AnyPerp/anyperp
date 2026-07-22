import { describe, expect, it } from "vitest";
import { encodeAbiParameters, pad, toHex, type Hex } from "viem";
import {
  MARKET_CREATED_TOPIC0,
  TRADE_EXECUTED_TOPIC0,
  decodeProtocolLog,
  isOpenFromSize,
} from "../../services/indexer/src/decode.ts";

function addressTopic(address: string): Hex {
  return pad(address as Hex, { size: 32 });
}

describe("indexer decode", () => {
  it("decodes MarketCreated and matches topic0 constant", () => {
    const marketId = ("0x" + "11".repeat(32)) as Hex;
    const market = "0x2222222222222222222222222222222222222222";
    const creator = "0x3333333333333333333333333333333333333333";
    const decoded = decodeProtocolLog({
      address: "0xFactory00000000000000000000000000000001",
      topics: [MARKET_CREATED_TOPIC0 as Hex, marketId, addressTopic(market), addressTopic(creator)],
      data: "0x",
    });
    expect(decoded?.kind).toBe("MarketCreated");
    if (decoded?.kind === "MarketCreated") {
      expect(decoded.market.toLowerCase()).toBe(market.toLowerCase());
      expect(decoded.creator.toLowerCase()).toBe(creator.toLowerCase());
      expect(decoded.marketId).toBe(marketId);
    }
  });

  it("decodes TradeExecuted open and close sizes", () => {
    const account = "0x4444444444444444444444444444444444444444";
    const data = encodeAbiParameters(
      [
        { type: "int256" },
        { type: "int256" },
        { type: "uint256" },
        { type: "int256" },
        { type: "uint256" },
      ],
      [
        1_000_000_000_000_000_000n,
        2_000_000_000_000_000_000n,
        50_000_000_000_000_000_000n,
        -100n,
        10n,
      ],
    );
    const decoded = decodeProtocolLog({
      address: "0xMarket000000000000000000000000000000001",
      topics: [TRADE_EXECUTED_TOPIC0 as Hex, addressTopic(account)],
      data,
    });
    expect(decoded?.kind).toBe("TradeExecuted");
    if (decoded?.kind === "TradeExecuted") {
      expect(decoded.account.toLowerCase()).toBe(account.toLowerCase());
      expect(decoded.newSizeBaseWad).toBe(2_000_000_000_000_000_000n);
      expect(decoded.feeWad).toBe(10n);
      expect(isOpenFromSize(decoded.newSizeBaseWad)).toBe(true);
      expect(isOpenFromSize(0n)).toBe(false);
    }
  });

  it("returns null for unknown topics", () => {
    expect(
      decodeProtocolLog({
        address: "0x1111111111111111111111111111111111111111",
        topics: ["0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef" as Hex],
        data: "0x",
      }),
    ).toBeNull();
  });

  it("documents topic0 constants as 32-byte hex", () => {
    expect(MARKET_CREATED_TOPIC0).toMatch(/^0x[0-9a-f]{64}$/);
    expect(TRADE_EXECUTED_TOPIC0).toMatch(/^0x[0-9a-f]{64}$/);
    expect(toHex(1n)).toMatch(/^0x/);
  });
});
