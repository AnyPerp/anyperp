import { defineChain, formatUnits, parseUnits, type Chain } from "viem";

export const robinhoodTestnet = defineChain({
  id: 46630,
  name: "Robinhood Chain Testnet",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.testnet.chain.robinhood.com"] } },
  blockExplorers: { default: { name: "Robinhood Testnet Explorer", url: "https://explorer.testnet.chain.robinhood.com" } },
  testnet: true,
});

/** Resolve app chain from env so testnet → mainnet is config, not a rewrite. */
export function resolveAppChain(overrides?: {
  chainId?: number;
  name?: string;
  rpcUrl?: string;
  explorerUrl?: string;
  testnet?: boolean;
}): Chain {
  const chainId = overrides?.chainId
    ?? Number(typeof process !== "undefined" ? process.env.NEXT_PUBLIC_CHAIN_ID ?? process.env.CHAIN_ID ?? 46630 : 46630);
  const rpcUrl = overrides?.rpcUrl
    ?? (typeof process !== "undefined"
      ? (process.env.NEXT_PUBLIC_RPC_URL ?? process.env.RPC_HTTP_URL ?? "https://rpc.testnet.chain.robinhood.com")
      : "https://rpc.testnet.chain.robinhood.com");
  const name = overrides?.name
    ?? (typeof process !== "undefined"
      ? (process.env.NEXT_PUBLIC_CHAIN_NAME ?? (chainId === 46630 ? "Robinhood Chain Testnet" : `Chain ${chainId}`))
      : "Robinhood Chain Testnet");
  const explorer = overrides?.explorerUrl
    ?? (typeof process !== "undefined"
      ? process.env.NEXT_PUBLIC_EXPLORER_URL
      : undefined)
    ?? (chainId === 46630 ? "https://explorer.testnet.chain.robinhood.com" : undefined);
  const testnet = overrides?.testnet
    ?? (typeof process !== "undefined"
      ? (process.env.NEXT_PUBLIC_NETWORK_MODE ?? "testnet") !== "mainnet"
      : true);

  if (chainId === 46630 && !overrides) return robinhoodTestnet;

  return defineChain({
    id: chainId,
    name,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
    blockExplorers: explorer ? { default: { name: `${name} Explorer`, url: explorer } } : undefined,
    testnet,
  });
}

export type NetworkMode = "testnet" | "mainnet" | "anvil";

export function resolveNetworkMode(): NetworkMode {
  const raw = (typeof process !== "undefined" ? process.env.NEXT_PUBLIC_NETWORK_MODE ?? process.env.NETWORK_MODE ?? "testnet" : "testnet")
    .toLowerCase();
  if (raw === "mainnet" || raw === "production" || raw === "prod") return "mainnet";
  if (raw === "anvil" || raw === "local" || raw === "dev") return "anvil";
  return "testnet";
}

export function resolveFeatureFlags() {
  const mode = resolveNetworkMode();
  const flag = (key: string, testnetDefault: boolean) => {
    const v = typeof process !== "undefined" ? process.env[key] : undefined;
    if (v === "true") return true;
    if (v === "false") return false;
    return mode === "mainnet" ? false : testnetDefault;
  };
  return {
    mode,
    allowMockOracle: flag("NEXT_PUBLIC_ALLOW_MOCK_ORACLE", true),
    allowMintableCollateral: flag("NEXT_PUBLIC_ALLOW_MINTABLE_COLLATERAL", true),
    publicFaucet: flag("NEXT_PUBLIC_PUBLIC_FAUCET", true),
  };
}

export const marketFactoryAbi = [
  {
    type: "function",
    name: "createMarket",
    stateMutability: "nonpayable",
    inputs: [{
      name: "params",
      type: "tuple",
      components: [
        { name: "baseToken", type: "address" },
        { name: "collateralToken", type: "address" },
        { name: "tier", type: "uint8" },
        { name: "risk", type: "tuple", components: [
          { name: "initialMarginBps", type: "uint256" }, { name: "maintenanceMarginBps", type: "uint256" },
          { name: "maxOpenInterestWad", type: "uint256" }, { name: "maxSkewWad", type: "uint256" },
          { name: "maxPositionWad", type: "uint256" }, { name: "maxUtilizationBps", type: "uint256" },
          { name: "maxPriceImpactBps", type: "uint256" }, { name: "tradingFeeBps", type: "uint256" },
          { name: "liquidationPenaltyBps", type: "uint256" }, { name: "minSeedLiquidityWad", type: "uint256" },
          { name: "minInsuranceWad", type: "uint256" }, { name: "minOracleLiquidityWad", type: "uint256" },
          { name: "minOracleHistory", type: "uint256" }, { name: "maxOracleConfidenceBps", type: "uint256" },
          { name: "maxOracleDeviationBps", type: "uint256" }, { name: "oracleMaxAge", type: "uint256" },
          { name: "minOracleSources", type: "uint8" }, { name: "minCreatorBondWad", type: "uint256" },
          { name: "baseSpreadBps", type: "uint256" }, { name: "longPayoutStressBps", type: "uint256" },
          { name: "shortPayoutStressBps", type: "uint256" }, { name: "fundingVelocityWad", type: "uint256" },
          { name: "maxFundingRatePerSecondWad", type: "uint256" }, { name: "maxFundingAccrualSeconds", type: "uint256" }
        ]},
        { name: "oracleRouteId", type: "bytes32" },
        { name: "creatorBond", type: "uint256" },
        { name: "userSalt", type: "bytes32" }
      ]
    }],
    outputs: [{ name: "id", type: "bytes32" }, { name: "marketAddress", type: "address" }]
  }
] as const;

export const marketAbi = [
  { type: "function", name: "depositMargin", stateMutability: "nonpayable", inputs: [{ name: "amount", type: "uint256" }], outputs: [] },
  { type: "function", name: "withdrawMargin", stateMutability: "nonpayable", inputs: [{ name: "amount", type: "uint256" }], outputs: [] },
  { type: "function", name: "executeTrade", stateMutability: "nonpayable", inputs: [
    { name: "sizeDelta", type: "int256" }, { name: "limitPrice", type: "uint256" }, { name: "deadline", type: "uint256" },
  ], outputs: [] },
  { type: "function", name: "claimDeferredPayout", stateMutability: "nonpayable", inputs: [], outputs: [{ name: "paidRaw", type: "uint256" }] },
  { type: "function", name: "claimSettlement", stateMutability: "nonpayable", inputs: [], outputs: [] },
] as const;

export const liquidationEngineAbi = [{
  type: "function", name: "liquidate", stateMutability: "nonpayable",
  inputs: [{ name: "market", type: "address" }, { name: "account", type: "address" }, { name: "maxCloseNotionalWad", type: "uint256" }], outputs: [],
}] as const;

export const triggerOrderManagerAbi = [
  { type: "function", name: "placeTriggerOrder", stateMutability: "payable", inputs: [
    { name: "market", type: "address" }, { name: "sizeDelta", type: "int256" },
    { name: "triggerPrice", type: "uint256" }, { name: "acceptablePrice", type: "uint256" },
    { name: "deadline", type: "uint256" }, { name: "triggerType", type: "uint8" },
  ], outputs: [{ name: "orderId", type: "uint256" }] },
  { type: "function", name: "cancelTriggerOrder", stateMutability: "nonpayable", inputs: [{ name: "orderId", type: "uint256" }], outputs: [] },
] as const;

export type ConfirmationTier = "soft_confirmed" | "l1_posted" | "finalized" | "orphaned";
export type MarketState = "draft" | "pending_validation" | "bootstrapping" | "active" | "reduce_only" | "paused" | "settling" | "closed" | "rejected";

export interface StreamEnvelope<T> {
  schemaVersion: 1;
  topic: string;
  chainId: number;
  eventId: string;
  blockNumber: string;
  blockHash: `0x${string}`;
  confirmation: ConfirmationTier;
  timestamp: string;
  payload: T;
}

export function unrealizedPnl(sizeBase: bigint, entryPriceWad: bigint, markPriceWad: bigint): bigint {
  return (sizeBase * (markPriceWad - entryPriceWad)) / 10n ** 18n;
}

export function requiredMargin(notionalWad: bigint, marginBps: bigint): bigint {
  return (notionalWad * marginBps + 9_999n) / 10_000n;
}

export function formatWad(value: bigint, digits = 2): string {
  return Number(formatUnits(value, 18)).toLocaleString("en-US", { maximumFractionDigits: digits });
}

export function wad(value: string): bigint {
  return parseUnits(value, 18);
}
