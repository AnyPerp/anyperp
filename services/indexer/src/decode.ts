/**
 * Pure log decoding for testnet projections.
 * No DB / RPC — unit-testable.
 */
import {
  decodeEventLog,
  getAddress,
  type Hex,
  type Log,
} from "viem";

export const MARKET_CREATED_TOPIC0 =
  "0xbc2bccc2713ac25dc4bcda6e2a6c18b5c5cd08d9c00fa807a841a510d6c11a79" as const;

export const TRADE_EXECUTED_TOPIC0 =
  "0x4150719bc459d3e484382cf18888a27c39bb314592e17ec0f298c58a8759ec1c" as const;

export const MARGIN_DEPOSITED_TOPIC0 =
  "0xee5801f75c4ef09df299ebf9110e8bac3989e03dd9119213ff6f6f2c8b5ec014" as const;

const marketCreatedAbi = [
  {
    type: "event",
    name: "MarketCreated",
    inputs: [
      { name: "marketId", type: "bytes32", indexed: true },
      { name: "market", type: "address", indexed: true },
      { name: "creator", type: "address", indexed: true },
    ],
  },
] as const;

const tradeExecutedAbi = [
  {
    type: "event",
    name: "TradeExecuted",
    inputs: [
      { name: "account", type: "address", indexed: true },
      { name: "sizeDeltaBaseWad", type: "int256", indexed: false },
      { name: "newSizeBaseWad", type: "int256", indexed: false },
      { name: "executionPriceWad", type: "uint256", indexed: false },
      { name: "realizedPnlWad", type: "int256", indexed: false },
      { name: "feeWad", type: "uint256", indexed: false },
    ],
  },
] as const;

const marginDepositedAbi = [
  {
    type: "event",
    name: "MarginDeposited",
    inputs: [
      { name: "account", type: "address", indexed: true },
      { name: "amountRaw", type: "uint256", indexed: false },
      { name: "amountWad", type: "uint256", indexed: false },
    ],
  },
] as const;

export type DecodedMarketCreated = {
  kind: "MarketCreated";
  marketId: Hex;
  market: string;
  creator: string;
};

export type DecodedTradeExecuted = {
  kind: "TradeExecuted";
  account: string;
  sizeDeltaBaseWad: bigint;
  newSizeBaseWad: bigint;
  executionPriceWad: bigint;
  realizedPnlWad: bigint;
  feeWad: bigint;
};

export type DecodedMarginDeposited = {
  kind: "MarginDeposited";
  account: string;
  amountRaw: bigint;
  amountWad: bigint;
};

export type DecodedProtocolEvent =
  | DecodedMarketCreated
  | DecodedTradeExecuted
  | DecodedMarginDeposited;

export function topic0Of(log: Pick<Log, "topics">): string | null {
  const t = log.topics[0];
  return t ? t.toLowerCase() : null;
}

export function decodeProtocolLog(log: Pick<Log, "topics" | "data" | "address">): DecodedProtocolEvent | null {
  const topic0 = topic0Of(log);
  if (!topic0) return null;
  try {
    if (topic0 === MARKET_CREATED_TOPIC0) {
      const decoded = decodeEventLog({
        abi: marketCreatedAbi,
        data: log.data as Hex,
        topics: log.topics as [Hex, ...Hex[]],
      });
      if (decoded.eventName !== "MarketCreated") return null;
      return {
        kind: "MarketCreated",
        marketId: decoded.args.marketId as Hex,
        market: getAddress(decoded.args.market as string),
        creator: getAddress(decoded.args.creator as string),
      };
    }
    if (topic0 === TRADE_EXECUTED_TOPIC0) {
      const decoded = decodeEventLog({
        abi: tradeExecutedAbi,
        data: log.data as Hex,
        topics: log.topics as [Hex, ...Hex[]],
      });
      if (decoded.eventName !== "TradeExecuted") return null;
      return {
        kind: "TradeExecuted",
        account: getAddress(decoded.args.account as string),
        sizeDeltaBaseWad: decoded.args.sizeDeltaBaseWad as bigint,
        newSizeBaseWad: decoded.args.newSizeBaseWad as bigint,
        executionPriceWad: decoded.args.executionPriceWad as bigint,
        realizedPnlWad: decoded.args.realizedPnlWad as bigint,
        feeWad: decoded.args.feeWad as bigint,
      };
    }
    if (topic0 === MARGIN_DEPOSITED_TOPIC0) {
      const decoded = decodeEventLog({
        abi: marginDepositedAbi,
        data: log.data as Hex,
        topics: log.topics as [Hex, ...Hex[]],
      });
      if (decoded.eventName !== "MarginDeposited") return null;
      return {
        kind: "MarginDeposited",
        account: getAddress(decoded.args.account as string),
        amountRaw: decoded.args.amountRaw as bigint,
        amountWad: decoded.args.amountWad as bigint,
      };
    }
  } catch {
    return null;
  }
  return null;
}

/** After reorg/orphan, recompute open flag from latest canonical trade size. */
export function isOpenFromSize(newSizeBaseWad: bigint): boolean {
  return newSizeBaseWad !== 0n;
}
