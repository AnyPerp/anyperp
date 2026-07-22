"use client";

import Image from "next/image";
import { useEffect, useMemo, useState } from "react";
import { TvCandleChart } from "./tv-chart";
import listedMarketsCatalog from "./listed-markets.json";
import launchHelperMeta from "./launch-helper.json";
import {
  allTradeableMarkets,
  fetchRobinhoodDex,
  findCommunity,
  findMarketByCa,
  loadCommunityMarkets,
  saveCommunityMarket,
  type CommunityMarket,
} from "./rh-catalog";
import { DexPriceKeeper } from "./price-keeper";
import { isOracleDeviationError } from "./oracle-sync";
import {
  createPublicClient,
  createWalletClient,
  custom,
  encodeAbiParameters,
  formatUnits,
  http,
  isAddress,
  keccak256,
  decodeEventLog,
  maxUint256,
  parseAbiItem,
  parseUnits,
  stringToHex,
  type Address,
} from "viem";
import { marketFactoryAbi, resolveAppChain, resolveFeatureFlags } from "../packages/sdk/src/index";
import { DocsPortal, WHITEPAPER_PATH } from "./docs-portal";

type ListedMarket = {
  symbol: string;
  label?: string;
  market: string;
  marketId?: string;
  baseToken?: string;
  routeId?: string | null;
  liquidityVault?: string;
  chartSymbol?: string | null;
  pyth?: string | null;
  dexPrice?: boolean;
  sourceCa?: string;
  source?: string;
  active?: boolean;
};

const LISTED_MARKETS: ListedMarket[] = (listedMarketsCatalog as { markets: ListedMarket[] }).markets ?? [];

const featureFlags = resolveFeatureFlags();
const appChain = resolveAppChain();
const explorerBase = process.env.NEXT_PUBLIC_EXPLORER_URL ?? appChain.blockExplorers?.default?.url ?? "https://explorer.testnet.chain.robinhood.com";
const networkLabel = process.env.NEXT_PUBLIC_CHAIN_NAME ?? appChain.name;
const networkMode = featureFlags.mode;

type View = "landing" | "docs" | "home" | "markets" | "trade" | "create" | "liquidity" | "portfolio" | "history" | "contracts" | "governance" | "risk" | "admin";
type TxState = "idle" | "checking" | "awaiting_signature" | "submitted" | "confirmed" | "failed";

/** Official protocol contracts (RHC testnet S10a — see deployments/ANYPERP-LATEST.md) */
const OFFICIAL_CONTRACTS: { name: string; role: string; address: string; mintable?: boolean }[] = [
  { name: "apUSD (test collateral)", role: "Mintable test USD · margin & LP", address: process.env.NEXT_PUBLIC_COLLATERAL_ADDRESS || "0x8f3e02f6ae47ec0e5ff5dcd4dd1bfbd3c1fed2f0", mintable: true },
  { name: "MarketFactory", role: "Deploys isolated markets", address: process.env.NEXT_PUBLIC_MARKET_FACTORY_ADDRESS || "0xd1e154498a382074cf66f3274244d55b80b1a52d" },
  { name: "MarketRegistry", role: "Canonical market directory", address: process.env.NEXT_PUBLIC_MARKET_REGISTRY_ADDRESS || "0xbdd1ab0bf5ea2846e05d80771958332f328e6da3" },
  { name: "LaunchHelper", role: "One-tx create (CA → live market)", address: (process.env.NEXT_PUBLIC_LAUNCH_HELPER_ADDRESS || "0xaec57bd44a14302c9d157f1ba14c0b664f00209c") },
  { name: "OracleRouter", role: "Price routes / adapters", address: process.env.NEXT_PUBLIC_ORACLE_ROUTER_ADDRESS || "0xd9e74c0ebdfbb9538b63fe5d7e4456456ef4a13b" },
  { name: "LiquidationEngine", role: "Liquidations", address: process.env.NEXT_PUBLIC_LIQUIDATION_ENGINE_ADDRESS || "0x381c70f1eead30094543e544fab0bae3d412f212" },
  { name: "TriggerOrderManager", role: "Triggers / TP-SL rails", address: process.env.NEXT_PUBLIC_TRIGGER_ORDER_MANAGER_ADDRESS || "0x6ca42a07fb4bf7ff5125a971a188a47670ed4b45" },
  { name: "MarketLens", role: "Read helpers / views", address: process.env.NEXT_PUBLIC_MARKET_LENS_ADDRESS || "0xbbb2b1585f6b5ea0fe0c2e587a6f8b386eb60c97" },
  { name: "RiskManager", role: "Risk params", address: "0x084e967a17b550075674c502de1a845583da3d05" },
  { name: "ProtocolBackstop", role: "Capped backstop", address: "0xf8c10cb2d201deae44b3849631f7d9e4696e25c5" },
  { name: "Governance Timelock", role: "Slow upgrades", address: "0xaf494c7ad0732d2a2a7b8d47757f4aa2b2908ace" },
  { name: "Demo market (BTC-PERP)", role: "Live demo market", address: process.env.NEXT_PUBLIC_DEMO_MARKET_ADDRESS || "0x2D2EE857198874e89Db2Cf29C3E1B47Bfb184cEa" },
];

const marketAbi = [
  { type: "function", name: "depositMargin", stateMutability: "nonpayable", inputs: [{ name: "amount", type: "uint256" }], outputs: [] },
  { type: "function", name: "executeTrade", stateMutability: "nonpayable", inputs: [
    { name: "sizeDelta", type: "int256" }, { name: "limitPrice", type: "uint256" }, { name: "deadline", type: "uint256" }
  ], outputs: [] },
  { type: "function", name: "withdrawMargin", stateMutability: "nonpayable", inputs: [{ name: "amount", type: "uint256" }], outputs: [] },
  { type: "function", name: "indexPrice", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "state", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { type: "function", name: "position", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{
    type: "tuple", components: [
      { name: "sizeBaseWad", type: "int256" }, { name: "entryPriceWad", type: "uint256" },
      { name: "marginWad", type: "uint256" }, { name: "fundingCheckpointWad", type: "int256" },
      { name: "lastModified", type: "uint256" },
    ],
  }] },
  { type: "function", name: "collateralToken", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "collateralVault", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "liquidityVault", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "longOpenInterestBaseWad", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "shortOpenInterestBaseWad", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "badDebtWad", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "pendingPnlClaimsWad", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "pendingFundingClaimsWad", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "claimDeferredPayout", stateMutability: "nonpayable", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "accountEquityWad", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ type: "int256" }] },
  { type: "function", name: "lossBudgetCapacityRaw", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "insuranceFund", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "baseToken", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  {
    type: "function",
    name: "riskParams",
    stateMutability: "view",
    inputs: [],
    outputs: [{
      type: "tuple",
      components: [
        { name: "initialMarginBps", type: "uint256" },
        { name: "maintenanceMarginBps", type: "uint256" },
        { name: "maxOpenInterestWad", type: "uint256" },
        { name: "maxSkewWad", type: "uint256" },
        { name: "maxPositionWad", type: "uint256" },
        { name: "maxUtilizationBps", type: "uint256" },
        { name: "maxPriceImpactBps", type: "uint256" },
        { name: "tradingFeeBps", type: "uint256" },
        { name: "liquidationPenaltyBps", type: "uint256" },
        { name: "minSeedLiquidityWad", type: "uint256" },
        { name: "minInsuranceWad", type: "uint256" },
        { name: "minOracleLiquidityWad", type: "uint256" },
        { name: "minOracleHistory", type: "uint256" },
        { name: "maxOracleConfidenceBps", type: "uint256" },
        { name: "maxOracleDeviationBps", type: "uint256" },
        { name: "oracleMaxAge", type: "uint256" },
        { name: "minOracleSources", type: "uint8" },
        { name: "minCreatorBondWad", type: "uint256" },
        { name: "baseSpreadBps", type: "uint256" },
        { name: "longPayoutStressBps", type: "uint256" },
        { name: "shortPayoutStressBps", type: "uint256" },
        { name: "fundingVelocityWad", type: "uint256" },
        { name: "maxFundingRatePerSecondWad", type: "uint256" },
        { name: "maxFundingAccrualSeconds", type: "uint256" },
      ],
    }],
  },
] as const;

const insuranceFundAbi = [
  { type: "function", name: "balance", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
] as const;

const erc20Abi = [
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "mint", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], outputs: [] },
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "name", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
] as const;

const launchHelperAddress = (process.env.NEXT_PUBLIC_LAUNCH_HELPER_ADDRESS ||
  (launchHelperMeta as { address?: string }).address ||
  "0xaec57bd44a14302c9d157f1ba14c0b664f00209c") as Address;

const liquidityVaultAbi = [
  { type: "function", name: "deposit", stateMutability: "nonpayable", inputs: [{ name: "assets", type: "uint256" }, { name: "receiver", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "totalAssets", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "freeAssets", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "reservedAssets", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "requestWithdraw", stateMutability: "nonpayable", inputs: [{ name: "shares", type: "uint256" }], outputs: [{ type: "uint256" }] },
] as const;

const registryAbi = [{ type: "function", name: "isMarket", stateMutability: "view", inputs: [{ name: "market", type: "address" }], outputs: [{ type: "bool" }] }] as const;

// Live AnyPerp testnet demo (set after governance execute + market create).
// Fallbacks match the latest redeploy base/collateral/route; market/vault fill after E2E.
const demoMarket = process.env.NEXT_PUBLIC_DEMO_MARKET_ADDRESS || "";
const demoBase = process.env.NEXT_PUBLIC_DEMO_BASE_TOKEN || "0xf07a6d0b9453941c68dffebf181d556def09a8bf";
const demoRoute = process.env.NEXT_PUBLIC_DEMO_ORACLE_ROUTE_ID || "0x14deb0349513e213518bd0247addd8e42d964ef2a7e19388719fbcf52ecbed73";
const demoVault = process.env.NEXT_PUBLIC_DEMO_LIQUIDITY_VAULT || "";
const demoCollateral = process.env.NEXT_PUBLIC_COLLATERAL_ADDRESS || "0x8f3e02f6ae47ec0e5ff5dcd4dd1bfbd3c1fed2f0";
/** Mock oracle adapters that serve the demo route (public set() on testnet). */
const oracleAdapters = (process.env.NEXT_PUBLIC_ORACLE_ADAPTERS ||
  "0x957ce5792080b0aaf97632cc78c976905fe17962,0x5d669814ca06142581bcea83f51f794d0fd1eafb")
  .split(",")
  .map((s) => s.trim())
  .filter((s): s is Address => isAddress(s));

const mockOracleWriteAbi = [
  {
    type: "function",
    name: "set",
    stateMutability: "nonpayable",
    inputs: [
      { name: "asset", type: "address" },
      {
        name: "data",
        type: "tuple",
        components: [
          { name: "priceWad", type: "uint256" },
          { name: "confidenceBps", type: "uint256" },
          { name: "updatedAt", type: "uint256" },
          { name: "liquidityWad", type: "uint256" },
          { name: "historySeconds", type: "uint256" },
          { name: "validSources", type: "uint8" },
        ],
      },
    ],
    outputs: [],
  },
] as const;

const oracleRouterReadAbi = [
  {
    type: "function",
    name: "getPrice",
    stateMutability: "view",
    inputs: [{ name: "routeId", type: "bytes32" }],
    outputs: [
      {
        type: "tuple",
        components: [
          { name: "priceWad", type: "uint256" },
          { name: "confidenceBps", type: "uint256" },
          { name: "updatedAt", type: "uint256" },
          { name: "liquidityWad", type: "uint256" },
          { name: "historySeconds", type: "uint256" },
          { name: "validSources", type: "uint8" },
        ],
      },
    ],
  },
] as const;

const oracleRouterWriteAbi = [
  {
    type: "function",
    name: "createRoute",
    stateMutability: "nonpayable",
    inputs: [
      { name: "asset", type: "address" },
      { name: "adapters", type: "address[]" },
    ],
    outputs: [{ name: "routeId", type: "bytes32" }],
  },
] as const;

function findListed(market?: string): ListedMarket | CommunityMarket | undefined {
  if (!market || !isAddress(market)) return undefined;
  return (
    LISTED_MARKETS.find((m) => m.market.toLowerCase() === market.toLowerCase()) ||
    findCommunity(market)
  );
}

/** Symbol + human label for a market address (listed / community / on-chain ERC20). */
async function resolveMarketMeta(market: Address): Promise<{ symbol: string; label?: string }> {
  const listed = findListed(market);
  if (listed?.symbol) {
    return { symbol: listed.symbol, label: listed.label };
  }
  try {
    const base = await publicClient.readContract({
      address: market,
      abi: marketAbi,
      functionName: "baseToken",
    });
    if (base && isAddress(base)) {
      // Match listed by base token (same asset, different market clone)
      const byBase = LISTED_MARKETS.find(
        (m) => m.baseToken?.toLowerCase() === base.toLowerCase(),
      );
      if (byBase?.symbol) return { symbol: byBase.symbol, label: byBase.label };

      const [sym, name] = await Promise.all([
        publicClient.readContract({ address: base, abi: erc20Abi, functionName: "symbol" }).catch(() => ""),
        publicClient.readContract({ address: base, abi: erc20Abi, functionName: "name" }).catch(() => ""),
      ]);
      const symbol = (typeof sym === "string" && sym.trim() ? sym.trim() : short(base)).toUpperCase();
      const label = typeof name === "string" && name.trim() ? name.trim() : undefined;
      return { symbol, label };
    }
  } catch { /* fall through */ }
  return { symbol: short(market) };
}

function MarketNameCell({ symbol, label, market }: { symbol?: string; label?: string; market: Address }) {
  // Always re-resolve from catalog at render so Portfolio never shows bare address for known markets
  const listed = findListed(market);
  const sym = (listed?.symbol || symbol || "").trim();
  const lab = listed?.label || label;
  const title = sym ? `${sym.toUpperCase()}-PERP` : short(market);
  return (
    <td>
      <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 120 }}>
        <strong style={{ fontSize: 14, letterSpacing: "0.02em" }}>{title}</strong>
        {lab ? <small style={{ color: "var(--muted)", lineHeight: 1.2 }}>{lab}</small> : null}
        <code className="mono" style={{ opacity: 0.75 }}>{short(market)}</code>
      </div>
    </td>
  );
}

function useTradeableMarkets(): Array<ListedMarket | CommunityMarket> {
  const [rows, setRows] = useState<Array<ListedMarket | CommunityMarket>>(() => allTradeableMarkets(LISTED_MARKETS));
  useEffect(() => {
    const refresh = () => setRows(allTradeableMarkets(LISTED_MARKETS));
    refresh();
    const onStorage = (e: StorageEvent) => {
      if (e.key === "anyperp.communityMarkets.v1") refresh();
    };
    window.addEventListener("storage", onStorage);
    window.addEventListener("anyperp-community-markets", refresh as EventListener);

    // Pull recent helper launches on-chain so new markets show for everyone
    let cancelled = false;
    void (async () => {
      try {
        if (!isAddress(launchHelperAddress)) return;
        const latest = await publicClient.getBlockNumber();
        const fromBlock = latest > 80_000n ? latest - 80_000n : 0n;
        const logs = await publicClient.getLogs({
          address: launchHelperAddress,
          event: parseAbiItem(
            "event MarketLaunched(address indexed launcher, address indexed market, bytes32 marketId, address baseToken, address sourceHint, string symbol)",
          ),
          fromBlock,
          toBlock: "latest",
        });
        if (cancelled || !logs.length) return;
        const { mergeDiscovered } = await import("./rh-catalog");
        const discovered: CommunityMarket[] = logs.slice(-40).map((log) => {
          const args = log.args as {
            market: Address;
            marketId: `0x${string}`;
            baseToken: Address;
            sourceHint: Address;
            symbol: string;
          };
          return {
            symbol: (args.symbol || "TOKEN").slice(0, 12),
            label: `${args.symbol || "TOKEN"} (RH mainnet)`,
            market: args.market,
            marketId: args.marketId,
            baseToken: args.baseToken,
            sourceCa: args.sourceHint,
            dexPrice: true as const,
            source: "dexscreener-robinhood" as const,
            active: true,
          };
        });
        mergeDiscovered(discovered);
        refresh();
      } catch {
        /* RPC log range limits — local catalog still works */
      }
    })();

    return () => {
      cancelled = true;
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("anyperp-community-markets", refresh as EventListener);
    };
  }, []);
  return rows;
}

function defaultSizeForMark(mark: number): string {
  if (mark > 20_000) return "0.05";
  if (mark > 200) return "0.5";
  if (mark > 20) return "2";
  if (mark > 0.01) return "100";
  return "1000";
}

const factoryLifecycleAbi = [
  { type: "function", name: "validateMarket", stateMutability: "nonpayable", inputs: [{ name: "id", type: "bytes32" }], outputs: [] },
  { type: "function", name: "seedMarket", stateMutability: "nonpayable", inputs: [{ name: "id", type: "bytes32" }, { name: "lpAssets", type: "uint256" }, { name: "insuranceAssets", type: "uint256" }], outputs: [] },
  { type: "function", name: "activateMarket", stateMutability: "nonpayable", inputs: [{ name: "id", type: "bytes32" }], outputs: [] },
  { type: "function", name: "deployments", stateMutability: "view", inputs: [{ name: "id", type: "bytes32" }], outputs: [
    { name: "market", type: "address" }, { name: "collateralVault", type: "address" }, { name: "liquidityVault", type: "address" },
    { name: "insuranceFund", type: "address" }, { name: "creator", type: "address" }, { name: "collateral", type: "address" },
    { name: "bond", type: "uint256" }, { name: "createdAt", type: "uint256" }, { name: "bondClaimed", type: "bool" },
  ] },
] as const;

const factoryAbi = [...marketFactoryAbi, ...factoryLifecycleAbi] as const;
const marketStates = ["Draft", "Pending validation", "Bootstrapping", "Active", "Reduce-only", "Paused", "Settling", "Closed", "Rejected"] as const;
// Provisional testnet-only candidate. The deployed RiskManager envelope remains
// authoritative and simulation will reject this if governance configured a
// different or stricter envelope.
/**
 * Risk template matching Market._checkCaps:
 *   maxPositionWad / maxOpenInterestWad = notional $
 *   maxSkewWad = base token units (must be huge for cheap RH tokens)
 */
const experimentalRisk = {
  initialMarginBps: 1_000n, maintenanceMarginBps: 500n,
  maxOpenInterestWad: parseUnits("1000000", 18), // $1M notional OI
  maxSkewWad: parseUnits("100000000000000000", 18), // 1e17 base tokens
  maxPositionWad: parseUnits("100000", 18), // $100k notional / pos
  maxUtilizationBps: 9_000n, maxPriceImpactBps: 100n, tradingFeeBps: 10n, liquidationPenaltyBps: 500n,
  minSeedLiquidityWad: parseUnits("100000", 18), minInsuranceWad: parseUnits("10000", 18), minOracleLiquidityWad: parseUnits("1000000", 18),
  minOracleHistory: 86_400n, maxOracleConfidenceBps: 100n, maxOracleDeviationBps: 500n, oracleMaxAge: 31_536_000n, minOracleSources: 2,
  minCreatorBondWad: parseUnits("1000", 18), baseSpreadBps: 10n, longPayoutStressBps: 90_000n, shortPayoutStressBps: 10_000n,
  fundingVelocityWad: 1_000_000_000_000n, maxFundingRatePerSecondWad: 1_000_000_000_000n, maxFundingAccrualSeconds: 3_600n,
} as const;

/** Same caps for Create flow (price arg kept for API compat). */
function experimentalRiskForPrice(_priceUsd: number) {
  return { ...experimentalRisk };
}

const rpcUrl = process.env.NEXT_PUBLIC_RPC_URL ?? appChain.rpcUrls.default.http[0] ?? "https://rpc.testnet.chain.robinhood.com";
const publicClient = createPublicClient({ chain: appChain, transport: http(rpcUrl) });

/** Official mintable test collateral (apUSD). Wallet balance ≠ margin already deposited in a market. */
const APUSD_SYMBOL = "apUSD";
const APUSD_LABEL = "apUSD (test USD)";

async function readApUsdBalance(account: Address): Promise<{
  raw: bigint;
  decimals: number;
  amount: number;
  label: string;
}> {
  if (!demoCollateral || !isAddress(demoCollateral)) {
    return { raw: 0n, decimals: 6, amount: 0, label: "—" };
  }
  const [raw, decimals] = await Promise.all([
    publicClient.readContract({
      address: demoCollateral as Address,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [account],
    }),
    publicClient.readContract({
      address: demoCollateral as Address,
      abi: erc20Abi,
      functionName: "decimals",
    }),
  ]);
  const amount = Number(formatUnits(raw, decimals));
  return {
    raw,
    decimals,
    amount,
    label: amount.toLocaleString(undefined, { maximumFractionDigits: 2 }),
  };
}

/** Mint 250k apUSD to the connected wallet (testnet faucet). */
async function mintApUsdTo(account: Address): Promise<`0x${string}`> {
  if (!demoCollateral || !isAddress(demoCollateral)) throw new Error("apUSD address not configured.");
  if (!window.ethereum) throw new Error("Connect a wallet first.");
  const decimals = await publicClient.readContract({
    address: demoCollateral as Address,
    abi: erc20Abi,
    functionName: "decimals",
  });
  const amount = parseUnits("250000", decimals);
  const wallet = createWalletClient({ account, chain: appChain, transport: custom(window.ethereum) });
  const sim = await publicClient.simulateContract({
    account,
    address: demoCollateral as Address,
    abi: erc20Abi,
    functionName: "mint",
    args: [account, amount],
  });
  const hash = await wallet.writeContract(sim.request);
  await publicClient.waitForTransactionReceipt({ hash });
  return hash;
}

/**
 * Hosted API base.
 * - Default `same-origin`: browser calls /v1/* on anyperp.fun; Vercel rewrites proxy to Railway.
 *   This avoids client DNS blocks on `*.up.railway.app` (common cause of "API DOWN").
 * - Absolute URL: e.g. https://api.anyperp.fun or Railway host.
 * - `off` / `none`: disable hosted API (wallet + public Pyth/Dex only).
 */
const LIVE_API_DEFAULT = "same-origin";
const apiBaseRaw = (process.env.NEXT_PUBLIC_API_URL ?? LIVE_API_DEFAULT).trim();
const apiDisabled = !apiBaseRaw || apiBaseRaw === "off" || apiBaseRaw === "none";
const apiSameOrigin =
  !apiDisabled && (apiBaseRaw === "same-origin" || apiBaseRaw === "/" || apiBaseRaw === ".");
/** Empty string = same-origin relative fetch; absolute host otherwise; empty+disabled handled via apiEnabled. */
const apiBase = apiDisabled
  ? ""
  : apiSameOrigin
    ? ""
    : apiBaseRaw.replace(/\/$/, "");
const apiEnabled = !apiDisabled;

const PYTH_FEEDS_UI: Record<string, string> = {
  BTC: "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43",
  ETH: "ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace",
  SOL: "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d",
};

type PythPriceRow = {
  id: string;
  symbol?: string;
  price: number;
  conf: number;
  publishTimeIso: string;
  stale: boolean;
};
type DexProfileRow = {
  chainId: string;
  tokenAddress: string;
  url: string;
  icon?: string;
  description?: string;
};
type DexQuoteRef = {
  priceUsd: number | null;
  marketCap: number | null;
  fdv: number | null;
  volume24h: number | null;
  liquidityUsd: number | null;
  symbol?: string;
  name?: string;
  chainId?: string;
  url?: string;
  priceChange24h?: number | null;
};

function money(n: number | null | undefined, digits = 2) {
  if (n == null || !Number.isFinite(n)) return "—";
  if (Math.abs(n) >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (Math.abs(n) >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (Math.abs(n) >= 1e3) return `$${(n / 1e3).toFixed(2)}K`;
  return `$${n.toLocaleString(undefined, { maximumFractionDigits: digits })}`;
}

async function apiGet<T>(path: string): Promise<T> {
  if (!apiEnabled) throw new Error("no_api");
  const res = await fetch(`${apiBase}${path}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`API ${res.status}`);
  return res.json() as Promise<T>;
}

/** Direct public upstreams when hosted API is not configured (static Vercel). */
async function fetchPythDirect(symbols: string[]): Promise<PythPriceRow[]> {
  const ids = symbols.map((s) => PYTH_FEEDS_UI[s.toUpperCase()]).filter(Boolean);
  if (!ids.length) return [];
  const qs = ids.map((id) => `ids[]=${id}`).join("&");
  const res = await fetch(`https://hermes.pyth.network/v2/updates/price/latest?${qs}&parsed=true`);
  if (!res.ok) throw new Error(`Hermes ${res.status}`);
  const data = (await res.json()) as {
    parsed?: Array<{ id: string; price: { price: string; conf: string; expo: number; publish_time: number } }>;
  };
  const now = Math.floor(Date.now() / 1000);
  const byId = new Map(Object.entries(PYTH_FEEDS_UI).map(([sym, id]) => [id, sym]));
  return (data.parsed ?? []).map((row) => {
    const expo = row.price.expo;
    const price = Number(row.price.price) * 10 ** expo;
    const conf = Number(row.price.conf) * 10 ** expo;
    const id = row.id.replace(/^0x/i, "").toLowerCase();
    return {
      id,
      symbol: byId.get(id) ? `${byId.get(id)}/USD` : undefined,
      price,
      conf,
      publishTimeIso: new Date(row.price.publish_time * 1000).toISOString(),
      stale: now - row.price.publish_time > 120,
    };
  });
}

async function fetchDexProfilesDirect(): Promise<DexProfileRow[]> {
  const res = await fetch("https://api.dexscreener.com/token-profiles/latest/v1");
  if (!res.ok) throw new Error(`DexScreener ${res.status}`);
  const data = (await res.json()) as DexProfileRow[];
  return Array.isArray(data) ? data : [];
}

async function fetchDexQuoteDirect(q: string): Promise<DexQuoteRef | null> {
  const res = await fetch(`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(q)}`);
  if (!res.ok) throw new Error(`DexScreener ${res.status}`);
  const data = (await res.json()) as { pairs?: Array<Record<string, unknown>> };
  const pair = data.pairs?.[0];
  if (!pair) return null;
  const base = (pair.baseToken ?? {}) as Record<string, string>;
  const volume = (pair.volume ?? {}) as Record<string, number>;
  const liquidity = (pair.liquidity ?? {}) as Record<string, number>;
  const priceChange = (pair.priceChange ?? {}) as Record<string, number>;
  return {
    priceUsd: pair.priceUsd != null ? Number(pair.priceUsd) : null,
    marketCap: pair.marketCap != null ? Number(pair.marketCap) : null,
    fdv: pair.fdv != null ? Number(pair.fdv) : null,
    volume24h: volume.h24 != null ? Number(volume.h24) : null,
    liquidityUsd: liquidity.usd != null ? Number(liquidity.usd) : null,
    symbol: base.symbol,
    name: base.name,
    chainId: pair.chainId != null ? String(pair.chainId) : undefined,
    url: pair.url != null ? String(pair.url) : undefined,
    priceChange24h: priceChange.h24 != null ? Number(priceChange.h24) : null,
  };
}

function MarketDataRails() {
  const [pyth, setPyth] = useState<PythPriceRow[]>([]);
  const [profiles, setProfiles] = useState<DexProfileRow[]>([]);
  const [query, setQuery] = useState("robinhood");
  const [quote, setQuote] = useState<DexQuoteRef | null>(null);
  const [pythHit, setPythHit] = useState<PythPriceRow | null>(null);
  const [onchainIndex, setOnchainIndex] = useState<string>("—");
  const [status, setStatus] = useState("Loading market data…");
  const [err, setErr] = useState("");

  useEffect(() => {
    let cancelled = false;
    async function loadRails() {
      try {
        if (apiEnabled) {
          const [prices, latest] = await Promise.all([
            apiGet<{ prices: PythPriceRow[] }>("/v1/market-data/pyth/prices?symbols=BTC,ETH,SOL"),
            apiGet<{ profiles: DexProfileRow[] }>("/v1/market-data/dex/profiles/latest"),
          ]);
          if (cancelled) return;
          setPyth(prices.prices ?? []);
          setProfiles((latest.profiles ?? []).slice(0, 12));
          setStatus("Live: API → Pyth + DexScreener + on-chain index");
        } else {
          const [prices, profiles] = await Promise.all([
            fetchPythDirect(["BTC", "ETH", "SOL"]),
            fetchDexProfilesDirect(),
          ]);
          if (cancelled) return;
          setPyth(prices);
          setProfiles(profiles.slice(0, 12));
          setStatus("Live: browser → Hermes + DexScreener + on-chain index");
        }
        setErr("");
      } catch (cause) {
        if (!cancelled) {
          try {
            const [prices, profiles] = await Promise.all([
              fetchPythDirect(["BTC", "ETH", "SOL"]),
              fetchDexProfilesDirect(),
            ]);
            if (cancelled) return;
            setPyth(prices);
            setProfiles(profiles.slice(0, 12));
            setStatus("Live: direct Hermes + DexScreener (API fallback)");
            setErr("");
          } catch {
            setErr(cause instanceof Error ? cause.message : "Market data offline");
            setStatus("Market data offline");
          }
        }
      }
      if (demoMarket && isAddress(demoMarket)) {
        try {
          const index = await publicClient.readContract({
            address: demoMarket as Address,
            abi: marketAbi,
            functionName: "indexPrice",
          });
          if (!cancelled) {
            setOnchainIndex(
              `$${Number(formatUnits(index, 18)).toLocaleString(undefined, { maximumFractionDigits: 2 })}`,
            );
          }
        } catch {
          if (!cancelled) setOnchainIndex("—");
        }
      }
    }
    void loadRails();
    const t = setInterval(() => void loadRails(), 15_000);
    return () => { cancelled = true; clearInterval(t); };
  }, []);

  async function runSearch() {
    const q = query.trim();
    if (!q) return;
    setErr("");
    try {
      if (apiEnabled) {
        const body = await apiGet<{
          dexscreener: DexQuoteRef | null;
          pyth: PythPriceRow | null;
        }>(`/v1/market-data/quote?q=${encodeURIComponent(q)}&pythSymbol=${encodeURIComponent(q.toUpperCase())}`);
        setQuote(body.dexscreener);
        setPythHit(body.pyth);
        if (!body.dexscreener && !body.pyth) setErr("No DexScreener pair and no Pyth preset for that query.");
        return;
      }
      const [dex, pythList] = await Promise.all([
        fetchDexQuoteDirect(q),
        PYTH_FEEDS_UI[q.toUpperCase()] ? fetchPythDirect([q.toUpperCase()]) : Promise.resolve([] as PythPriceRow[]),
      ]);
      setQuote(dex);
      setPythHit(pythList[0] ?? null);
      if (!dex && !pythList[0]) setErr("No DexScreener pair and no Pyth preset for that query.");
    } catch (cause) {
      setErr(cause instanceof Error ? cause.message : "Search failed");
    }
  }

  return (
    <section className="panel" style={{ marginBottom: "1rem" }}>
      <div className="panel-title">
        <div>
          <h2>Market data rails</h2>
          <p className="section-copy" style={{ margin: 0 }}>{status}. DexScreener = MC/vol reference · Pyth = index reference · Settlement still on-chain oracle.</p>
        </div>
        <span className="badge blue">DEX + PYTH</span>
      </div>
      {err && <div className="warning-banner"><strong>Data</strong><span>{err}</span></div>}
      <div className="review-list" style={{ marginBottom: "1rem" }}>
        <div>
          <span>Demo market index (on-chain)</span>
          <strong>{onchainIndex}<br /><small>Pyth→MockOracle bridge</small></strong>
        </div>
        {pyth.length ? pyth.map((p) => (
          <div key={p.id}>
            <span>Pyth {p.symbol ?? p.id.slice(0, 8)}</span>
            <strong>
              {money(p.price, 4)}
              {p.stale ? " · stale" : ""}
              <br />
              <small className="mono">{p.publishTimeIso}</small>
            </strong>
          </div>
        )) : (
          <div><span>Pyth</span><strong>—</strong></div>
        )}
      </div>
      <div className="two-fields" style={{ marginBottom: "1rem" }}>
        <label className="search" style={{ flex: 1 }}>
          <span>DexScreener search / Pyth symbol</span>
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="pepe, solana mint, robinhood…" onKeyDown={(e) => { if (e.key === "Enter") void runSearch(); }} />
        </label>
        <button className="button primary" type="button" onClick={() => void runSearch()}>Quote</button>
      </div>
      {(quote || pythHit) && (
        <div className="review-list" style={{ marginBottom: "1rem" }}>
          {quote && (
            <>
              <div><span>Dex {quote.symbol ?? "pair"}</span><strong>{money(quote.priceUsd, 6)}</strong></div>
              <div><span>MC / FDV</span><strong>{money(quote.marketCap)} / {money(quote.fdv)}</strong></div>
              <div><span>24h vol / liq</span><strong>{money(quote.volume24h)} / {money(quote.liquidityUsd)}</strong></div>
              <div><span>Chain</span><strong>{quote.chainId ?? "—"}{quote.url ? <> · <a href={quote.url} target="_blank" rel="noreferrer">DexScreener ↗</a></> : null}</strong></div>
            </>
          )}
          {pythHit && (
            <div><span>Pyth index</span><strong>{pythHit.symbol ?? "feed"} · {money(pythHit.price, 6)}{pythHit.stale ? " · stale" : ""}</strong></div>
          )}
        </div>
      )}
      <div className="panel-title"><h2 style={{ fontSize: "1rem" }}>Latest DexScreener profiles</h2></div>
      <div className="table-scroll">
        <table>
          <thead><tr><th>Chain</th><th>Token</th><th>Note</th><th /></tr></thead>
          <tbody>
            {profiles.length ? profiles.map((p) => (
              <tr key={`${p.chainId}-${p.tokenAddress}`}>
                <td><strong>{p.chainId}</strong></td>
                <td><code className="mono">{p.tokenAddress.length > 16 ? `${p.tokenAddress.slice(0, 8)}…${p.tokenAddress.slice(-6)}` : p.tokenAddress}</code></td>
                <td>{(p.description || "—").slice(0, 80)}</td>
                <td>{p.url ? <a href={p.url} target="_blank" rel="noreferrer">Open ↗</a> : null}</td>
              </tr>
            )) : (
              <tr><td colSpan={4}>No profiles yet (API down or empty).</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** Secondary destinations — primary: Markets · Trade · Account · History · Create */
const moreViews: { id: View; label: string }[] = [
  { id: "contracts", label: "Contracts" },
  { id: "liquidity", label: "Liquidity" },
  { id: "risk", label: "Risk" },
  { id: "governance", label: "Governance" },
  { id: "admin", label: "Emergency" },
];

declare global {
  interface Window { ethereum?: { request(args: { method: string; params?: unknown[] }): Promise<unknown> } }
}

function short(address: string) { return `${address.slice(0, 6)}...${address.slice(-4)}`; }

/** Decimal string safe for viem parseUnits (never scientific notation). */
function decimalString(n: number, maxFrac = 18): string {
  if (!Number.isFinite(n) || n === 0) return "0";
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  // Large base sizes (cheap tokens): keep as integer string
  if (abs >= 1e12) return sign + Math.round(abs).toString();
  let s = abs.toFixed(Math.min(maxFrac, abs >= 1 ? 8 : 18));
  if (s.includes(".")) s = s.replace(/\.?0+$/, "");
  return sign + (s || "0");
}

function formatUsd(n: number, digits = 2): string {
  if (!Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  if (abs > 0 && abs < 0.01) return `${n < 0 ? "-" : ""}$${abs.toPrecision(3)}`;
  return `${n < 0 ? "-" : ""}$${abs.toLocaleString(undefined, { maximumFractionDigits: digits })}`;
}

function formatTokenAmt(n: number): string {
  if (!Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  if (abs === 0) return "0";
  if (abs >= 1e6) return n.toLocaleString(undefined, { maximumFractionDigits: 0 });
  if (abs >= 1) return n.toLocaleString(undefined, { maximumFractionDigits: 4 });
  if (abs >= 0.0001) return n.toLocaleString(undefined, { maximumFractionDigits: 6 });
  return n.toPrecision(4);
}

export default function Home() {
  const [view, setView] = useState<View>("landing");
  const [account, setAccount] = useState<Address>();
  const [networkError, setNetworkError] = useState("");
  const [moreOpen, setMoreOpen] = useState(false);
  const [tradeMarketPref, setTradeMarketPref] = useState<string>(
    demoMarket && isAddress(demoMarket) ? demoMarket : LISTED_MARKETS[0]?.market ?? "",
  );

  const moreActive = moreViews.some((m) => m.id === view);

  useEffect(() => {
    const surface = new URLSearchParams(window.location.search).get("surface");
    const hostname = window.location.hostname.toLowerCase();
    // App opens on Trade (HL-style desk), not Overview brochure
    const target =
      surface === "docs" || hostname.startsWith("docs.")
        ? "docs"
        : surface === "app" || hostname.startsWith("app.")
          ? "trade"
          : null;
    if (!target) return;
    const timer = window.setTimeout(() => setView(target as View), 0);
    return () => window.clearTimeout(timer);
  }, []);

  // After Docs (or whitepaper) mounts, scroll to hash target (e.g. #whitepaper)
  useEffect(() => {
    if (view !== "docs") return;
    const id = window.location.hash.replace(/^#/, "");
    if (!id) return;
    const timer = window.setTimeout(() => {
      document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 120);
    return () => window.clearTimeout(timer);
  }, [view]);

  useEffect(() => {
    if (!moreOpen) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest?.(".more-menu")) return;
      setMoreOpen(false);
    };
    document.addEventListener("click", onDoc);
    return () => document.removeEventListener("click", onDoc);
  }, [moreOpen]);

  function go(next: View) {
    setView(next);
    setMoreOpen(false);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function openSurface(surface: "landing" | "docs" | "app", hash?: string) {
    const configured = surface === "landing" ? process.env.NEXT_PUBLIC_SITE_URL : surface === "docs" ? process.env.NEXT_PUBLIC_DOCS_URL : process.env.NEXT_PUBLIC_APP_URL;
    const isLocal = window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1";
    const fragment = hash ? (hash.startsWith("#") ? hash : `#${hash}`) : "";
    // Prefer SPA navigation on same origin so whitepaper hash scrolls reliably
    let sameOrigin = false;
    try {
      if (configured) sameOrigin = new URL(configured, window.location.origin).origin === window.location.origin;
    } catch { /* ignore */ }
    if (configured && !isLocal && !sameOrigin) {
      window.location.assign(`${configured}${fragment}`);
      return;
    }
    setView(surface === "app" ? "trade" : surface);
    window.history.replaceState({}, "", `${surface === "landing" ? "/" : `/?surface=${surface}`}${fragment}`);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function connect() {
    setNetworkError("");
    if (!window.ethereum) { setNetworkError("No injected wallet found. Install a compatible EVM wallet."); return; }
    try {
      await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0xb626" }] });
    } catch {
      await window.ethereum.request({ method: "wallet_addEthereumChain", params: [{
        chainId: "0xb626", chainName: "Robinhood Chain Testnet", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
        rpcUrls: ["https://rpc.testnet.chain.robinhood.com"], blockExplorerUrls: ["https://explorer.testnet.chain.robinhood.com"]
      }] });
    }
    const addresses = await window.ethereum.request({ method: "eth_requestAccounts" }) as Address[];
    setAccount(addresses[0]);
  }

  return (
    <main>
      <header className="topbar">
        <button className="brand" onClick={() => openSurface("landing")} aria-label="AnyPerp home">
          <Image className="brand-mark" src="/logo/anyperp-logo.svg" alt="" width={30} height={30} unoptimized priority /><span>AnyPerp</span>{view === "docs" ? <span className="docs-tag">DOCS</span> : <span className="testnet-tag">TESTNET</span>}
        </button>
        {view === "landing" ? <nav className="desktop-nav landing-nav" aria-label="Landing navigation">
          <a href="#how-it-works">How it works</a>
          <a href="#architecture">Architecture</a>
          <a href="#risk-boundaries">Risk</a>
          <a href="#deployment">Contracts</a>
          <button type="button" onClick={() => openSurface("docs")}>Docs</button>
          <a
            href="/?surface=docs#whitepaper"
            className="nav-whitepaper"
            onClick={(e) => { e.preventDefault(); openSurface("docs", "whitepaper"); }}
          >
            Whitepaper
          </a>
        </nav> : view === "docs" ? <nav className="desktop-nav" aria-label="Documentation navigation">
          <a href="#overview">Overview</a>
          <a href="#whitepaper" className="nav-whitepaper">Whitepaper</a>
          <a href="#oracle">Oracles</a>
          <a href="#risk">Risk</a>
          <a href="#contracts">Contracts</a>
          <a href="#api">API</a>
        </nav> : <nav className="desktop-nav app-primary-nav" aria-label="Primary navigation">
          <button type="button" className={view === "markets" ? "nav-active" : ""} onClick={() => go("markets")}>Markets</button>
          <button type="button" className={view === "trade" ? "nav-active" : ""} onClick={() => go("trade")}>Trade</button>
          <button type="button" className={view === "portfolio" ? "nav-active" : ""} onClick={() => go("portfolio")}>Account</button>
          <button type="button" className={view === "history" ? "nav-active" : ""} onClick={() => go("history")}>History</button>
          <button type="button" className={view === "create" ? "nav-active" : ""} onClick={() => go("create")}>Create</button>
          <a
            href="/?surface=docs#whitepaper"
            className="nav-whitepaper"
            onClick={(e) => { e.preventDefault(); openSurface("docs", "whitepaper"); }}
          >
            Whitepaper
          </a>
          <div className="more-menu">
            <button
              type="button"
              className={moreActive || moreOpen ? "nav-active" : ""}
              aria-expanded={moreOpen}
              aria-haspopup="menu"
              onClick={(e) => { e.stopPropagation(); setMoreOpen((v) => !v); }}
            >
              More ▾
            </button>
            {moreOpen && (
              <div className="more-dropdown" role="menu">
                {moreViews.map((item) => (
                  <button key={item.id} type="button" role="menuitem" className={view === item.id ? "active" : ""} onClick={() => go(item.id)}>
                    {item.label}
                  </button>
                ))}
                <button type="button" role="menuitem" onClick={() => { setMoreOpen(false); openSurface("docs", "whitepaper"); }}>
                  Whitepaper
                </button>
              </div>
            )}
          </div>
        </nav>}
        <div className="top-actions">
          <LiveBackendPill />
          <span className="chain-pill"><span className="status-dot" /> Robinhood Testnet</span>
          {view === "landing" || view === "docs" ? (
            <button className="button primary landing-launch" onClick={() => openSurface("app")}>Open app</button>
          ) : (
            <button className="button secondary wallet-button" onClick={connect}>{account ? short(account) : "Connect wallet"}</button>
          )}
        </div>
      </header>

      {networkError && <div className="global-error" role="alert">{networkError}</div>}
      <LiveStackBanner />

      {view === "landing" ? (
        <Landing
          onLaunch={() => openSurface("app")}
          onCreate={() => { setView("create"); window.history.replaceState({}, "", "/?surface=app"); }}
          onRisk={() => setView("risk")}
          onDocs={(hash?: string) => openSurface("docs", hash)}
        />
      ) : view === "docs" ? (
        <DocsPortal onHome={() => openSurface("landing")} onLaunch={() => openSurface("app")} />
      ) : (
        <div className={`app-shell app-shell--flat ${view === "trade" ? "app-shell--trade" : ""}`}>
          <section className="content content-trade-ux">
            {view === "home" && <Markets onCreate={() => go("create")} onTrade={(m) => { if (m) setTradeMarketPref(m); go("trade"); }} />}
            {view === "markets" && <Markets onCreate={() => go("create")} onTrade={(m) => { if (m) setTradeMarketPref(m); go("trade"); }} />}
            {view === "trade" && (
              <Trade
                account={account}
                onConnect={connect}
                initialMarket={tradeMarketPref}
                onOpenMarkets={() => go("markets")}
                onOpenAccount={() => go("portfolio")}
                onOpenCreate={() => go("create")}
              />
            )}
            {view === "create" && (
              <CreateMarket
                account={account}
                onConnect={connect}
                onTrade={(m) => { if (m) setTradeMarketPref(m); go("trade"); }}
              />
            )}
            {view === "liquidity" && <Liquidity account={account} onConnect={connect} onMarkets={() => go("markets")} />}
            {view === "portfolio" && <Portfolio account={account} onConnect={connect} onTrade={() => go("trade")} />}
            {view === "history" && <History account={account} onConnect={connect} onTrade={() => go("trade")} />}
            {view === "contracts" && <OfficialContracts />}
            {view === "governance" && <Governance />}
            {view === "risk" && <RiskDisclosure />}
            {view === "admin" && <EmergencyConsole />}
          </section>
          <nav className="bottom-nav" aria-label="Mobile primary">
            <button type="button" className={view === "markets" ? "bottom-nav-active" : ""} onClick={() => go("markets")}>
              <span className="bn-ico" aria-hidden>▤</span>Markets
            </button>
            <button type="button" className={view === "trade" ? "bottom-nav-active" : ""} onClick={() => go("trade")}>
              <span className="bn-ico" aria-hidden>◈</span>Trade
            </button>
            <button type="button" className={view === "history" ? "bottom-nav-active" : ""} onClick={() => go("history")}>
              <span className="bn-ico" aria-hidden>☰</span>History
            </button>
            <button type="button" className={view === "create" ? "bottom-nav-active" : ""} onClick={() => go("create")}>
              <span className="bn-ico" aria-hidden>+</span>Create
            </button>
          </nav>
        </div>
      )}
    </main>
  );
}

function formatMoney(n: number, digits = 2) {
  const sign = n < 0 ? "-" : "";
  return `${sign}$${Math.abs(n).toFixed(digits)}`;
}

function LivePositionCard() {
  const entry = 1.284;
  const size = 42.5;
  const lev = 3.2;
  const holders = ["0x7AE...DB2A", "0x83A...7C9E", "0x4Bf...A102", "0xC21...9F4D", "0x91E...3B08"];
  const [tick, setTick] = useState(0);
  const [flash, setFlash] = useState(false);

  useEffect(() => {
    const reduced = typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced) return;
    const id = window.setInterval(() => {
      setTick((t) => t + 1);
      setFlash(true);
      window.setTimeout(() => setFlash(false), 280);
    }, 1600);
    return () => window.clearInterval(id);
  }, []);

  const markDelta = Math.sin(tick * 0.85) * 0.014 + Math.cos(tick * 0.41) * 0.006;
  const mark = entry + markDelta;
  const pnl = (mark - entry) * size;
  const value = Math.abs(size) * mark * 0.018;
  const ask = 2.4 + Math.sin(tick * 0.55) * 0.42 + Math.cos(tick * 0.2) * 0.12;
  const holder = holders[tick % holders.length];
  const pnlPositive = pnl >= 0;

  return (
    <article className="live-position-card" aria-label="Live isolated market position preview">
      <div className="live-card-glow" aria-hidden="true" />
      <header className="live-card-head">
        <div className="live-card-tags">
          <span className="live-side long">LONG</span>
          <span className="live-pair">TOKEN-PERP</span>
        </div>
        <span className="live-status"><i /> PREVIEW</span>
      </header>
      <div className={`live-pnl ${pnlPositive ? "up" : "down"} ${flash ? "tick" : ""}`}>
        <strong>{formatMoney(pnl)}</strong>
        <span>UNREALIZED</span>
      </div>
      <div className="live-metrics">
        <div><span>ENTRY</span><b>{formatMoney(entry, 3)}</b></div>
        <div><span>MARK</span><b className={flash ? "tick" : ""}>{formatMoney(mark, 3)}</b></div>
        <div><span>SIZE</span><b>{size.toFixed(1)} · {lev.toFixed(1)}x</b></div>
        <div><span>VALUE</span><b className={flash ? "tick" : ""}>{formatMoney(value)}</b></div>
      </div>
      <footer className="live-card-foot">
        <div>
          <span>ASK PRICE</span>
          <strong className={flash ? "tick" : ""}>{formatMoney(ask)}</strong>
        </div>
        <small>isolated · {holder}</small>
      </footer>
    </article>
  );
}

function Landing({ onLaunch, onCreate, onRisk, onDocs }: { onLaunch(): void; onCreate(): void; onRisk(): void; onDocs(hash?: string): void }) {
  const factory = process.env.NEXT_PUBLIC_MARKET_FACTORY_ADDRESS;
  return <div className="landing-main">
    <section className="landing-hero">
      <div className="hero-copy">
        <p className="landing-eyebrow anim-fade-up"><span /> anyperp.fun · live testnet stack</p>
        <h1 className="anim-fade-up-delay-1">Any token.<br />A perp.<br />Today.</h1>
        <p className="hero-lede anim-fade-up-delay-2">Paste a token CA. Fund LP. Platform handles price and risk. Then anyone can long or short — no exchange listing wait.</p>
        <div className="hero-actions anim-fade-up-delay-3"><button className="button primary hero-button" onClick={onCreate}>Create a market</button><button className="button secondary hero-button" onClick={onLaunch}>Start trading</button></div>
        <div className="hero-footnotes anim-fade-up-delay-3">
          <span><b>Robinhood Chain</b> testnet</span>
          <span><b>API + keepers</b> hosted</span>
          <span><b>Onchain</b> activation gates</span>
          <span><b>Mock apUSD</b> · unaudited</span>
        </div>
      </div>
      <div className="hero-visual anim-fade-up-delay-2">
        <figure className="hero-photo"><Image src="/anyperp-hero.svg" alt="Trading chart with three validated isolated market vault cards" width={1600} height={900} priority unoptimized /><figcaption><span>ISOLATED MARKETS</span> One market breaks - the others keep trading.</figcaption></figure>
        <div className="hero-float-stack">
          <LivePositionCard />
          <div className="protocol-map protocol-map-compact" aria-label="Isolated market architecture">
            <div className="map-head"><span className="badge blue">YOUR MARKET</span><span className="map-state">Ready to activate</span></div>
            <div className="asset-row"><span className="asset-token">T</span><div><small>BASE TOKEN</small><strong>Any supported ERC-20</strong></div><span className="tier-chip">Experimental</span></div>
            <div className="isolation-box"><div className="box-label">ISOLATED MARKET</div><div className="vault-grid"><div><small>LP VAULT</small><strong>This market only</strong></div><div><small>INSURANCE</small><strong>First line of defense</strong></div><div><small>OPEN INTEREST</small><strong>Hard capped</strong></div><div><small>LEVERAGE</small><strong>Tier limited</strong></div></div></div>
          </div>
        </div>
      </div>
    </section>

    <section className="landing-strip" aria-label="Product principles"><span>Create in minutes</span><span>Trade when it&apos;s safe</span><span>Risk stays isolated</span><span>Rules live onchain</span></section>

    <div className="feature-media-strip" aria-hidden="true"><Image src="/anyperp-icons.svg" alt="" width={1600} height={440} unoptimized /></div>

    <section className="landing-section problem-section">
      <div className="section-intro"><p className="landing-eyebrow">Why AnyPerp exists</p><h2>The token is live.<br />The perp isn&apos;t. That&apos;s broken.</h2><p>New coins move in hours. Listings take weeks - if they happen at all. You shouldn&apos;t need a board meeting to long or short something that already trades onchain.</p></div>
      <div className="problem-cards"><article><span>01</span><h3>Spot only goes one way</h3><p>You can buy the token. You can&apos;t short it. You can&apos;t size up with leverage when conviction is high.</p></article><article><span>02</span><h3>Gatekeepers own the timeline</h3><p>Someone else decides if your token is &quot;big enough&quot; for a perp. By then, the move is over.</p></article><article><span>03</span><h3>Shared pools punish everyone</h3><p>One thin market blows up - and LPs in totally different markets pay the price. Isolated vaults fix that.</p></article></div>
    </section>

    <section className="landing-section steps-section" id="how-it-works">
      <div className="section-heading"><div><p className="landing-eyebrow">How it works</p><h2>CA in. Market live.<br />Anyone can trade.</h2></div><p>You only pick the token and put LP. Oracle, collateral, risk rails — platform. When it opens, anyone longs or shorts.</p></div>
      <div className="landing-steps">{[
        ["01", "Paste the CA", "Only the token contract address. No oracle IDs. No collateral paste."],
        ["02", "Platform wires price", "Feeds and risk rails run in the backend. You never see that mess."],
        ["03", "You set LP", "One amount. Bond and insurance size themselves. Confirm in wallet."],
        ["04", "Anyone longs / shorts", "Market opens. Traders trade. Isolated vault keeps the mess contained."],
      ].map(([number, title, text]) => <article key={number}><span>{number}</span><h3>{title}</h3><p>{text}</p></article>)}</div>
    </section>

    <section className="landing-section architecture-section" id="architecture">
      <div className="architecture-copy"><p className="landing-eyebrow">Built for wild tokens</p><h2>Every market is its own island.</h2><p>Its own LP vault. Its own margin. Its own insurance. Its own kill switch. If one market melts down, it cannot silently drain the rest.</p><ul><li>Fills start from real spot prices, then nudge with skew</li><li>Liquidations close only what they need - when they can</li><li>Sick markets go reduce-only, pause, or settle cleanly</li><li>Losses hit this market&apos;s insurance before any capped backstop</li></ul><button className="text-link" onClick={onRisk}>How we handle risk <span>{"\u2192"}</span></button></div>
      <div className="isolation-visual">
        <div className="architecture-media"><Image src="/anyperp-architecture.svg" alt="Isolated market lane architecture" width={1100} height={560} unoptimized /></div>
        <div className="visual-title"><strong>Hard boundary</strong><span>No cross-market drain</span></div>
        {["TOKEN A-PERP", "TOKEN B-PERP", "TOKEN C-PERP"].map((name, index) => <div className="market-lane" key={name}><div><span className={`lane-dot lane-${index + 1}`} /><strong>{name}</strong></div><div className="lane-modules"><span>Margin</span><span>LP vault</span><span>Insurance</span></div><b>Isolated</b></div>)}
      </div>
    </section>

    <section className="landing-section risk-section" id="risk-boundaries">
      <div className="section-heading"><div><p className="landing-eyebrow">Open creation. Locked trading.</p><h2>A weak market can draft.<br />It can&apos;t fake being live.</h2></div><p>If price or health fails, new risk freezes. Guardians can pause - they cannot grab funds or crank leverage.</p></div>
      <div className="risk-boundary-grid"><article><strong>Stale price feed</strong><p>No new positions. You can still reduce risk when a safe price is available.</p></article><article><strong>Thin spot liquidity</strong><p>Exposure shrinks. The market can flip to reduce-only until depth returns.</p></article><article><strong>Vault maxed out</strong><p>Trades and withdrawals that make imbalance worse get blocked.</p></article><article><strong>Position underwater</strong><p>Your margin → this market&apos;s insurance → capped backstop → ADL.</p></article></div>
    </section>

    <section className="landing-section deployment-section" id="deployment">
      <div>
        <p className="landing-eyebrow">{networkMode === "mainnet" ? "Mainnet" : "Testnet, not mainnet"}</p>
        <h2>Check the contracts yourself.</h2>
        <p>
          Official AnyPerp addresses on {networkLabel} (chain {appChain.id}). apUSD is mintable test collateral — not real USDT.
          Unaudited prototype; verify on explorer before you sign.
        </p>
        <div className="landing-contract-network">
          <span>NETWORK</span>
          <strong>{networkLabel} · {appChain.id}</strong>
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 12, marginTop: 16 }}>
          <button type="button" className="text-link" onClick={onDocs}>
            Docs &amp; deploy notes <span>→</span>
          </button>
          <a className="text-link" href="/?surface=docs#whitepaper" onClick={(e) => { e.preventDefault(); onDocs("whitepaper"); }}>
            Whitepaper <span>→</span>
          </a>
          <a className="text-link" href={WHITEPAPER_PATH} download="AnyPerp-Whitepaper-v0.1.pdf">
            Download PDF <span>↓</span>
          </a>
        </div>
      </div>
      <div className="contract-proof contract-proof--list" aria-label="Official protocol contracts">
        {OFFICIAL_CONTRACTS.filter((c) => c.address && isAddress(c.address) && !/Demo market/i.test(c.name)).map((c) => (
          <div key={c.address + c.name} className="contract-proof-row">
            <div className="contract-proof-meta">
              <span>
                {c.name}
                {c.mintable ? <em className="contract-mint-tag">MINT</em> : null}
              </span>
              <small>{c.role}</small>
            </div>
            <div className="contract-proof-addr">
              <code title={c.address}>{short(c.address)}</code>
              <a href={`${explorerBase}/address/${c.address}`} target="_blank" rel="noreferrer">
                Explorer ↗
              </a>
            </div>
          </div>
        ))}
      </div>
    </section>

    <section className="landing-cta"><div><p className="landing-eyebrow">anyperp.fun</p><h2>Any token. A perp.<br />Make the market.</h2></div><div><button className="button cta-light" onClick={onCreate}>Create a market</button><button className="button cta-outline" onClick={onLaunch}>Open the app</button></div></section>
    <footer className="landing-footer">
      <div className="footer-brand">
        <Image className="brand-mark" src="/logo/anyperp-logo.svg" alt="" width={34} height={34} unoptimized />
        <div>
          <strong>AnyPerp</strong>
          <small>anyperp.fun · {networkMode} · chain {appChain.id}</small>
        </div>
      </div>
      <div>
        <button type="button" onClick={() => onDocs()}>Docs</button>
        <a
          href="/?surface=docs#whitepaper"
          className="footer-whitepaper"
          onClick={(e) => { e.preventDefault(); onDocs("whitepaper"); }}
        >
          Whitepaper
        </a>
        <button type="button" onClick={onLaunch}>App</button>
        <button type="button" onClick={onRisk}>Risk</button>
        <a href="https://x.com/tradeanyperp" target="_blank" rel="noreferrer">X</a>
        <a href="https://github.com/AnyPerp/anyperp" target="_blank" rel="noreferrer">GitHub</a>
        {factory && isAddress(factory) && (
          <a href={`${explorerBase}/address/${factory}`} target="_blank" rel="noreferrer">Explorer ↗</a>
        )}
      </div>
    </footer>
  </div>;
}

function PageHead({ eyebrow, title, description, action }: { eyebrow: string; title: string; description: string; action?: React.ReactNode }) {
  return <div className="page-head"><div><p className="eyebrow">{eyebrow}</p><h1>{title}</h1><p>{description}</p></div>{action}</div>;
}

type OpsStatus = {
  service?: string;
  chainId?: number;
  blockNumber?: string | null;
  rpcOk?: boolean;
  databaseOk?: boolean;
  projections?: { available?: boolean; markets?: number; openAccounts?: number; trades?: number };
  honesty?: { audit?: string; realFunds?: boolean };
};

function useOpsStatus(pollMs = 20_000) {
  const [ops, setOps] = useState<OpsStatus | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!apiEnabled) {
      setOps(null);
      setError("API off");
      return;
    }
    let cancelled = false;
    async function load() {
      try {
        const body = await apiGet<OpsStatus>("/v1/ops/status");
        if (!cancelled) {
          setOps(body);
          setError("");
        }
      } catch (cause) {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : "API offline");
        }
      }
    }
    void load();
    const t = setInterval(() => void load(), pollMs);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [pollMs]);
  return { ops, error };
}

function LiveBackendPill() {
  const { ops, error } = useOpsStatus(30_000);
  const live = Boolean(ops?.rpcOk && ops?.databaseOk && !error);
  // Public pill: short status only. Ops detail stays in title tooltip for support.
  const title = live
    ? "Connected to testnet backend"
    : error
      ? `Backend: ${error}`
      : "Connecting…";
  return (
    <span className={`backend-pill ${live ? "ok" : error ? "bad" : "wait"}`} title={title}>
      <span className="status-dot" />
      {live ? "Live" : error ? "Offline" : "…"}
    </span>
  );
}

/**
 * Public status strip — keep marketing-safe.
 * Healthy: no ops dump (block / projections / ops link). Failures: short user-facing note only.
 */
function LiveStackBanner() {
  const { ops, error } = useOpsStatus(25_000);
  if (!apiEnabled) {
    return null;
  }
  if (error) {
    return (
      <div className="live-stack-banner bad" role="status">
        <strong>Temporarily limited</strong>
        <span>Some live data may be delayed. Wallet trading still works when the chain is up.</span>
      </div>
    );
  }
  if (!ops) {
    return null;
  }
  // Success: no public ops banner — hero + badges already say testnet.
  return null;
}

function Overview({ onCreate, onMarkets }: { onCreate(): void; onMarkets(): void }) {
  return <>
    <PageHead eyebrow="Your trading desk" title="Find a market. Or invent one." description="Browse live perps, or create one for a token nobody listed yet. Trading only opens after price, LP, insurance, and risk checks pass." action={<button className="button primary" onClick={onCreate}>Create a market</button>} />
    <div className="warning-banner"><strong>Testnet only · live stack</strong><span>Unaudited. API + keepers + indexer are hosted; apUSD is mock. Don&apos;t use real funds.</span></div>
    <div className="overview-grid">
      <section className="panel workflow-panel"><div className="panel-title"><h2>From idea to live market</h2><span className="badge blue">4 STEPS</span></div>
        <div className="activation-flow">
          {["Pick a token", "Prove the price", "Fund the vault", "Open trading"].map((label, index) => <div className="flow-step" key={label}><span>{index + 1}</span><div><strong>{label}</strong><small>{["Bond posts with you", "Fresh feeds + depth", "LP + insurance here only", "Caps stay on"][index]}</small></div></div>)}
        </div>
      </section>
      <section className="panel"><div className="panel-title"><h2>Risk in one glance</h2><span className="badge green">ISOLATED</span></div>
        <dl className="definition-list"><div><dt>Collateral</dt><dd>Approved USD tokens</dd></div><div><dt>LP liquidity</dt><dd>One vault per market</dd></div><div><dt>Your fill</dt><dd>Spot price + skew</dd></div><div><dt>If it breaks</dt><dd>Reduce-only → settle</dd></div></dl>
      </section>
    </div>
    <section className="panel markets-preview"><div className="panel-title"><div><h2>Live markets</h2><p>BTC · ETH · SOL (Pyth) + Robinhood tokens. Isolated per market.</p></div><button className="text-button" onClick={onMarkets}>See all markets</button></div>
      {LISTED_MARKETS.length ? (
        <div className="review-list">
          {LISTED_MARKETS.map((m) => (
            <div key={m.market}>
              <span>{m.symbol}-PERP</span>
              <strong className="mono">{short(m.market)} · {m.source === "dexscreener-robinhood" ? "RH dex" : "Pyth"}</strong>
            </div>
          ))}
          <div><span>Action</span><button className="text-button" type="button" onClick={onMarkets}>Trade / browse</button></div>
        </div>
      ) : (
        <EmptyState title="Be the first market" text="Nothing is live yet. Create one, clear the checks, and you own the first listing." action="Create a market" onAction={onCreate} />
      )}
    </section>
  </>;
}

function Markets({ onCreate, onTrade }: { onCreate(): void; onTrade(market?: string): void }) {
  const tradeable = useTradeableMarkets();
  const [rows, setRows] = useState<
    Array<{
      symbol: string;
      label?: string;
      market: string;
      state: number;
      index: string;
      longOi: string;
      shortOi: string;
      free: string;
      assets: string;
      badDebt: string;
      source?: string;
    }>
  >([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const out: typeof rows = [];
      for (const m of tradeable) {
        if (!isAddress(m.market)) continue;
        try {
          const [state, index, longOi, shortOi, badDebtWad] = await Promise.all([
            publicClient.readContract({ address: m.market as Address, abi: marketAbi, functionName: "state" }),
            publicClient.readContract({ address: m.market as Address, abi: marketAbi, functionName: "indexPrice" }),
            publicClient.readContract({ address: m.market as Address, abi: marketAbi, functionName: "longOpenInterestBaseWad" }),
            publicClient.readContract({ address: m.market as Address, abi: marketAbi, functionName: "shortOpenInterestBaseWad" }),
            publicClient.readContract({ address: m.market as Address, abi: marketAbi, functionName: "badDebtWad" }),
          ]);
          let assets = "—";
          let free = "—";
          const vault = "liquidityVault" in m ? m.liquidityVault : undefined;
          if (vault && isAddress(vault)) {
            const [total, freeRaw] = await Promise.all([
              publicClient.readContract({ address: vault as Address, abi: liquidityVaultAbi, functionName: "totalAssets" }),
              publicClient.readContract({ address: vault as Address, abi: liquidityVaultAbi, functionName: "freeAssets" }),
            ]);
            assets = Number(formatUnits(total, 6)).toLocaleString(undefined, { maximumFractionDigits: 0 });
            free = Number(formatUnits(freeRaw, 6)).toLocaleString(undefined, { maximumFractionDigits: 0 });
          }
          out.push({
            symbol: m.symbol,
            label: m.label,
            market: m.market,
            state: Number(state),
            index: Number(formatUnits(index, 18)).toLocaleString(undefined, {
              maximumFractionDigits: Number(formatUnits(index, 18)) < 0.01 ? 8 : 4,
            }),
            longOi: Number(formatUnits(longOi as bigint, 18)).toLocaleString(undefined, { maximumFractionDigits: 4 }),
            shortOi: Number(formatUnits(shortOi as bigint, 18)).toLocaleString(undefined, { maximumFractionDigits: 4 }),
            free,
            assets,
            badDebt: Number(formatUnits(badDebtWad as bigint, 18)).toLocaleString(undefined, { maximumFractionDigits: 2 }),
            source: m.source,
          });
        } catch {
          out.push({
            symbol: m.symbol,
            label: m.label,
            market: m.market,
            state: -1,
            index: "—",
            longOi: "—",
            shortOi: "—",
            free: "—",
            assets: "—",
            badDebt: "—",
            source: m.source,
          });
        }
      }
      if (!cancelled) setRows(out);
    })();
    return () => { cancelled = true; };
  }, [tradeable]);

  const [q, setQ] = useState("");
  const filtered = rows.filter((r) => {
    if (!q.trim()) return true;
    const s = q.trim().toLowerCase();
    return r.symbol.toLowerCase().includes(s) || r.label?.toLowerCase().includes(s) || r.market.toLowerCase().includes(s);
  });

  return (
    <div className="markets-board">
      <div className="markets-board-head">
        <div>
          <h1>Markets</h1>
          <p>Deployed &amp; tradeable only · one market per CA · new creates show here instantly</p>
        </div>
        <button className="button primary" type="button" onClick={onCreate}>Create market</button>
      </div>
      <div className="filters markets-filters">
        <label className="search">
          <span className="sr-only">Search</span>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search symbol…" />
        </label>
      </div>
      <section className="panel table-panel markets-table-panel">
        <div className="table-scroll">
          <table className="markets-table">
            <thead>
              <tr>
                <th>Market</th>
                <th>Mark</th>
                <th>OI (L / S)</th>
                <th>LP free</th>
                <th>State</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {filtered.length ? filtered.map((r) => (
                <tr
                  key={r.market}
                  className="markets-row"
                  onClick={() => onTrade(r.market)}
                  onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onTrade(r.market); } }}
                  tabIndex={0}
                  role="link"
                >
                  <td>
                    <strong>{r.symbol}-PERP</strong>
                    {r.label ? <small className="markets-sub">{r.label}</small> : null}
                  </td>
                  <td className="mono">${r.index}</td>
                  <td className="mono">{r.longOi} / {r.shortOi}</td>
                  <td className="mono">{r.free === "—" ? "—" : r.free}</td>
                  <td>
                    <span className={`badge ${r.state === 3 ? "green" : "amber"}`}>
                      {r.state >= 0 ? (marketStates[r.state] ?? r.state) : "…"}
                    </span>
                  </td>
                  <td>
                    <button
                      className="button primary sm"
                      type="button"
                      onClick={(e) => { e.stopPropagation(); onTrade(r.market); }}
                    >
                      Trade
                    </button>
                  </td>
                </tr>
              )) : (
                <tr className="empty-row">
                  <td colSpan={6}>
                    <EmptyState title={rows.length ? "No match" : "Loading markets…"} text={rows.length ? "Try another symbol." : "Reading live markets."} action="Create" onAction={onCreate} />
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function Trade({
  account,
  onConnect,
  initialMarket,
  onOpenMarkets,
  onOpenAccount,
  onOpenCreate,
}: {
  account?: Address;
  onConnect(): void;
  initialMarket?: string;
  onOpenMarkets?(): void;
  onOpenAccount?(): void;
  onOpenCreate?(): void;
}) {
  const [side, setSide] = useState<"long" | "short">("long");
  const tradeable = useTradeableMarkets();
  const startMarket =
    (initialMarket && isAddress(initialMarket) ? initialMarket : undefined) ||
    (demoMarket && isAddress(demoMarket) ? demoMarket : undefined) ||
    LISTED_MARKETS[0]?.market ||
    "";
  const [market, setMarket] = useState(startMarket);
  // At ~$64k index + 9x stress reserve, size 1 needs ~$576k LP headroom — default tiny.
  const [size, setSize] = useState("0.05");
  const [limit, setLimit] = useState("");
  /** $ amount user wants to put up as margin (simple UX) */
  const [pay, setPay] = useState("100");
  const [leverage, setLeverage] = useState(5);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  /** Mobile: Chart vs Trade ticket (HL-style) */
  const [mobileTab, setMobileTab] = useState<"chart" | "ticket">("chart");
  const [txState, setTxState] = useState<TxState>("idle");
  const [error, setError] = useState("");
  const [faucetStatus, setFaucetStatus] = useState("");
  const [keeperStatus, setKeeperStatus] = useState("");
  const [walletApUsd, setWalletApUsd] = useState<string>("—");
  const [walletApUsdN, setWalletApUsdN] = useState(0);
  const [balTick, setBalTick] = useState(0);
  const [requestWalletSync, setRequestWalletSync] = useState(false);
  const [dexChange24h, setDexChange24h] = useState<number | null>(null);
  const [dexLivePrice, setDexLivePrice] = useState<number | null>(null);
  /** Bump after oracle push so index / PnL re-read immediately */
  const [oracleTick, setOracleTick] = useState(0);
  const [baseToken, setBaseToken] = useState<string | undefined>();
  const [marketInfo, setMarketInfo] = useState<{
    registered: boolean; state: number; index: bigint; block: bigint; collateral?: Address; vault?: Address;
    decimals: number; positionSize: bigint; entryPrice: bigint; marginWad: bigint;
    badDebt: bigint; freeLp: bigint; reservedLp: bigint;
    deferredPnl: bigint; deferredFunding: bigint; equity: bigint;
    lossBudget: bigint; requiredReserve: bigint; insurance: bigint; maxAddLong: bigint; maxAddShort: bigint;
    initialMarginBps: number; maintenanceMarginBps: number; maxLeverage: number;
    /** Effective max open notional $ = min(pos$, oi$, skewBase*price) */
    maxPositionUsd: number;
    maxPosNotionalUsd: number;
    maxOiNotionalUsd: number;
    maxSkewUsd: number;
  }>();
  const registry = process.env.NEXT_PUBLIC_MARKET_REGISTRY_ADDRESS;
  const listed = findListed(market);
  const isDexMarket = !!(listed && ("dexPrice" in listed ? listed.dexPrice : listed.source === "dexscreener-robinhood") && ("sourceCa" in listed ? listed.sourceCa : false));
  const sourceCa = listed && "sourceCa" in listed ? listed.sourceCa : undefined;
  const sizeDelta = useMemo(() => size && !Number.isNaN(Number(size)) ? `${side === "short" ? "-" : ""}${size}` : " - ", [side, size]);
  const maxLev = marketInfo?.maxLeverage ?? 10;
  const levClamped = Math.min(Math.max(1, leverage), maxLev);
  const levQuote = useMemo(() => {
    const mark = marketInfo ? Number(formatUnits(marketInfo.index, 18)) : 0;
    const payN = Number(pay);
    if (!(mark > 0) || !(payN > 0) || !Number.isFinite(payN)) {
      return { notional: 0, positionValue: 0, posSize: 0, liqMovePct: 0, pay: 0, capped: false, maxUsd: 0, notionalWanted: 0 };
    }
    const notionalWanted = payN * levClamped;
    const maxUsd = marketInfo?.maxPositionUsd ?? Infinity;
    const notional = Math.min(notionalWanted, maxUsd > 0 ? maxUsd : notionalWanted);
    const posSize = notional / mark;
    const mmBps = marketInfo?.maintenanceMarginBps ?? 500;
    const liqMovePct = Math.max(0, (1 - mmBps / 10_000) * (100 / levClamped));
    return {
      notional,
      positionValue: notional,
      posSize,
      liqMovePct,
      pay: payN,
      capped: notionalWanted > maxUsd + 0.01,
      maxUsd: Number.isFinite(maxUsd) ? maxUsd : 0,
      notionalWanted,
    };
  }, [marketInfo, pay, levClamped]);

  /** Keep hidden size/limit in sync with simple $ pay + leverage */
  useEffect(() => {
    const mark = marketInfo ? Number(formatUnits(marketInfo.index, 18)) : 0;
    if (!(mark > 0) || levQuote.posSize <= 0) return;
    setSize(decimalString(levQuote.posSize, 12));
    const slip = side === "long" ? 1.02 : 0.98;
    setLimit(decimalString(mark * slip, mark < 1 ? 18 : 8));
  }, [levQuote.posSize, marketInfo?.index, side, leverage]);

  useEffect(() => {
    if (!sourceCa) { setDexChange24h(null); return; }
    let cancelled = false;
    void fetchRobinhoodDex(sourceCa).then((d) => {
      if (!cancelled) setDexChange24h(d?.priceChange24h ?? null);
    });
    return () => { cancelled = true; };
  }, [sourceCa]);

  useEffect(() => {
    if (initialMarket && isAddress(initialMarket) && initialMarket.toLowerCase() !== market.toLowerCase()) {
      setMarket(initialMarket);
      setMarketInfo(undefined);
      setLimit("");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialMarket]);

  useEffect(() => {
    if (!account) {
      setWalletApUsd("—");
      setWalletApUsdN(0);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const bal = await readApUsdBalance(account);
        if (!cancelled) {
          setWalletApUsd(bal.label);
          setWalletApUsdN(bal.amount);
        }
      } catch {
        if (!cancelled) {
          setWalletApUsd("—");
          setWalletApUsdN(0);
        }
      }
    })();
    const t = setInterval(() => {
      void (async () => {
        try {
          const bal = await readApUsdBalance(account);
          if (!cancelled) {
            setWalletApUsd(bal.label);
            setWalletApUsdN(bal.amount);
          }
        } catch { /* keep last */ }
      })();
    }, 8_000);
    return () => { cancelled = true; clearInterval(t); };
  }, [account, balTick, txState]);

  const uPnl = useMemo(() => {
    if (!marketInfo || marketInfo.positionSize === 0n) return null;
    const sizeN = Number(formatUnits(marketInfo.positionSize, 18));
    const entry = Number(formatUnits(marketInfo.entryPrice, 18));
    const mark = Number(formatUnits(marketInfo.index, 18));
    if (!Number.isFinite(sizeN) || !Number.isFinite(entry) || !Number.isFinite(mark) || entry <= 0) return null;
    // On-chain: pnl = size * (mark - entry) / 1e18  (size signed; long profits when mark rises)
    const pnl = sizeN * (mark - entry);
    const notional = Math.abs(sizeN) * mark;
    const entryNotional = Math.abs(sizeN) * entry;
    const marginN = Number(formatUnits(marketInfo.marginWad, 18));
    const roe = marginN > 0 ? (pnl / marginN) * 100 : null;
    const priceMovePct = entry > 0 ? ((mark - entry) / entry) * 100 * (sizeN >= 0 ? 1 : -1) : 0;
    return { pnl, entry, mark, sizeN, notional, entryNotional, marginN, roe, priceMovePct };
  }, [marketInfo]);

  useEffect(() => {
    if (!isAddress(market) || !registry || !isAddress(registry)) return;
    let cancelled = false;
    async function inspectMarket() {
      try {
        const marketAddress = market as Address;
        const registered = await publicClient.readContract({ address: registry as Address, abi: registryAbi, functionName: "isMarket", args: [marketAddress] });
        if (!registered) throw new Error("Unknown market. Use the demo market or a market you just created.");
        const block = await publicClient.getBlockNumber();

        // Resolve base early so we can heal oracle deviation before indexPrice
        let base: Address | undefined;
        try {
          base = await publicClient.readContract({ address: marketAddress, abi: marketAbi, functionName: "baseToken" });
          if (!cancelled) setBaseToken(base);
        } catch {
          base = undefined;
        }

        let index: bigint;
        try {
          index = await publicClient.readContract({ address: marketAddress, abi: marketAbi, functionName: "indexPrice" });
        } catch (idxErr) {
          // 0x0d637948 OracleDeviation — wait for background oracle loop (no wallet spam)
          if (isOracleDeviationError(idxErr)) {
            throw new Error(
              "Oracle feeds briefly disagree. Wait ~30s (server auto-syncs) or tap “Sync price once” below. No repeated wallet prompts.",
            );
          }
          throw idxErr;
        }

        const [state, collateral, lpVault, position, badDebt, deferredPnl, deferredFunding, equity] = await Promise.all([
          publicClient.readContract({ address: marketAddress, abi: marketAbi, functionName: "state" }),
          publicClient.readContract({ address: marketAddress, abi: marketAbi, functionName: "collateralToken" }),
          publicClient.readContract({ address: marketAddress, abi: marketAbi, functionName: "liquidityVault" }),
          account ? publicClient.readContract({ address: marketAddress, abi: marketAbi, functionName: "position", args: [account] }) : Promise.resolve(undefined),
          publicClient.readContract({ address: marketAddress, abi: marketAbi, functionName: "badDebtWad" }),
          account ? publicClient.readContract({ address: marketAddress, abi: marketAbi, functionName: "pendingPnlClaimsWad", args: [account] }) : Promise.resolve(0n),
          account ? publicClient.readContract({ address: marketAddress, abi: marketAbi, functionName: "pendingFundingClaimsWad", args: [account] }) : Promise.resolve(0n),
          account ? publicClient.readContract({ address: marketAddress, abi: marketAbi, functionName: "accountEquityWad", args: [account] }) : Promise.resolve(0n),
        ]);
        const [decimals, marginVault, freeLp, reservedLp] = await Promise.all([
          publicClient.readContract({ address: collateral, abi: erc20Abi, functionName: "decimals" }),
          publicClient.readContract({ address: marketAddress, abi: marketAbi, functionName: "collateralVault" }),
          publicClient.readContract({ address: lpVault, abi: liquidityVaultAbi, functionName: "freeAssets" }),
          publicClient.readContract({ address: lpVault, abi: liquidityVaultAbi, functionName: "reservedAssets" }),
        ]);
        let lossBudget = 0n;
        let insurance = 0n;
        try {
          lossBudget = await publicClient.readContract({
            address: marketAddress, abi: marketAbi, functionName: "lossBudgetCapacityRaw",
          });
        } catch { /* pre-S10a market */ }
        try {
          const insuranceAddr = await publicClient.readContract({
            address: marketAddress, abi: marketAbi, functionName: "insuranceFund",
          });
          insurance = await publicClient.readContract({
            address: insuranceAddr, abi: insuranceFundAbi, functionName: "balance",
          });
        } catch { /* optional */ }
        const requiredReserve = reservedLp as bigint;
        const maxAddLong = 0n;
        const maxAddShort = 0n;
        let initialMarginBps = 1000;
        let maintenanceMarginBps = 500;
        // Market._checkCaps: pos/OI are notional $; skew is base units
        let maxPosNotionalUsd = 100_000;
        let maxOiNotionalUsd = 1_000_000;
        let maxSkewBase = 10_000;
        try {
          const risk = await publicClient.readContract({
            address: marketAddress, abi: marketAbi, functionName: "riskParams",
          });
          initialMarginBps = Number(risk.initialMarginBps);
          maintenanceMarginBps = Number(risk.maintenanceMarginBps);
          maxPosNotionalUsd = Number(formatUnits(risk.maxPositionWad, 18));
          maxOiNotionalUsd = Number(formatUnits(risk.maxOpenInterestWad, 18));
          maxSkewBase = Number(formatUnits(risk.maxSkewWad, 18));
        } catch { /* default 10x */ }
        const maxLeverage = Math.max(1, Math.min(100, Math.floor(10_000 / Math.max(1, initialMarginBps))));
        const idx = Number(formatUnits(index, 18));
        const maxSkewUsd = Number.isFinite(idx) && idx > 0 ? maxSkewBase * idx : 0;
        const maxPositionUsd = Math.min(
          maxPosNotionalUsd > 0 ? maxPosNotionalUsd : Infinity,
          maxOiNotionalUsd > 0 ? maxOiNotionalUsd : Infinity,
          maxSkewUsd > 0 ? maxSkewUsd : Infinity,
        );
        if (!cancelled) {
          setMarketInfo({
            registered: true, state, index, block, collateral, vault: marginVault, decimals,
            positionSize: position?.sizeBaseWad ?? 0n,
            entryPrice: position?.entryPriceWad ?? 0n,
            marginWad: position?.marginWad ?? 0n,
            badDebt: badDebt as bigint,
            freeLp: freeLp as bigint, reservedLp: reservedLp as bigint,
            deferredPnl: deferredPnl as bigint, deferredFunding: deferredFunding as bigint, equity: equity as bigint,
            lossBudget, requiredReserve, insurance, maxAddLong, maxAddShort,
            initialMarginBps, maintenanceMarginBps, maxLeverage,
            maxPositionUsd: Number.isFinite(maxPositionUsd) ? maxPositionUsd : 0,
            maxPosNotionalUsd,
            maxOiNotionalUsd,
            maxSkewUsd,
          });
          setLeverage((L) => Math.min(L, maxLeverage));
          if (Number.isFinite(idx) && idx > 0) {
            setLimit((v) => (v ? v : decimalString(idx * 1.02, idx < 1 ? 18 : 8)));
            setSize((s) => {
              // Only auto-size when still on a previous market's default
              if (!s || s === "0.05" || s === "0.5" || s === "2" || s === "100" || s === "1000") {
                return defaultSizeForMark(idx);
              }
              return s;
            });
          }
          setError("");
        }
      } catch (cause) {
        if (!cancelled) { setMarketInfo(undefined); setError(cause instanceof Error ? cause.message : "Market inspection failed."); }
      }
    }
    void inspectMarket();
    const t = setInterval(() => void inspectMarket(), 5_000);
    return () => { cancelled = true; clearInterval(t); };
  }, [market, account, registry, sourceCa, oracleTick]);

  async function walletClient() {
    if (!account || !window.ethereum) throw new Error("Connect an EVM wallet first.");
    return createWalletClient({ account, chain: appChain, transport: custom(window.ethereum) });
  }

  /**
   * Push live Dex price into mock oracles so on-chain index (settlement) matches chart.
   * Prefer hosted API (no wallet); fall back to one wallet push before open/close.
   */
  async function ensureSettlementPrice(opts?: { forceWallet?: boolean }): Promise<number> {
    const base = (baseToken || resolvedBase) as Address | undefined;
    if (!isDexMarket || !sourceCa || !base || !isAddress(base)) {
      return marketInfo ? Number(formatUnits(marketInfo.index, 18)) : 0;
    }

    const { fetchRobinhoodDex } = await import("./rh-catalog");
    const dex = await fetchRobinhoodDex(sourceCa);
    if (!dex?.priceUsd) {
      return marketInfo ? Number(formatUnits(marketInfo.index, 18)) : 0;
    }

    let pushed = false;
    if (apiEnabled && !opts?.forceWallet) {
      try {
        const res = await fetch(`${apiBase}/v1/oracle/push`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            baseToken: base,
            sourceCa,
            priceUsd: dex.priceUsd,
            liquidityUsd: Math.max(1_000_000, dex.liquidityUsd || 0),
          }),
          cache: "no-store",
        });
        if (res.ok) {
          pushed = true;
          setKeeperStatus(`Settlement → mainnet $${dex.priceUsd < 0.01 ? dex.priceUsd.toPrecision(4) : dex.priceUsd.toFixed(6)}`);
        }
      } catch {
        /* wallet fallback */
      }
    }

    if (!pushed && account) {
      setError("Syncing settlement price to mainnet Dex (wallet confirm)…");
      const { pushIdenticalWithInjectedWallet } = await import("./oracle-sync");
      await pushIdenticalWithInjectedWallet(
        account,
        base,
        dex.priceUsd,
        Math.max(1_000_000, dex.liquidityUsd || 0),
      );
      pushed = true;
      setKeeperStatus("Settlement synced via wallet");
    }

    if (pushed) {
      await new Promise((r) => setTimeout(r, 900));
      setOracleTick((n) => n + 1);
      setDexLivePrice(dex.priceUsd);
    }

    try {
      const index = await publicClient.readContract({
        address: market as Address,
        abi: marketAbi,
        functionName: "indexPrice",
      });
      return Number(formatUnits(index, 18));
    } catch {
      return dex.priceUsd;
    }
  }

  /**
   * Testnet profit float: if close left a deferred PnL claim and the vault is dry,
   * mint apUSD into the LP vault then claim so the trader is paid now.
   * Protocol rebalances inventory later (not permanent mainnet design).
   */
  async function settleTestnetProfit(): Promise<string | null> {
    if (!account || !isAddress(market) || !marketInfo?.collateral) return null;
    let claim = 0n;
    try {
      claim = await publicClient.readContract({
        address: market as Address,
        abi: marketAbi,
        functionName: "pendingPnlClaimsWad",
        args: [account],
      });
    } catch {
      return null;
    }
    if (claim === 0n) return null;

    const decimals = marketInfo.decimals ?? 18;
    // wad (1e18) → raw token units
    const scale = 10 ** Math.max(0, 18 - decimals);
    const raw = claim / BigInt(scale || 1);
    if (raw === 0n) return null;

    const lpVault = await publicClient.readContract({
      address: market as Address,
      abi: marketAbi,
      functionName: "liquidityVault",
    });

    const wallet = await walletClient();
    // Mint float into LP vault so payFreeUpTo can settle the claim
    try {
      const mintSim = await publicClient.simulateContract({
        account,
        address: marketInfo.collateral,
        abi: erc20Abi,
        functionName: "mint",
        args: [lpVault, raw],
      });
      const mintHash = await wallet.writeContract(mintSim.request);
      await publicClient.waitForTransactionReceipt({ hash: mintHash });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return `Profit deferred (${formatUsd(Number(formatUnits(claim, 18)))}) — mint float failed: ${msg.slice(0, 80)}`;
    }

    try {
      const claimSim = await publicClient.simulateContract({
        account,
        address: market as Address,
        abi: marketAbi,
        functionName: "claimDeferredPayout",
      });
      const claimHash = await wallet.writeContract(claimSim.request);
      await publicClient.waitForTransactionReceipt({ hash: claimHash });
      return `Profit settled: minted ${formatUsd(Number(formatUnits(claim, 18)))} ${APUSD_SYMBOL} float into vault and paid claim.`;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return `Minted float; claim pending — ${msg.slice(0, 80)}. Tap Claim when ready.`;
    }
  }

  /**
   * PnL settles into market margin (not the wallet). After a full close, pull
   * remaining margin back to the wallet so Available apUSD goes up/down.
   */
  async function withdrawAllFreeMargin(): Promise<{ usd: number; raw: bigint } | null> {
    if (!account || !isAddress(market)) return null;
    const position = await publicClient.readContract({
      address: market as Address,
      abi: marketAbi,
      functionName: "position",
      args: [account],
    });
    // Only auto-withdraw when flat — open size still needs margin locked
    if (position.sizeBaseWad !== 0n) return null;
    if (position.marginWad === 0n) return null;

    const decimals =
      marketInfo?.decimals ??
      (await publicClient.readContract({
        address: (marketInfo?.collateral || demoCollateral) as Address,
        abi: erc20Abi,
        functionName: "decimals",
      }).catch(() => 18));
    const scale = 10n ** BigInt(Math.max(0, 18 - Number(decimals)));
    const raw = position.marginWad / scale;
    if (raw === 0n) return null;

    const wallet = await walletClient();
    setTxState("awaiting_signature");
    setError(`Returning ${formatUsd(Number(formatUnits(position.marginWad, 18)))} ${APUSD_SYMBOL} to wallet…`);
    const sim = await publicClient.simulateContract({
      account,
      address: market as Address,
      abi: marketAbi,
      functionName: "withdrawMargin",
      args: [raw],
    });
    const hash = await wallet.writeContract(sim.request);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error("withdrawMargin failed");
    return { usd: Number(formatUnits(position.marginWad, 18)), raw };
  }

  async function refreshWalletApUsd() {
    if (!account) return;
    try {
      const bal = await readApUsdBalance(account);
      setWalletApUsd(bal.label);
      setWalletApUsdN(bal.amount);
      setBalTick((n) => n + 1);
    } catch { /* next poll */ }
  }

  async function submitTrade(delta: bigint) {
    if (!account) { onConnect(); return; }
    if (!isAddress(market) || !marketInfo?.registered || !limit) { setError("Select a registered market and enter an acceptable price."); return; }
    const reduces = marketInfo.positionSize !== 0n && ((delta > 0n) !== (marketInfo.positionSize > 0n));
    if (marketInfo.state !== 3 && !(marketInfo.state === 4 && reduces)) { setError(`Market is ${marketStates[marketInfo.state] ?? "unknown"}; this is not a permitted risk reduction.`); return; }
    try {
      setError(""); setTxState("checking");
      const idx = await ensureSettlementPrice();
      const lim = limit && Number(limit) > 0
        ? limit
        : decimalString(idx * (delta > 0n ? 1.05 : 0.95), idx < 1 ? 18 : 8);
      setLimit(lim);
      const wallet = await walletClient();
      const simulation = await publicClient.simulateContract({ account, address: market, abi: marketAbi, functionName: "executeTrade", args: [delta, parseUnits(lim, 18), BigInt(Math.floor(Date.now() / 1000) + 120)] });
      setTxState("awaiting_signature");
      const hash = await wallet.writeContract(simulation.request);
      setTxState("submitted"); setError(`Submitted ${short(hash)}; waiting for an on-chain receipt.`);
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new Error("Transaction reverted.");
      if (reduces) {
        const settleNote = await settleTestnetProfit();
        if (settleNote) setError(settleNote);
      }
      setTxState("confirmed");
      setOracleTick((n) => n + 1);
      setError((prev) => prev.startsWith("Profit") || prev.startsWith("Minted") ? prev : `Confirmed in block ${receipt.blockNumber}. Settlement mark matched live Dex.`);
    } catch (cause) { setTxState("failed"); setError(friendlyTxError(cause)); }
  }

  async function ensureMarginDeposited(needUsd: number): Promise<boolean> {
    if (!account || !marketInfo?.collateral || !marketInfo.vault) return false;
    const have = Number(formatUnits(marketInfo.marginWad, 18));
    const equityN = Number(formatUnits(marketInfo.equity, 18));
    const available = marketInfo.positionSize === 0n ? Math.max(have, equityN) : have;
    if (needUsd <= available + 0.01) return true;

    const topUp = (needUsd - Math.max(0, available)) * 1.02;
    // Fail fast with wallet apUSD balance so users aren't stuck on a cryptic ERC20 error
    try {
      const walletBal = await readApUsdBalance(account);
      setWalletApUsd(walletBal.label);
      setWalletApUsdN(walletBal.amount);
      if (walletBal.amount + 0.01 < topUp) {
        throw new Error(
          `Not enough ${APUSD_SYMBOL} in wallet (have ${walletBal.label}, need ~${topUp.toFixed(2)} for this trade). Tap “Mint 250k ${APUSD_SYMBOL}” first.`,
        );
      }
    } catch (e) {
      if (e instanceof Error && e.message.includes(APUSD_SYMBOL)) throw e;
      /* continue; deposit will surface balance errors */
    }
    const wallet = await walletClient();
    const amount = parseUnits(topUp.toFixed(Math.min(6, marketInfo.decimals)), marketInfo.decimals);
    const allowance = await publicClient.readContract({
      address: marketInfo.collateral,
      abi: erc20Abi,
      functionName: "allowance",
      args: [account, marketInfo.vault],
    });
    if (allowance < amount) {
      setTxState("awaiting_signature");
      setError("Confirm once: allow test USD for trading…");
      const approval = await publicClient.simulateContract({
        account,
        address: marketInfo.collateral,
        abi: erc20Abi,
        functionName: "approve",
        args: [marketInfo.vault, maxUint256],
      });
      const approvalHash = await wallet.writeContract(approval.request);
      await publicClient.waitForTransactionReceipt({ hash: approvalHash });
    }
    setTxState("awaiting_signature");
    setError(`Depositing $${topUp.toFixed(2)} margin…`);
    const deposit = await publicClient.simulateContract({
      account,
      address: market as Address,
      abi: marketAbi,
      functionName: "depositMargin",
      args: [amount],
    });
    const hash = await wallet.writeContract(deposit.request);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error("Margin deposit failed.");
    setBalTick((n) => n + 1);
    try {
      const bal = await readApUsdBalance(account);
      setWalletApUsd(bal.label);
      setWalletApUsdN(bal.amount);
    } catch { /* poll will retry */ }
    return true;
  }

  /** One-click open: sync settlement price → pay $ + leverage → deposit if needed → trade */
  async function submit() {
    if (!account) { onConnect(); return; }
    const payN = Number(pay);
    if (!(payN > 0)) { setError("Enter how much $ you want to put in."); return; }
    if (leverage < 1 || leverage > maxLev) {
      setError(`Max leverage on this market is ${maxLev}x.`);
      return;
    }
    if (!marketInfo?.registered) { setError("Pick a live market first."); return; }

    try {
      setError("");
      setTxState("checking");
      // Live Dex → on-chain index so entry matches chart (not stuck launch price)
      const idx = await ensureSettlementPrice();
      if (!(idx > 0)) { setError("Price not ready yet — wait a moment or Sync price."); setTxState("failed"); return; }

      const notionalWanted = payN * levClamped;
      const maxUsd = marketInfo.maxPositionUsd > 0 ? marketInfo.maxPositionUsd : Infinity;
      if (!(maxUsd > 1) || notionalWanted > maxUsd * 1.001) {
        setError(
          `Market risk cap ~${formatUsd(maxUsd)} notional ` +
            `(pos ${formatUsd(marketInfo.maxPosNotionalUsd)} · OI ${formatUsd(marketInfo.maxOiNotionalUsd)} · skew ${formatUsd(marketInfo.maxSkewUsd)}). ` +
            `Your order wants ~${formatUsd(notionalWanted)}. Use a smaller $ amount or pick the re-listed RH market.`,
        );
        setTxState("failed");
        return;
      }
      const notional = Math.min(notionalWanted, maxUsd);
      const posSize = notional / idx;
      if (notional > 50_000) {
        setError(`Position ~$${notional.toFixed(0)} is large for testnet — try a smaller amount.`);
        setTxState("failed");
        return;
      }
      if (idx > 1000 && posSize > 0.25) {
        setError("BTC-size too big for test LP — lower $ amount or leverage.");
        setTxState("failed");
        return;
      }

      // Sync size + soft limit for the trade (decimalString avoids 1e+8 parseUnits failures)
      const sizeStr = decimalString(posSize, 12);
      setSize(sizeStr);
      // Wide enough limits so a 1–2% move during wallet confirm still fills
      const slip = side === "long" ? 1.05 : 0.95;
      const lim = decimalString(idx * slip, idx < 1 ? 18 : 8);
      setLimit(lim);

      await ensureMarginDeposited(payN);

      setTxState("awaiting_signature");
      setError(`Opening ${side.toUpperCase()} @ ~$${idx < 0.01 ? idx.toPrecision(4) : idx.toFixed(6)} · ${formatUsd(notional)} notional…`);
      const wallet = await walletClient();
      const delta = parseUnits(sizeStr, 18) * (side === "short" ? -1n : 1n);
      const simulation = await publicClient.simulateContract({
        account,
        address: market as Address,
        abi: marketAbi,
        functionName: "executeTrade",
        args: [delta, parseUnits(lim, 18), BigInt(Math.floor(Date.now() / 1000) + 180)],
      });
      const hash = await wallet.writeContract(simulation.request);
      setTxState("submitted");
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new Error("Trade reverted.");
      setTxState("confirmed");
      setOracleTick((n) => n + 1);
      await refreshWalletApUsd();
      setError(
        `Open ${side} filled · ${formatUsd(payN)} ${APUSD_SYMBOL} moved wallet → market margin · notional ~${formatUsd(notional)} @ ${levClamped}x · settle $${idx < 0.01 ? idx.toPrecision(4) : idx.toFixed(6)}`,
      );
    } catch (cause) {
      setTxState("failed");
      setError(friendlyTxError(cause));
    }
  }

  function applyLeverage(nextLev: number) {
    setLeverage(Math.min(Math.max(1, Math.round(nextLev)), maxLev));
  }

  async function closePosition() {
    if (!marketInfo?.positionSize) { setError("No open position."); return; }
    const entryMargin = Number(formatUnits(marketInfo.marginWad, 18));
    const entryEq = Number(formatUnits(marketInfo.equity, 18));
    try {
      setError("");
      setTxState("checking");
      // Match chart: push live Dex into settlement oracle before close
      const idx = await ensureSettlementPrice();
      if (!(idx > 0)) { setError("Settlement price unavailable — Sync price and retry."); setTxState("failed"); return; }
      const lim = decimalString(idx * (marketInfo.positionSize > 0n ? 0.95 : 1.05), idx < 1 ? 18 : 8);
      setLimit(lim);
      setError(`Closing @ settle ~$${idx < 0.01 ? idx.toPrecision(4) : idx.toFixed(6)}…`);
      const wallet = await walletClient();
      const simulation = await publicClient.simulateContract({
        account: account!,
        address: market as Address,
        abi: marketAbi,
        functionName: "executeTrade",
        args: [-marketInfo.positionSize, parseUnits(lim, 18), BigInt(Math.floor(Date.now() / 1000) + 180)],
      });
      setTxState("awaiting_signature");
      const hash = await wallet.writeContract(simulation.request);
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new Error("Close failed.");
      // If vault was short on profit, mint apUSD float + claim deferred payout
      const settleNote = await settleTestnetProfit();
      // Critical: realized PnL sits in market margin — withdraw to wallet so Available apUSD moves
      let withdrawnUsd = 0;
      try {
        const w = await withdrawAllFreeMargin();
        if (w) withdrawnUsd = w.usd;
      } catch (wErr) {
        const msg = wErr instanceof Error ? wErr.message : String(wErr);
        setTxState("confirmed");
        setOracleTick((n) => n + 1);
        await refreshWalletApUsd();
        setError(
          `Closed, but auto-withdraw failed (${msg.slice(0, 80)}). Tap “Withdraw to wallet” so ${APUSD_SYMBOL} balance updates.`,
        );
        return;
      }
      setTxState("confirmed");
      setOracleTick((n) => n + 1);
      await refreshWalletApUsd();
      const realizedHint =
        Number.isFinite(entryEq) && Number.isFinite(entryMargin)
          ? ` · equity was ~${formatUsd(entryEq)} (margin ${formatUsd(entryMargin)} ± PnL)`
          : "";
      const parts = [
        "Position closed",
        withdrawnUsd > 0
          ? `${formatUsd(withdrawnUsd)} ${APUSD_SYMBOL} returned to wallet (includes realized PnL)`
          : "no residual margin to withdraw",
        settleNote,
      ].filter(Boolean);
      setError(`${parts.join(" · ")}${realizedHint}`);
    } catch (cause) {
      setTxState("failed");
      setError(friendlyTxError(cause));
    }
  }

  /** Manual withdraw of idle / free margin back to wallet apUSD. */
  async function withdrawToWallet() {
    if (!account) { onConnect(); return; }
    if (!isAddress(market) || !marketInfo?.registered) {
      setError("Pick a market first.");
      return;
    }
    try {
      setError("");
      setTxState("checking");
      const w = await withdrawAllFreeMargin();
      if (!w) {
        // Try withdraw excess: if open position, still allow withdrawing only if margin > 0 and size 0 handled above
        const position = await publicClient.readContract({
          address: market as Address,
          abi: marketAbi,
          functionName: "position",
          args: [account],
        });
        if (position.sizeBaseWad !== 0n) {
          setTxState("idle");
          setError("Close the position first — open size keeps margin locked. After close, balance returns automatically.");
          return;
        }
        setTxState("idle");
        setError("No margin left in this market to withdraw.");
        return;
      }
      setTxState("confirmed");
      setOracleTick((n) => n + 1);
      await refreshWalletApUsd();
      setError(`${formatUsd(w.usd)} ${APUSD_SYMBOL} withdrawn to wallet. Available balance updated.`);
    } catch (cause) {
      setTxState("failed");
      setError(friendlyTxError(cause));
    }
  }

  async function mintTestCollateral() {
    if (!featureFlags.publicFaucet || !featureFlags.allowMintableCollateral) {
      setFaucetStatus("Faucet disabled on this network (mainnet-safe build).");
      return;
    }
    if (!account) { onConnect(); return; }
    if (!demoCollateral || !isAddress(demoCollateral)) { setFaucetStatus("Mock collateral address not configured."); return; }
    try {
      setFaucetStatus(`Minting 250,000 ${APUSD_SYMBOL}…`);
      const hash = await mintApUsdTo(account);
      setBalTick((n) => n + 1);
      try {
        const bal = await readApUsdBalance(account);
        setWalletApUsd(bal.label);
        setWalletApUsdN(bal.amount);
      } catch { /* poll will retry */ }
      setFaucetStatus(
        `Minted 250,000 ${APUSD_SYMBOL} · tx ${short(hash)}. Wallet now shows your balance above. Not real money.`,
      );
    } catch (cause) {
      setFaucetStatus(cause instanceof Error ? cause.message : "Mint failed");
    }
  }

  async function claimDeferred() {
    if (!account) { onConnect(); return; }
    if (!isAddress(market) || !marketInfo?.registered) { setError("Inspect a registered market first."); return; }
    try {
      setError(""); setTxState("checking");
      const wallet = await walletClient();
      const sim = await publicClient.simulateContract({ account, address: market as Address, abi: marketAbi, functionName: "claimDeferredPayout" });
      setTxState("awaiting_signature");
      const hash = await wallet.writeContract(sim.request);
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new Error("claimDeferredPayout reverted");
      // Pull claimed funds out of market margin into wallet if flat
      try { await withdrawAllFreeMargin(); } catch { /* claim may have paid direct to user already */ }
      setTxState("confirmed");
      setOracleTick((n) => n + 1);
      await refreshWalletApUsd();
      setError(`Deferred claim paid in block ${receipt.blockNumber}. Wallet ${APUSD_SYMBOL} refreshed.`);
    } catch (cause) { setTxState("failed"); setError(cause instanceof Error ? cause.message : "Claim failed"); }
  }

  const markN = marketInfo ? Number(formatUnits(marketInfo.index, 18)) : undefined;
  const chartSym = listed?.chartSymbol || (listed?.pyth ? `${listed.pyth}USDT` : listed?.symbol) || undefined;
  const resolvedBase = baseToken || (listed && "baseToken" in listed ? listed.baseToken : undefined);
  // Settlement mark = on-chain index (what PnL uses). Dex is the live spot we keep pushing into index.
  const settlePx = markN;
  const spotPx = isDexMarket && dexLivePrice != null ? dexLivePrice : markN;
  const displayPx = settlePx ?? spotPx;
  const pxLabel = displayPx != null
    ? (displayPx < 0.01 ? displayPx.toPrecision(4) : displayPx.toLocaleString(undefined, { maximumFractionDigits: displayPx < 1 ? 6 : 4 }))
    : "—";
  const spotLabel = spotPx != null
    ? (spotPx < 0.01 ? spotPx.toPrecision(4) : spotPx.toLocaleString(undefined, { maximumFractionDigits: spotPx < 1 ? 6 : 4 }))
    : null;
  const markDrift =
    settlePx != null && spotPx != null && spotPx > 0
      ? Math.abs(settlePx - spotPx) / spotPx
      : 0;
  const chg = dexChange24h;
  const pairName = listed ? `${listed.symbol}-PERP` : marketInfo ? short(market) : "Select market";

  function selectMarket(addr: string) {
    setMarket(addr);
    setMarketInfo(undefined);
    setLimit("");
    setError("");
    setKeeperStatus("");
    setDexLivePrice(null);
    setPickerOpen(false);
  }

  const orderTicket = (
    <section className="panel order-panel hl-order term-order term-order--compact">
      <div className="segmented term-side">
        <button type="button" className={side === "long" ? "long-active" : ""} onClick={() => setSide("long")}>Buy / Long</button>
        <button type="button" className={side === "short" ? "short-active" : ""} onClick={() => setSide("short")}>Sell / Short</button>
      </div>
      <div className="term-order-meta">
        <div className="hl-meta-row">
          <span>Wallet free ({APUSD_SYMBOL})</span>
          <strong className="apusd-available">{account ? (walletApUsd === "—" ? "…" : walletApUsd) : "—"}</strong>
        </div>
        <div className="hl-meta-row">
          <span>In market (margin)</span>
          <strong>
            {account
              ? formatUsd(
                  uPnl?.marginN
                    ?? (marketInfo ? Number(formatUnits(marketInfo.marginWad, 18)) : 0),
                )
              : "—"}
          </strong>
        </div>
        <div className="hl-meta-row">
          <span>Equity (margin ± uPnL)</span>
          <strong className={marketInfo && Number(formatUnits(marketInfo.equity, 18)) >= 0 ? "up" : "down"}>
            {account && marketInfo
              ? formatUsd(Number(formatUnits(marketInfo.equity, 18)))
              : "—"}
          </strong>
        </div>
        <div className="hl-meta-row">
          <span>Est. total</span>
          <strong>
            {account && walletApUsd !== "—" && marketInfo
              ? formatUsd(walletApUsdN + Number(formatUnits(marketInfo.equity, 18)))
              : account && walletApUsd !== "—"
                ? walletApUsd
                : "—"}
          </strong>
        </div>
        <div className="hl-meta-row"><span>Mark</span><strong>${pxLabel}</strong></div>
      </div>
      <p className="field-hint term-order-hint">
        Open deposits margin from wallet → market. Close realizes PnL into margin, then auto-withdraws to wallet so free balance moves.
      </p>
      {account && walletApUsd !== "—" && walletApUsdN < 1 && featureFlags.publicFaucet ? (
        <p className="field-hint warn term-order-hint">
          Available 0 — mint {APUSD_SYMBOL} first
        </p>
      ) : null}
      <div className="leverage-box">
        <div className="leverage-head"><span>Leverage</span><strong>{levClamped}x</strong></div>
        <input className="leverage-slider" type="range" min={1} max={maxLev} step={1} value={levClamped} onChange={(e) => applyLeverage(Number(e.target.value))} />
        <div className="leverage-presets">
          {[1, 2, 5, 10, 20, 25, 50, 100].filter((x) => x <= maxLev).map((x) => (
            <button key={x} type="button" className={levClamped === x ? "lev-chip active" : "lev-chip"} onClick={() => applyLeverage(x)}>{x}x</button>
          ))}
        </div>
      </div>
      <label className="field pay-field">
        <span>Margin ($)</span>
        <input inputMode="decimal" value={pay} onChange={(e) => setPay(e.target.value.replace(/[^0-9.]/g, ""))} placeholder="100" />
        <div className="pay-presets">
          {["10", "50", "100", "500", "1000"].map((v) => (
            <button key={v} type="button" className={pay === v ? "lev-chip active" : "lev-chip"} onClick={() => setPay(v)}>${v}</button>
          ))}
        </div>
      </label>
      <div className="hl-summary">
        <div>
          <span>Order value</span>
          <strong>≈ {formatUsd(levQuote.positionValue)}</strong>
          {levQuote.posSize > 0 ? <small>{formatTokenAmt(levQuote.posSize)} {listed?.symbol ?? "units"}</small> : null}
        </div>
        <div><span>Liq. distance</span><strong>{levQuote.liqMovePct > 0 ? `~${levQuote.liqMovePct.toFixed(0)}%` : "—"}</strong></div>
        <div><span>Margin req.</span><strong>{levQuote.pay > 0 ? formatUsd(levQuote.pay) : "—"}</strong></div>
      </div>
      {levQuote.capped && levQuote.maxUsd > 0 ? (
        <p className="form-error term-order-hint">
          Max ≈ {formatUsd(levQuote.maxUsd)}. Lower $ or lev.
        </p>
      ) : null}
      {error && (
        <p className={txState === "submitted" || txState === "confirmed" ? "form-success" : "form-error"} style={{ margin: 0, fontSize: 12 }}>{error}</p>
      )}
      <div className="term-order-actions">
        <button className={`button full ${side === "long" ? "long-button" : "short-button"}`} onClick={submit} disabled={txState === "checking" || txState === "awaiting_signature"}>
          {!account ? "Connect" : txState === "checking" || txState === "awaiting_signature" ? "Confirm…" : `${side === "long" ? "Buy / Long" : "Sell / Short"} · ${levClamped}x`}
        </button>
        <div className="term-order-actions-row">
          <button className="button full secondary" onClick={closePosition} disabled={!marketInfo?.positionSize || txState === "checking" || txState === "awaiting_signature"}>Close</button>
          <button
            type="button"
            className="button full secondary"
            onClick={withdrawToWallet}
            disabled={
              !account ||
              !marketInfo ||
              marketInfo.marginWad === 0n ||
              marketInfo.positionSize !== 0n ||
              txState === "checking" ||
              txState === "awaiting_signature"
            }
            title={marketInfo?.positionSize !== 0n ? "Close position first — then residual margin returns to wallet" : "Pull idle margin + realized PnL back to wallet apUSD"}
          >
            Withdraw to wallet
          </button>
          <button type="button" className="adv-toggle" onClick={() => setShowAdvanced((v) => !v)}>{showAdvanced ? "Hide adv" : "Advanced"}</button>
        </div>
      </div>
      {showAdvanced && (
        <div className="adv-box">
          <Field label="Market address" value={market} setValue={(value) => { setMarket(value); setMarketInfo(undefined); setLimit(""); }} placeholder="0x…" mono />
          <Field label="Size (base)" value={size} setValue={setSize} placeholder="0" />
          <Field label="Limit price" value={limit} setValue={setLimit} placeholder="0" />
          {isDexMarket && account && (
            <button className="text-button" type="button" onClick={() => setRequestWalletSync(true)} disabled={requestWalletSync}>
              Force sync settlement
            </button>
          )}
          {keeperStatus && <p className="field-hint">{keeperStatus}</p>}
          <p className="field-hint">
            Open/close always sync mainnet Dex → on-chain mark first. Profit settles in {APUSD_SYMBOL}; if vault is short, testnet mints float then pays.
          </p>
        </div>
      )}
    </section>
  );

  return (
    <div className="trade-terminal">
      {featureFlags.publicFaucet && featureFlags.allowMintableCollateral ? (
        <div className="warning-banner term-banner apusd-bar">
          <strong>{APUSD_LABEL}</strong>
          <span>
            Available: <b>{account ? (walletApUsd === "—" ? "loading…" : walletApUsd) : "connect wallet"}</b>
            {account && walletApUsdN >= 1 ? " · ready to trade" : account && walletApUsd !== "—" ? " · mint first" : ""}
          </span>
          <button className="text-button" type="button" onClick={mintTestCollateral}>
            Mint 250k {APUSD_SYMBOL}
          </button>
        </div>
      ) : null}
      {faucetStatus && <p className="section-copy term-muted">{faucetStatus}</p>}
      {isDexMarket && sourceCa && (
        <DexPriceKeeper
          enabled
          account={account}
          baseToken={resolvedBase}
          sourceCa={sourceCa}
          onPrice={setDexLivePrice}
          onStatus={setKeeperStatus}
          onOraclePushed={() => setOracleTick((n) => n + 1)}
          requestWalletSync={requestWalletSync}
          onWalletSyncDone={() => setRequestWalletSync(false)}
          intervalMs={8_000}
          apiBase={apiBase}
          apiEnabled={apiEnabled}
        />
      )}
      <header className="term-ticker">
        <div className="term-pair">
          <button type="button" className="term-pair-btn term-pair-btn--lg" onClick={() => setPickerOpen((v) => !v)} aria-expanded={pickerOpen}>
            <span className="token-avatar token-avatar--lg">{listed?.symbol?.slice(0, 1) ?? "?"}</span>
            <div className="term-pair-text">
              <strong>{pairName}</strong>
              <small>{levClamped}x · {listed?.label ?? "Isolated perp"}</small>
            </div>
            <span className="term-caret term-caret--lg" aria-hidden>{pickerOpen ? "▴" : "▾"}</span>
          </button>
          {pickerOpen && (
            <div className="term-picker term-picker--lg" role="listbox">
              <div className="term-picker-head">Live markets · tradeable</div>
              {tradeable.length ? tradeable.map((m) => (
                <button
                  key={m.market}
                  type="button"
                  role="option"
                  aria-selected={!!(market && m.market.toLowerCase() === market.toLowerCase())}
                  className={market && m.market.toLowerCase() === market.toLowerCase() ? "active" : ""}
                  onClick={() => selectMarket(m.market)}
                >
                  <span className="term-picker-sym">{m.symbol}-PERP</span>
                  <span className="term-picker-meta">{m.label ?? short(m.market)}</span>
                </button>
              )) : (
                <p className="term-picker-empty">No live markets yet.</p>
              )}
              <div className="term-picker-actions">
                {onOpenMarkets ? (
                  <button type="button" className="term-picker-link" onClick={() => { setPickerOpen(false); onOpenMarkets(); }}>
                    All markets →
                  </button>
                ) : null}
                {onOpenCreate ? (
                  <button type="button" className="term-picker-create" onClick={() => { setPickerOpen(false); onOpenCreate(); }}>
                    + Create market
                  </button>
                ) : null}
              </div>
            </div>
          )}
        </div>
        <div className="term-stats">
          <div>
            <span>Mark</span>
            <strong>${pxLabel}</strong>
          </div>
          <div>
            <span>24h</span>
            <strong className={chg == null ? "" : chg >= 0 ? "up" : "down"}>
              {chg == null ? "—" : `${chg >= 0 ? "+" : ""}${chg.toFixed(2)}%`}
            </strong>
          </div>
          <div>
            <span>Spot</span>
            <strong className={markDrift > 0.01 ? "down" : ""}>
              {spotLabel ? `$${spotLabel}` : "—"}
            </strong>
          </div>
          <div>
            <span>State</span>
            <strong className={marketInfo?.state === 3 ? "up" : ""}>{marketInfo ? (marketStates[marketInfo.state] ?? "…") : "…"}</strong>
          </div>
          <div className="term-stat-hide-sm">
            <span>uPnL</span>
            <strong className={uPnl ? (uPnl.pnl >= 0 ? "up" : "down") : ""}>
              {uPnl ? `${uPnl.pnl >= 0 ? "+" : ""}${formatUsd(uPnl.pnl)}` : "—"}
            </strong>
          </div>
        </div>
      </header>
      {isDexMarket && (keeperStatus || markDrift > 0.01) ? (
        <p className="field-hint term-muted" style={{ margin: "0.35rem 0 0", padding: "0 0.25rem" }}>
          {markDrift > 0.01
            ? `Settlement lagging spot by ${(markDrift * 100).toFixed(1)}% — auto-syncing live Dex into mark… `
            : null}
          {keeperStatus}
          {account ? (
            <>
              {" "}
              <button className="text-button" type="button" onClick={() => setRequestWalletSync(true)} disabled={requestWalletSync}>
                Sync now
              </button>
            </>
          ) : null}
        </p>
      ) : null}
      <div className="term-mobile-tabs" role="tablist">
        <button type="button" role="tab" aria-selected={mobileTab === "chart"} className={mobileTab === "chart" ? "active" : ""} onClick={() => setMobileTab("chart")}>Chart</button>
        <button type="button" role="tab" aria-selected={mobileTab === "ticket"} className={mobileTab === "ticket" ? "active" : ""} onClick={() => setMobileTab("ticket")}>Trade</button>
      </div>
      <div className="trade-layout term-grid">
        {/* Left stack: chart + positions (HL-style) — kills the dead gap under a short chart */}
        <div className={`term-main-col ${mobileTab === "ticket" ? "term-hide-mobile" : ""}`}>
          <section className="panel chart-panel term-chart">
            <TvCandleChart
              title={listed ? `${listed.symbol}` : "Index"}
              markPrice={isDexMarket && dexLivePrice ? dexLivePrice : (settlePx ?? markN)}
              chartSymbol={isDexMarket ? undefined : (chartSym ?? undefined)}
              dexMode={isDexMarket}
              sourceCa={sourceCa}
              dexChange24h={dexChange24h}
            />
          </section>
          <section className="panel term-dock">
            <div className="term-dock-tabs">
              <span className="active">Positions</span>
              {onOpenAccount ? <button type="button" className="text-button" onClick={onOpenAccount}>Account →</button> : null}
            </div>
            <div className="table-scroll">
              <table className="term-pos-table">
                <thead>
                  <tr>
                    <th>Market</th><th>Side</th><th>Size</th><th>Entry</th><th>Mark</th><th>PnL (ROE)</th><th>Margin</th><th />
                  </tr>
                </thead>
                <tbody>
                  {marketInfo?.registered && marketInfo.positionSize !== 0n && uPnl ? (
                    <tr>
                      <td><strong>{pairName}</strong></td>
                      <td className={marketInfo.positionSize > 0n ? "up" : "down"}>{marketInfo.positionSize > 0n ? "Long" : "Short"}</td>
                      <td>{formatTokenAmt(Math.abs(uPnl.sizeN))} · {formatUsd(uPnl.notional)}</td>
                      <td>{formatUsd(uPnl.entry, uPnl.entry < 1 ? 6 : 2)}</td>
                      <td>{formatUsd(uPnl.mark, uPnl.mark < 1 ? 6 : 2)}</td>
                      <td className={uPnl.pnl >= 0 ? "up" : "down"}>
                        {uPnl.pnl >= 0 ? "+" : ""}{formatUsd(uPnl.pnl)}
                        {uPnl.roe != null ? ` (${uPnl.roe >= 0 ? "+" : ""}${uPnl.roe.toFixed(1)}%)` : ""}
                      </td>
                      <td>{formatUsd(uPnl.marginN)}</td>
                      <td>
                        <button type="button" className="button secondary sm" onClick={closePosition}>Close</button>
                        {(marketInfo.deferredPnl > 0n || marketInfo.deferredFunding > 0n) && (
                          <button type="button" className="button secondary sm" onClick={claimDeferred}>Claim</button>
                        )}
                      </td>
                    </tr>
                  ) : (
                    <tr className="empty-row"><td colSpan={8} className="term-empty-pos">No open position on this market.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>
        </div>
        <div className={mobileTab === "chart" ? "term-hide-mobile" : ""}>{orderTicket}</div>
      </div>
    </div>
  );
}

function friendlyTxError(cause: unknown): string {
  const msg = cause instanceof Error ? cause.message : String(cause);
  if (msg.includes("0xe450d38c") || /ERC20InsufficientBalance/i.test(msg) || /insufficient balance/i.test(msg)) {
    return `Not enough ${APUSD_SYMBOL} in your wallet. Tap “Mint 250k ${APUSD_SYMBOL}” first (need ~111k for default LP create, or enough for trade margin), then try again.`;
  }
  if (/ERC20InsufficientAllowance|0xfb8f41b2/i.test(msg)) {
    return "Token approval missing or too low. Confirm the approve step in your wallet.";
  }
  if (/User rejected|denied|4001/i.test(msg)) {
    return "You rejected the wallet request.";
  }
  if (/COLLATERAL_UNSUPPORTED/i.test(msg)) {
    return "This network’s collateral isn’t allowlisted yet.";
  }
  if (/0x0d637948|OracleDeviation/i.test(msg)) {
    return "Oracle feeds disagree briefly. Wait ~30s for server price sync, or tap “Sync price once” (one wallet confirm). Approves are cached after the first time.";
  }
  if (/InvalidRoute|InvalidPrice|InsufficientSources|STALE|LOW_LIQUIDITY|SHORT_HISTORY|LOW_CONFIDENCE/i.test(msg)) {
    return "Price rails need a refresh. Open the market on Trade (auto price sync) or Create → Refresh price rails.";
  }
  if (/UTILIZATION_CAP/i.test(msg)) {
    return "Trade too big for current LP. This market prices like BTC (~$64k) with a stress buffer — try size 0.01–0.05, or add more LP first.";
  }
  if (/LOSS_BUDGET/i.test(msg)) {
    return "Trade exceeds this market’s loss budget. Use a smaller size or add LP/insurance.";
  }
  if (/INITIAL_MARGIN/i.test(msg)) {
    return "Not enough margin for this size. Deposit more test USD margin first.";
  }
  if (/SKEW_CAP/i.test(msg)) {
    return "Hit skew cap — this listing’s max base size is too small for cheap tokens. Switch to the re-listed RH market (higher caps) or use a much smaller $ size.";
  }
  if (/OI_CAP/i.test(msg)) {
    return "Hit open-interest cap for this market. Try a smaller size or wait for OI to free up.";
  }
  if (/POSITION_CAP/i.test(msg)) {
    return "Hit max position notional for this market. Lower $ amount or leverage.";
  }
  if (/PRICE_ABOVE_LIMIT|PRICE_BELOW_LIMIT/i.test(msg)) {
    return "Limit price too tight vs live index. Raise your max price (long) or lower min price (short).";
  }
  if (/BOND_REQUIRED/i.test(msg)) {
    return "Creator bond is below the minimum.";
  }
  if (/MARKET_EXISTS/i.test(msg)) {
    return "A market with this setup already exists — change nothing or wait a second and retry (new salt).";
  }
  // Keep short for UI
  const shortMsg = msg.length > 280 ? `${msg.slice(0, 280)}…` : msg;
  return shortMsg;
}

function CreateMarket({
  account,
  onConnect,
  onTrade,
}: {
  account?: Address;
  onConnect(): void;
  onTrade?(market: string): void;
}) {
  // Simple UX: user pastes CA + sets LP. Platform fills oracle, collateral, bond, insurance, risk.
  const platformCollateral = demoCollateral && isAddress(demoCollateral) ? demoCollateral : "";
  const platformRoute = demoRoute && /^0x[0-9a-fA-F]{64}$/.test(demoRoute) ? demoRoute : "";
  // Empty by default — paste any live Robinhood mainnet CA
  const [ca, setCa] = useState("");
  // Must cover on-chain minSeedLiquidity (100k) + insurance (10k) + bond (1k)
  const [lpSeed, setLpSeed] = useState("100000");
  const [txState, setTxState] = useState<TxState>("idle");
  const [status, setStatus] = useState("");
  const [balLabel, setBalLabel] = useState("—");
  const [balTick, setBalTick] = useState(0);
  const [preview, setPreview] = useState<DexQuoteRef | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [created, setCreated] = useState<{ id: `0x${string}`; market: Address }>();
  const factory = process.env.NEXT_PUBLIC_MARKET_FACTORY_ADDRESS;
  const validCa = isAddress(ca);
  const lpNum = Number(lpSeed);
  const isDemoBase = !!(demoBase && isAddress(demoBase) && ca.toLowerCase() === demoBase.toLowerCase());
  const canLaunch =
    validCa &&
    !!platformCollateral &&
    !!factory &&
    isAddress(factory) &&
    Number.isFinite(lpNum) &&
    lpNum > 0 &&
    (isDemoBase ? !!platformRoute : true);

  // Protocol mins (experimental tier): bond ≥ 1000, insurance ≥ 10k, LP ≥ 100k
  const bondAmount = Math.max(1000, Math.floor(lpNum * 0.01)).toString();
  const insuranceAmount = Math.max(10_000, Math.floor(lpNum * 0.1)).toString();
  const totalNeeded = (Number(bondAmount) || 0) + (Number(lpSeed) || 0) + (Number(insuranceAmount) || 0);

  useEffect(() => {
    if (!account || !platformCollateral || !isAddress(platformCollateral)) {
      setBalLabel("—");
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const bal = await readApUsdBalance(account);
        if (!cancelled) setBalLabel(bal.label);
      } catch {
        if (!cancelled) setBalLabel("—");
      }
    })();
    const t = setInterval(() => {
      void (async () => {
        try {
          const bal = await readApUsdBalance(account);
          if (!cancelled) setBalLabel(bal.label);
        } catch { /* keep last */ }
      })();
    }, 8_000);
    return () => { cancelled = true; clearInterval(t); };
  }, [account, platformCollateral, txState, balTick]);

  useEffect(() => {
    if (!validCa) { setPreview(null); return; }
    let cancelled = false;
    setPreviewLoading(true);
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const rh = await fetchRobinhoodDex(ca);
          if (rh) {
            if (!cancelled) {
              setPreview({
                priceUsd: rh.priceUsd,
                marketCap: rh.marketCap,
                fdv: null,
                volume24h: rh.volume24h,
                liquidityUsd: rh.liquidityUsd,
                symbol: rh.symbol,
                name: rh.name,
                chainId: "robinhood",
                url: rh.url,
                priceChange24h: rh.priceChange24h ?? null,
              });
            }
            return;
          }
          const hit = await fetchDexQuoteDirect(ca);
          if (!cancelled) setPreview(hit);
        } catch {
          if (!cancelled) setPreview(null);
        } finally {
          if (!cancelled) setPreviewLoading(false);
        }
      })();
    }, 400);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [ca, validCa]);

  async function mintCreateFunds() {
    if (!account) { onConnect(); return; }
    if (!platformCollateral || !isAddress(platformCollateral)) {
      setStatus("Collateral not configured on this deployment.");
      return;
    }
    if (!featureFlags.publicFaucet) {
      setStatus("Faucet disabled on this network.");
      return;
    }
    try {
      setTxState("checking");
      setStatus(`Minting 250,000 ${APUSD_SYMBOL}… confirm in wallet`);
      setTxState("awaiting_signature");
      const hash = await mintApUsdTo(account);
      setTxState("idle");
      setBalTick((n) => n + 1);
      try {
        const bal = await readApUsdBalance(account);
        setBalLabel(bal.label);
      } catch { /* poll will retry */ }
      setStatus(
        `Minted 250,000 ${APUSD_SYMBOL} · tx ${short(hash)}. Balance above should update. Enough for create (100k LP + insurance + bond). Not real money.`,
      );
    } catch (cause) {
      setTxState("failed");
      setStatus(friendlyTxError(cause));
    }
  }

  const oracleRouter = process.env.NEXT_PUBLIC_ORACLE_ROUTER_ADDRESS || "";

  /** Push price into mock adapters for a base token (Pyth BTC/ETH/SOL or DexScreener). */
  async function pushOracleForAsset(
    walletAccount: Address,
    asset: Address,
    opts?: { pythSymbol?: string; dexPrice?: number; liqUsd?: number },
  ): Promise<number> {
    if (!window.ethereum) throw new Error("Connect a wallet first.");
    if (!oracleAdapters.length) throw new Error("Oracle adapters not configured.");
    const wallet = createWalletClient({ account: walletAccount, chain: appChain, transport: custom(window.ethereum) });
    let px = opts?.dexPrice;
    if (!(px && px > 0) && opts?.pythSymbol) {
      const prices = await fetchPythDirect([opts.pythSymbol]);
      px = prices[0]?.price;
    }
    if (!(px && px > 0) && isDemoBase) {
      const prices = await fetchPythDirect(["BTC"]);
      px = prices[0]?.price;
    }
    if (!(px && px > 0) && preview?.priceUsd) px = preview.priceUsd;
    if (!(px && px > 0)) throw new Error("Could not fetch a price for this token (Pyth/Dex).");
    const block = await publicClient.getBlock();
    const priceStr = px >= 1 ? px.toFixed(8) : px.toFixed(18);
    const data = {
      priceWad: parseUnits(priceStr, 18),
      confidenceBps: 20n,
      updatedAt: block.timestamp,
      liquidityWad: parseUnits(String(Math.max(1_000_000, Math.floor(opts?.liqUsd ?? preview?.liquidityUsd ?? 5_000_000))), 18),
      historySeconds: 2_592_000n,
      validSources: 1,
    } as const;
    for (const adapter of oracleAdapters) {
      const sim = await publicClient.simulateContract({
        account: walletAccount,
        address: adapter,
        abi: mockOracleWriteAbi,
        functionName: "set",
        args: [asset, data],
      });
      const hash = await wallet.writeContract(sim.request);
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new Error("Price rail update failed.");
    }
    return px;
  }

  async function ensureRouteForAsset(walletAccount: Address, asset: Address): Promise<`0x${string}`> {
    if (!oracleRouter || !isAddress(oracleRouter)) throw new Error("Oracle router not configured.");
    if (!oracleAdapters.length) throw new Error("Oracle adapters not configured.");
    const wallet = createWalletClient({ account: walletAccount, chain: appChain, transport: custom(window.ethereum!) });
    try {
      const sim = await publicClient.simulateContract({
        account: walletAccount,
        address: oracleRouter as Address,
        abi: oracleRouterWriteAbi,
        functionName: "createRoute",
        args: [asset, oracleAdapters],
      });
      const hash = await wallet.writeContract(sim.request);
      await publicClient.waitForTransactionReceipt({ hash });
      return sim.result as `0x${string}`;
    } catch {
      // ROUTE_EXISTS — deterministic id
      return keccak256(
        encodeAbiParameters(
          [{ type: "uint256" }, { type: "address" }, { type: "address[]" }],
          [BigInt(appChain.id), asset, oracleAdapters],
        ),
      );
    }
  }

  /** Push live Pyth BTC into mock adapters so validateMarket can pass (testnet bridge). */
  async function refreshPriceRails(walletAccount: Address) {
    const asset = (isDemoBase && demoBase ? demoBase : ca) as Address;
    if (!isAddress(asset)) throw new Error("Paste a token CA first.");
    const listedHit = LISTED_MARKETS.find((m) => m.baseToken?.toLowerCase() === asset.toLowerCase());
    const px = await pushOracleForAsset(walletAccount, asset, {
      pythSymbol: listedHit?.pyth ?? (isDemoBase ? "BTC" : preview?.symbol && PYTH_FEEDS_UI[preview.symbol.toUpperCase()] ? preview.symbol.toUpperCase() : undefined),
      dexPrice: preview?.priceUsd ?? undefined,
      liqUsd: preview?.liquidityUsd ?? undefined,
    });
    if (isDemoBase && platformRoute && oracleRouter && isAddress(oracleRouter)) {
      try {
        await publicClient.readContract({
          address: oracleRouter as Address,
          abi: oracleRouterReadAbi,
          functionName: "getPrice",
          args: [platformRoute as `0x${string}`],
        });
      } catch {
        throw new Error("Price rails still invalid after refresh.");
      }
    }
    return px;
  }

  async function onRefreshRailsClick() {
    if (!account) { onConnect(); return; }
    try {
      setTxState("awaiting_signature");
      setStatus("Refreshing price rails from Pyth (confirm 2 wallet txs)…");
      const px = await refreshPriceRails(account);
      setTxState("idle");
      setStatus(`Price rails OK — index ≈ $${px.toLocaleString(undefined, { maximumFractionDigits: 2 })}. You can create now.`);
    } catch (cause) {
      setTxState("failed");
      setStatus(friendlyTxError(cause));
    }
  }

  async function deployAndActivate() {
    if (!account) { onConnect(); return; }
    if (!window.ethereum) { setStatus("Connect a wallet first."); return; }
    if (!canLaunch) {
      setStatus("Paste a valid Robinhood token CA and set LP.");
      return;
    }
    if (lpNum < 100_000) {
      setStatus("LP must be at least 100,000 test USD (protocol minimum for this tier).");
      return;
    }
    if (!isAddress(launchHelperAddress)) {
      setStatus("Launch helper not configured.");
      return;
    }
    // 1 CA → 1 market: block if source CA already has a catalog market
    const existing = findMarketByCa(ca, LISTED_MARKETS);
    if (existing?.market && isAddress(existing.market)) {
      setTxState("idle");
      setStatus(`This CA already has a market (${existing.symbol ? `${existing.symbol}-PERP` : short(existing.market)}). Opening Trade…`);
      onTrade?.(existing.market);
      return;
    }
    const collateralAddress = platformCollateral as Address;
    const factoryAddress = factory as Address;
    const sourceCa = ca as Address;
    const oracleRouterAddr = (process.env.NEXT_PUBLIC_ORACLE_ROUTER_ADDRESS || oracleRouter) as Address;

    try {
      setTxState("checking");
      setStatus("Looking up mainnet DexScreener price…");
      const wallet = createWalletClient({ account, chain: appChain, transport: custom(window.ethereum) });

      let dex = await fetchRobinhoodDex(sourceCa);
      if (!dex && preview?.priceUsd) {
        dex = {
          priceUsd: preview.priceUsd,
          symbol: preview.symbol || "TOKEN",
          name: preview.name || "Token",
          liquidityUsd: preview.liquidityUsd || 1_000_000,
          marketCap: preview.marketCap,
          volume24h: preview.volume24h,
          url: preview.url,
        };
      }
      // Demo base can use Pyth BTC; everything else needs Dex
      let px = dex?.priceUsd ?? 0;
      if (isDemoBase) {
        const pyth = await fetchPythDirect(["BTC"]);
        if (pyth[0]?.price) px = pyth[0].price;
      }
      if (!(px > 0)) {
        setTxState("failed");
        setStatus("No price for this CA. Token must be live on Robinhood (DexScreener).");
        return;
      }

      const decimals = await publicClient.readContract({ address: collateralAddress, abi: erc20Abi, functionName: "decimals" });
      const bondRaw = parseUnits(bondAmount, decimals);
      const lpRaw = parseUnits(lpSeed, decimals);
      const insuranceRaw = parseUnits(insuranceAmount, decimals);
      const needed = bondRaw + lpRaw + insuranceRaw;
      const bal = await publicClient.readContract({
        address: collateralAddress,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [account],
      });
      if (bal < needed) {
        setTxState("failed");
        setStatus(
          `Not enough ${APUSD_SYMBOL}. Wallet has ${Number(formatUnits(bal, decimals)).toLocaleString()}, need ~${totalNeeded.toLocaleString()}. Tap “Mint 250k ${APUSD_SYMBOL}” first.`,
        );
        return;
      }

      // One max approve to launch helper (skipped if already infinite / enough)
      const allowance = await publicClient.readContract({
        address: collateralAddress,
        abi: erc20Abi,
        functionName: "allowance",
        args: [account, launchHelperAddress],
      });
      if (allowance < needed) {
        setTxState("awaiting_signature");
        setStatus("Confirm 1/2 — Approve test USD once (unlimited). Next click does full launch.");
        const approveHash = await wallet.writeContract(
          (
            await publicClient.simulateContract({
              account,
              address: collateralAddress,
              abi: erc20Abi,
              functionName: "approve",
              args: [launchHelperAddress, maxUint256],
            })
          ).request,
        );
        const approveReceipt = await publicClient.waitForTransactionReceipt({ hash: approveHash });
        if (approveReceipt.status !== "success") throw new Error("Approve failed.");
      }

      const code = await publicClient.getCode({ address: sourceCa });
      const needsMirror = !isDemoBase && (!code || code === "0x");
      const symbol = (dex?.symbol || (isDemoBase ? "BTC" : "TOKEN")).slice(0, 11);
      const block = await publicClient.getBlock();
      const priceStr = px >= 1 ? px.toFixed(8) : px.toFixed(18);
      const priceData = {
        priceWad: parseUnits(priceStr, 18),
        confidenceBps: 20n,
        updatedAt: block.timestamp,
        liquidityWad: parseUnits(String(Math.max(1_000_000, Math.floor(dex?.liquidityUsd ?? 5_000_000))), 18),
        historySeconds: 2_592_000n,
        validSources: 1,
      } as const;
      // Stable salt per source CA so re-launches hit MARKET_EXISTS instead of minting clones
      const salt = keccak256(stringToHex(`anyperp:v1:source:${sourceCa.toLowerCase()}`));

      setTxState("awaiting_signature");
      setStatus(
        needsMirror
          ? "Confirm 2/2 — Launch: mirror + oracle + market + LP (one signature)…"
          : "Confirm 2/2 — Launch market live (one signature)…",
      );

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const helperAbi = (launchHelperMeta as { abi: any[] }).abi;
      const sim = await publicClient.simulateContract({
        account,
        address: launchHelperAddress,
        abi: helperAbi,
        functionName: "launch",
        args: [
          factoryAddress,
          collateralAddress,
          oracleRouterAddr,
          oracleAdapters,
          needsMirror ? ("0x0000000000000000000000000000000000000000" as Address) : sourceCa,
          needsMirror,
          sourceCa,
          symbol,
          { ...experimentalRiskForPrice(Number(px) > 0 ? Number(px) : 1) },
          3,
          bondRaw,
          lpRaw,
          insuranceRaw,
          salt,
          priceData,
        ],
      });
      const hash = await wallet.writeContract(sim.request);
      setStatus("Launch submitted — waiting for confirmation…");
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new Error("Launch transaction reverted.");

      // Parse MarketLaunched(launcher, market, marketId, baseToken, sourceHint, symbol)
      const launchedEvent = parseAbiItem(
        "event MarketLaunched(address indexed launcher, address indexed market, bytes32 marketId, address baseToken, address sourceHint, string symbol)",
      );
      let marketAddress: Address | undefined;
      let marketId: `0x${string}` | undefined;
      let baseTokenOut: Address | undefined;
      for (const log of receipt.logs) {
        try {
          if (log.address.toLowerCase() !== launchHelperAddress.toLowerCase()) continue;
          const decoded = decodeEventLog({
            abi: [launchedEvent],
            data: log.data,
            topics: log.topics,
          });
          if (decoded.eventName === "MarketLaunched") {
            const args = decoded.args as {
              market: Address;
              marketId: `0x${string}`;
              baseToken: Address;
            };
            marketAddress = args.market;
            marketId = args.marketId;
            baseTokenOut = args.baseToken;
            break;
          }
        } catch {
          /* not our event */
        }
      }
      if (!marketAddress || !marketId) {
        const result = sim.result as [`0x${string}`, Address, Address] | undefined;
        if (result?.[0] && result?.[1]) {
          marketId = result[0];
          marketAddress = result[1];
          baseTokenOut = result[2];
        }
      }
      if (!marketAddress || !marketId) throw new Error("Launch succeeded but market address missing from receipt.");

      setCreated({ id: marketId, market: marketAddress });

      let liqVault: string | undefined;
      try {
        const dep = await publicClient.readContract({
          address: factoryAddress,
          abi: factoryAbi,
          functionName: "deployments",
          args: [marketId],
        });
        liqVault = dep[2];
      } catch { /* optional */ }

      saveCommunityMarket({
        symbol,
        label: dex?.name ? `${dex.name} (RH mainnet)` : `${symbol} (RH)`,
        market: marketAddress,
        marketId,
        baseToken: baseTokenOut || sourceCa,
        sourceCa,
        liquidityVault: liqVault,
        chartSymbol: null,
        pyth: isDemoBase ? "BTC" : null,
        dexPrice: true,
        source: "dexscreener-robinhood",
        active: true,
        createdAt: new Date().toISOString(),
        creator: account,
        dexUrl: dex?.url,
      });

      setTxState("confirmed");
      setStatus(`Live now! ${symbol}-PERP ${short(marketAddress)} — opening Trade…`);
      // Instant switch to trade this market
      onTrade?.(marketAddress);
    } catch (cause) {
      setTxState("failed");
      setStatus(`${friendlyTxError(cause)}${created ? ` Draft: ${created.market}` : ""}`);
    }
  }

  return (
    <div className="create-flow">
      <header className="create-head">
        <h1>Launch any Robinhood token</h1>
        <p>
          Paste a <strong>mainnet RH token CA</strong> people already trade. We mirror it on testnet if needed,
          wire mainnet Dex price, open the perp. Anyone can then trade — PnL on testnet, price tracks mainnet.
        </p>
      </header>

      <section className="panel form-panel create-panel">
        <div className="activation-flow" style={{ marginBottom: "1.25rem" }}>
          {["Paste CA", `Mint ${APUSD_SYMBOL}`, "1 approve + 1 launch", "Live on Trade"].map((label, index) => (
            <div className="flow-step" key={label}>
              <span>{index + 1}</span>
              <div><strong>{label}</strong></div>
            </div>
          ))}
        </div>

        <h2>Robinhood token CA (mainnet / DexScreener)</h2>
        <p className="section-copy">
          Only <strong>1–2 wallet clicks</strong>: approve {APUSD_SYMBOL} (once), then one Launch tx that opens the full market.
          Mirror + oracle + LP + activate all happen inside that launch.
        </p>
        <Field label="Token contract address (CA)" value={ca} setValue={setCa} placeholder="0x… mainnet RH token" mono />
        {ca.length > 2 && !validCa && <p className="field-hint warn">That doesn’t look like an address yet.</p>}
        {previewLoading && validCa && <p className="field-hint">Looking up DexScreener…</p>}
        {preview && (
          <div className="review-list" style={{ marginTop: "0.75rem" }}>
            <div><span>Token</span><strong>{preview.symbol ?? "—"} {preview.name ? `· ${preview.name}` : ""}</strong></div>
            <div><span>Mainnet spot</span><strong>{money(preview.priceUsd, 8)}</strong></div>
            <div><span>MC / 24h vol</span><strong>{money(preview.marketCap)} / {money(preview.volume24h)}</strong></div>
            <div><span>Chain</span><strong>{preview.chainId ?? "robinhood"}{preview.url ? <> · <a href={preview.url} target="_blank" rel="noreferrer">Dex ↗</a></> : null}</strong></div>
          </div>
        )}

        <h2 style={{ marginTop: "1.5rem" }}>Your liquidity (LP)</h2>
        <p className="section-copy">
          Uses mintable <strong>{APUSD_SYMBOL}</strong> (test USD). Min 100,000. Play money only.
        </p>
        <Field label={`LP amount (${APUSD_SYMBOL})`} value={lpSeed} setValue={setLpSeed} placeholder="100000" />
        <div className="review-list" style={{ marginTop: "0.75rem" }}>
          <div><span>Wallet {APUSD_SYMBOL}</span><strong>{balLabel}</strong></div>
          <div><span>You set</span><strong>{lpSeed || "—"} LP</strong></div>
          <div><span>Auto total needed</span><strong>~{totalNeeded.toLocaleString()} (LP + ~{insuranceAmount} insurance + ~{bondAmount} bond)</strong></div>
          <div><span>Price source</span><strong>DexScreener mainnet → testnet oracle</strong></div>
        </div>

        <div className="warning-banner" style={{ marginTop: "1rem" }}>
          <strong>Step 0 — {APUSD_SYMBOL}</strong>
          <span>Need ~{totalNeeded.toLocaleString()} {APUSD_SYMBOL} (wallet has {balLabel}).</span>
          <button className="text-button" type="button" onClick={mintCreateFunds}>Mint 250k {APUSD_SYMBOL}</button>
        </div>
        <div className="warning-banner" style={{ marginTop: "0.5rem" }}>
          <strong>Fast launch</strong>
          <span>Approve helper once (unlimited) → one Launch signature → market is Active and appears on Trade immediately.</span>
        </div>

        {status && (
          <p className={txState === "confirmed" ? "form-success" : txState === "failed" ? "form-error" : "section-copy"} style={{ marginTop: "1rem" }}>
            {status}
          </p>
        )}
        {created && (
          <div className="review-list" style={{ marginTop: "0.75rem" }}>
            <div><span>Market</span><code className="mono">{created.market}</code></div>
            {onTrade && (
              <div>
                <span>Action</span>
                <button className="text-button" type="button" onClick={() => onTrade(created.market)}>Trade this market</button>
              </div>
            )}
          </div>
        )}

        <div className="form-actions" style={{ marginTop: "1.25rem" }}>
          <button
            className="button primary"
            type="button"
            disabled={txState === "awaiting_signature" || txState === "checking" || (!!account && !canLaunch)}
            onClick={deployAndActivate}
          >
            {!account
              ? "Connect wallet"
              : txState === "checking"
                ? "Working…"
                : txState === "awaiting_signature"
                  ? "Confirm in wallet…"
                  : txState === "confirmed"
                    ? "Market is live"
                    : "Create market & go live"}
          </button>
        </div>
      </section>
    </div>
  );
}

function Liquidity({ account, onConnect, onMarkets }: { account?: Address; onConnect(): void; onMarkets(): void }) {
  const [amount, setAmount] = useState("1000");
  const [txState, setTxState] = useState<TxState>("idle");
  const [status, setStatus] = useState("");
  const [stats, setStats] = useState<{ total: string; shares: string; bal: string } | null>(null);
  const hasDemo = demoVault && isAddress(demoVault) && demoCollateral && isAddress(demoCollateral);

  useEffect(() => {
    if (!hasDemo) return;
    let cancelled = false;
    (async () => {
      try {
        const total = await publicClient.readContract({ address: demoVault as Address, abi: liquidityVaultAbi, functionName: "totalAssets" });
        const shares = account
          ? await publicClient.readContract({ address: demoVault as Address, abi: liquidityVaultAbi, functionName: "balanceOf", args: [account] })
          : 0n;
        const bal = account
          ? await publicClient.readContract({ address: demoCollateral as Address, abi: erc20Abi, functionName: "balanceOf", args: [account] })
          : 0n;
        if (!cancelled) {
          setStats({
            total: Number(formatUnits(total, 6)).toLocaleString(undefined, { maximumFractionDigits: 2 }),
            shares: formatUnits(shares, 18),
            bal: Number(formatUnits(bal, 6)).toLocaleString(undefined, { maximumFractionDigits: 2 }),
          });
        }
      } catch {
        if (!cancelled) setStats(null);
      }
    })();
    return () => { cancelled = true; };
  }, [account, hasDemo, txState]);

  async function addLp() {
    if (!account) { onConnect(); return; }
    if (!hasDemo) { setStatus("Demo vault not configured."); return; }
    if (!amount || Number(amount) <= 0) { setStatus("Enter a positive LP amount."); return; }
    try {
      setTxState("checking"); setStatus("Simulating approve + deposit…");
      const wallet = createWalletClient({ account, chain: appChain, transport: custom(window.ethereum!) });
      const assets = parseUnits(amount, 6);
      const approval = await publicClient.simulateContract({ account, address: demoCollateral as Address, abi: erc20Abi, functionName: "approve", args: [demoVault as Address, assets] });
      setTxState("awaiting_signature"); setStatus("1/2 Approve apUSD for the LP vault.");
      let hash = await wallet.writeContract(approval.request);
      await publicClient.waitForTransactionReceipt({ hash });
      const deposit = await publicClient.simulateContract({ account, address: demoVault as Address, abi: liquidityVaultAbi, functionName: "deposit", args: [assets, account] });
      setStatus("2/2 Confirm LP deposit.");
      hash = await wallet.writeContract(deposit.request);
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new Error("LP deposit reverted.");
      setTxState("confirmed"); setStatus(`LP deposited in block ${receipt.blockNumber}.`);
    } catch (cause) {
      setTxState("failed"); setStatus(cause instanceof Error ? cause.message : "LP deposit failed");
    }
  }

  return <>
    <PageHead eyebrow="Back a market" title="Liquidity vaults" description="One vault. One market. You earn fees and trader losses - and pay when traders win." />
    {!hasDemo ? (
      <section className="panel"><EmptyState title="Pick a live market first" text="Then you&apos;ll see vault size, how much is in use, pending exits, and your share value." action={account ? "Browse markets" : "Connect wallet"} onAction={account ? onMarkets : onConnect} /></section>
    ) : (
      <section className="panel form-panel">
        <div className="panel-title"><h2>sBASE vault</h2><span className="badge green">LIVE</span></div>
        <div className="review-list">
          <div><span>Vault</span><code>{short(demoVault)}</code></div>
          <div><span>Total assets</span><strong>{stats?.total ?? "…"} apUSD</strong></div>
          <div><span>Your shares</span><strong>{account ? (stats?.shares ?? "…") : "Connect wallet"}</strong></div>
          <div><span>Your apUSD</span><strong>{account ? (stats?.bal ?? "…") : "—"}</strong></div>
        </div>
        <Field label="LP amount (apUSD)" value={amount} setValue={setAmount} placeholder="1000" />
        {status && <p className={txState === "confirmed" ? "form-success" : txState === "failed" ? "form-error" : "section-copy"}>{status}</p>}
        <div className="form-actions">
          <button className="button primary" type="button" disabled={txState === "checking" || txState === "awaiting_signature"} onClick={addLp}>
            {!account ? "Connect wallet" : txState === "awaiting_signature" ? "Confirm in wallet" : "Add LP"}
          </button>
        </div>
      </section>
    )}
    <div className="risk-cards"><InfoCard title="Exits aren&apos;t instant" text="You request a withdrawal. It waits the market delay and only runs when free liquidity is there." /><InfoCard title="LP value can drop" text="When traders win bigger than fees + losses, your shares take the hit. That&apos;s the deal." /><InfoCard title="One vault, one market" text="This vault never silently covers another market&apos;s mess." /></div>
  </>;
}
const knownMarketsEnv = [
  demoMarket,
  process.env.NEXT_PUBLIC_DEMO_MARKET_ADDRESS,
  // RATDOG E2E market (DexScreener robinhood mirror)
  "0x0152536235A3Be21481d66BA6CA51Ba26C054A08",
].filter((a): a is string => Boolean(a && isAddress(a)));

const registryListAbi = [
  { type: "function", name: "count", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "at", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [{ type: "address" }] },
] as const;

const tradeHistoryEventAbi = [
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
  {
    type: "event",
    name: "MarginDeposited",
    inputs: [
      { name: "account", type: "address", indexed: true },
      { name: "amountRaw", type: "uint256", indexed: false },
      { name: "amountWad", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "MarginWithdrawn",
    inputs: [
      { name: "account", type: "address", indexed: true },
      { name: "amountRaw", type: "uint256", indexed: false },
      { name: "amountWad", type: "uint256", indexed: false },
    ],
  },
] as const;

async function listRegistryMarkets(): Promise<Address[]> {
  const registry = process.env.NEXT_PUBLIC_MARKET_REGISTRY_ADDRESS;
  const found = new Set<string>(knownMarketsEnv.map((a) => a.toLowerCase()));
  for (const m of LISTED_MARKETS) {
    if (m.market && isAddress(m.market)) found.add(m.market.toLowerCase());
  }
  if (registry && isAddress(registry)) {
    try {
      const count = await publicClient.readContract({
        address: registry as Address,
        abi: registryListAbi,
        functionName: "count",
      });
      const n = Number(count > 50n ? 50n : count);
      for (let i = 0; i < n; i++) {
        const m = await publicClient.readContract({
          address: registry as Address,
          abi: registryListAbi,
          functionName: "at",
          args: [BigInt(i)],
        });
        found.add(m.toLowerCase());
      }
    } catch { /* registry optional */ }
  }
  // Hosted indexer projections (Railway) — discover markets beyond the static list.
  if (apiEnabled) {
    try {
      const rows = await apiGet<Array<{ market_address?: string; contract_address?: string }>>(
        "/v1/projections/markets?limit=100",
      );
      for (const row of rows ?? []) {
        const addr = row.market_address || row.contract_address;
        if (addr && isAddress(addr)) found.add(addr.toLowerCase());
      }
    } catch { /* projections optional */ }
  }
  return [...found].filter((a) => isAddress(a)) as Address[];
}

type PortfolioRow = {
  market: Address;
  symbol: string;
  label?: string;
  state: number;
  index: number;
  size: number;
  entry: number;
  margin: number;
  equity: number;
  uPnl: number;
  notional: number;
  roe: number | null;
  priceMovePct: number;
  side: "long" | "short" | "idle";
  /** size 0 but margin left — needs withdraw to hit wallet apUSD */
  idleMargin: boolean;
};

function Portfolio({ account, onConnect, onTrade }: { account?: Address; onConnect(): void; onTrade(): void }) {
  const [rows, setRows] = useState<PortfolioRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [updatedAt, setUpdatedAt] = useState("");
  const [walletApUsd, setWalletApUsd] = useState("—");
  const [walletApUsdN, setWalletApUsdN] = useState(0);
  const [faucetStatus, setFaucetStatus] = useState("");
  const [minting, setMinting] = useState(false);
  const [withdrawing, setWithdrawing] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!account) {
      setRows([]);
      setWalletApUsd("—");
      setWalletApUsdN(0);
      return;
    }
    let cancelled = false;
    async function load() {
      setLoading(true);
      setErr("");
      try {
        try {
          const bal = await readApUsdBalance(account!);
          if (!cancelled) {
            setWalletApUsd(bal.label);
            setWalletApUsdN(bal.amount);
          }
        } catch {
          if (!cancelled) {
            setWalletApUsd("—");
            setWalletApUsdN(0);
          }
        }
        const markets = await listRegistryMarkets();
        const out: PortfolioRow[] = [];
        for (const market of markets) {
          try {
            const [state, index, position, equity] = await Promise.all([
              publicClient.readContract({ address: market, abi: marketAbi, functionName: "state" }),
              publicClient.readContract({ address: market, abi: marketAbi, functionName: "indexPrice" }),
              publicClient.readContract({ address: market, abi: marketAbi, functionName: "position", args: [account!] }),
              publicClient.readContract({ address: market, abi: marketAbi, functionName: "accountEquityWad", args: [account!] }),
            ]);
            const size = Number(formatUnits(position.sizeBaseWad, 18));
            const margin = Number(formatUnits(position.marginWad, 18));
            // Open book OR idle margin after close (must surface so user can withdraw to wallet)
            if (size === 0 && margin < 0.000001) continue;
            const entry = Number(formatUnits(position.entryPriceWad, 18));
            const mark = Number(formatUnits(index, 18));
            const eq = Number(formatUnits(equity, 18));
            const uPnl = size === 0 || entry <= 0 ? 0 : size * (mark - entry);
            const notional = Math.abs(size) * mark;
            const roe = margin > 0 && size !== 0 ? (uPnl / margin) * 100 : null;
            const priceMovePct = size !== 0 && entry > 0 ? ((mark - entry) / entry) * 100 * (size >= 0 ? 1 : -1) : 0;
            const meta = await resolveMarketMeta(market);
            out.push({
              market,
              symbol: meta.symbol,
              label: meta.label,
              state: Number(state),
              index: mark,
              size,
              entry,
              margin,
              equity: eq,
              uPnl,
              notional,
              roe,
              priceMovePct,
              side: size > 0 ? "long" : size < 0 ? "short" : "idle",
              idleMargin: size === 0 && margin > 0,
            });
          } catch { /* skip bad market */ }
        }
        if (!cancelled) {
          setRows(out);
          setUpdatedAt(new Date().toLocaleTimeString());
        }
      } catch (cause) {
        if (!cancelled) setErr(cause instanceof Error ? cause.message : "Failed to load portfolio");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    const t = setInterval(() => void load(), 8_000);
    return () => { cancelled = true; clearInterval(t); };
  }, [account, tick]);

  async function withdrawIdleMargin(market: Address) {
    if (!account) return;
    try {
      setWithdrawing(market);
      setErr("");
      const position = await publicClient.readContract({
        address: market,
        abi: marketAbi,
        functionName: "position",
        args: [account],
      });
      if (position.sizeBaseWad !== 0n) {
        setErr("Close the open size first, then withdraw.");
        return;
      }
      if (position.marginWad === 0n) {
        setErr("Nothing to withdraw on this market.");
        return;
      }
      const collateral = await publicClient.readContract({
        address: market,
        abi: marketAbi,
        functionName: "collateralToken",
      });
      const decimals = await publicClient.readContract({
        address: collateral,
        abi: erc20Abi,
        functionName: "decimals",
      });
      const scale = 10n ** BigInt(Math.max(0, 18 - Number(decimals)));
      const raw = position.marginWad / scale;
      if (raw === 0n) {
        setErr("Margin dust only — nothing withdrawable.");
        return;
      }
      const wallet = createWalletClient({ account, chain: appChain, transport: custom(window.ethereum!) });
      const sim = await publicClient.simulateContract({
        account,
        address: market,
        abi: marketAbi,
        functionName: "withdrawMargin",
        args: [raw],
      });
      const hash = await wallet.writeContract(sim.request);
      await publicClient.waitForTransactionReceipt({ hash });
      const bal = await readApUsdBalance(account);
      setWalletApUsd(bal.label);
      setWalletApUsdN(bal.amount);
      setFaucetStatus(
        `Withdrew ${formatUsd(Number(formatUnits(position.marginWad, 18)))} ${APUSD_SYMBOL} to wallet · tx ${short(hash)}`,
      );
      setTick((n) => n + 1);
    } catch (cause) {
      setErr(friendlyTxError(cause));
    } finally {
      setWithdrawing(null);
    }
  }

  async function mintFromPortfolio() {
    if (!account) { onConnect(); return; }
    if (!featureFlags.publicFaucet || !featureFlags.allowMintableCollateral) {
      setFaucetStatus("Faucet disabled on this network.");
      return;
    }
    try {
      setMinting(true);
      setFaucetStatus(`Minting 250,000 ${APUSD_SYMBOL}…`);
      const hash = await mintApUsdTo(account);
      const bal = await readApUsdBalance(account);
      setWalletApUsd(bal.label);
      setFaucetStatus(`Minted 250,000 ${APUSD_SYMBOL} · tx ${short(hash)}. Balance updated above.`);
    } catch (cause) {
      setFaucetStatus(friendlyTxError(cause));
    } finally {
      setMinting(false);
    }
  }

  const totals = useMemo(() => {
    const equity = rows.reduce((s, r) => s + r.equity, 0);
    const uPnl = rows.reduce((s, r) => s + r.uPnl, 0);
    const open = rows.filter((r) => !r.idleMargin).length;
    const idle = rows.filter((r) => r.idleMargin).reduce((s, r) => s + r.margin, 0);
    const totalNetWorth = walletApUsdN + equity;
    return { equity, uPnl, open, idle, totalNetWorth };
  }, [rows, walletApUsdN]);

  return <>
    <PageHead eyebrow="Your book" title="Portfolio" description="Live on-chain positions across registered markets. Isolated per market — no cross-margin." action={account ? <button className="button primary" type="button" onClick={onTrade}>Trade</button> : undefined} />
    {!account ? (
      <section className="panel"><EmptyState title="Connect to see your book" text="We read positions and equity straight from market contracts." action="Connect wallet" onAction={onConnect} /></section>
    ) : (
      <>
        <section className="panel" style={{ marginBottom: "1rem" }}>
          <div className="panel-title">
            <h2>Balances · {APUSD_LABEL}</h2>
            <span className="badge green">TESTNET</span>
          </div>
          <div className="review-list">
            <div><span>Wallet free {APUSD_SYMBOL}</span><strong>{walletApUsd}</strong></div>
            <div><span>In markets (equity)</span><strong>{formatUsd(totals.equity)}</strong></div>
            <div><span>Est. net worth</span><strong>{formatUsd(totals.totalNetWorth)}</strong></div>
            <div><span>Idle margin (withdraw)</span><strong className={totals.idle > 0 ? "up" : ""}>{formatUsd(totals.idle)}</strong></div>
            <div>
              <span>Faucet</span>
              <button className="text-button" type="button" onClick={mintFromPortfolio} disabled={minting}>
                {minting ? "Minting…" : `Mint 250k ${APUSD_SYMBOL}`}
              </button>
            </div>
            <div>
              <span>Contract</span>
              <a
                className="mono"
                href={`${explorerBase}/address/${demoCollateral}`}
                target="_blank"
                rel="noreferrer"
              >
                {short(demoCollateral)}
              </a>
            </div>
          </div>
          <p className="section-copy term-muted" style={{ marginTop: "0.75rem" }}>
            Profit/loss first hits <strong>market margin / equity</strong>. After <strong>Close</strong>, funds auto-return to wallet free {APUSD_SYMBOL}.
            If you closed earlier without withdraw, rows marked <strong>IDLE</strong> still hold margin — tap <strong>Withdraw</strong>.
          </p>
          {faucetStatus && <p className="section-copy" style={{ marginTop: "0.5rem" }}>{faucetStatus}</p>}
        </section>
        <section className="panel" style={{ marginBottom: "1rem" }}>
          <div className="panel-title">
            <h2>Live summary</h2>
            <span className="badge green">{loading ? "LOADING" : "ON-CHAIN"}</span>
          </div>
          <div className="review-list">
            <div><span>Open markets</span><strong>{totals.open}</strong></div>
            <div><span>Total equity</span><strong>{totals.equity.toLocaleString(undefined, { maximumFractionDigits: 4 })}</strong></div>
            <div><span>Total uPnL</span><strong style={{ color: totals.uPnl >= 0 ? "var(--pnl-up)" : "var(--pnl-down)" }}>{totals.uPnl >= 0 ? "+" : ""}{totals.uPnl.toLocaleString(undefined, { maximumFractionDigits: 4 })}</strong></div>
            <div><span>Updated</span><strong>{updatedAt || "—"}</strong></div>
          </div>
          {err && <p className="form-error">{err}</p>}
        </section>
        <section className="panel table-panel">
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Market</th>
                  <th>Side</th>
                  <th>Size</th>
                  <th>Value</th>
                  <th>Entry</th>
                  <th>Mark</th>
                  <th>uPnL</th>
                  <th>ROE</th>
                  <th>Margin</th>
                  <th>Equity</th>
                  <th>State</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 ? (
                  <tr className="empty-row">
                    <td colSpan={12}>
                      <EmptyState
                        title={loading ? "Reading chain…" : "No open book yet"}
                        text={loading ? "Scanning registry markets for your wallet." : `No size/margin found for ${short(account)}. Open a trade, then come back.`}
                        action="Trade now"
                        onAction={onTrade}
                      />
                    </td>
                  </tr>
                ) : rows.map((r) => (
                  <tr key={r.market}>
                    <MarketNameCell symbol={r.symbol} label={r.label} market={r.market} />
                    <td>
                      <strong style={{
                        color: r.side === "long" ? "var(--pnl-up)" : r.side === "short" ? "var(--pnl-down)" : "var(--muted)",
                      }}
                      >
                        {r.side.toUpperCase()}
                      </strong>
                      {r.idleMargin ? (
                        <small style={{ display: "block", color: "var(--muted)" }}>closed · withdraw</small>
                      ) : null}
                    </td>
                    <td>
                      {r.idleMargin ? "—" : formatTokenAmt(Math.abs(r.size))}
                      <small style={{ display: "block", color: "var(--muted)" }}>{r.idleMargin ? "flat" : "tokens"}</small>
                    </td>
                    <td>
                      <strong>{r.idleMargin ? "—" : formatUsd(r.notional)}</strong>
                      <small style={{ display: "block", color: "var(--muted)" }}>{r.idleMargin ? "no size" : "mark value"}</small>
                    </td>
                    <td>{r.idleMargin ? "—" : formatUsd(r.entry, r.entry < 1 ? 6 : 2)}</td>
                    <td>{formatUsd(r.index, r.index < 1 ? 6 : 2)}</td>
                    <td style={{ color: r.uPnl >= 0 ? "var(--pnl-up)" : "var(--pnl-down)", fontWeight: 700 }}>
                      {r.idleMargin ? "—" : `${r.uPnl >= 0 ? "+" : ""}${formatUsd(r.uPnl)}`}
                      {!r.idleMargin ? (
                        <small style={{ display: "block", fontWeight: 500, color: "var(--muted)" }}>
                          price {r.priceMovePct >= 0 ? "+" : ""}{r.priceMovePct.toFixed(1)}%
                        </small>
                      ) : null}
                    </td>
                    <td style={{ color: (r.roe ?? 0) >= 0 ? "var(--pnl-up)" : "var(--pnl-down)", fontWeight: 700 }}>
                      {r.roe == null ? "—" : `${r.roe >= 0 ? "+" : ""}${r.roe.toFixed(1)}%`}
                    </td>
                    <td>{formatUsd(r.margin)}</td>
                    <td>{formatUsd(r.equity)}</td>
                    <td>{marketStates[r.state] ?? r.state}</td>
                    <td style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                      {r.idleMargin ? (
                        <button
                          className="button secondary sm"
                          type="button"
                          disabled={withdrawing === r.market}
                          onClick={() => void withdrawIdleMargin(r.market)}
                        >
                          {withdrawing === r.market ? "…" : "Withdraw"}
                        </button>
                      ) : null}
                      <button className="text-button" type="button" onClick={onTrade}>Trade</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </>
    )}
  </>;
}

type HistoryRow = {
  id: string;
  kind: "trade" | "deposit" | "withdraw";
  market: Address;
  symbol: string;
  label?: string;
  block: string;
  tx: `0x${string}`;
  detail: string;
  pnl?: number;
  price?: number;
  sizeDelta?: number;
};

function History({ account, onConnect, onTrade }: { account?: Address; onConnect(): void; onTrade(): void }) {
  const [rows, setRows] = useState<HistoryRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    if (!account) { setRows([]); return; }
    let cancelled = false;
    async function load() {
      setLoading(true);
      setErr("");
      try {
        const markets = await listRegistryMarkets();
        const latest = await publicClient.getBlockNumber();
        // Look back a large window on testnet; cap for RPC friendliness
        const fromBlock = latest > 200_000n ? latest - 200_000n : 0n;
        const collected: HistoryRow[] = [];
        // Prefer indexed projected trades when API is live (faster + full scan window).
        if (apiEnabled && account) {
          try {
            const projected = await apiGet<Array<{
              market_address: string;
              account_address: string;
              transaction_hash: string;
              log_index: number;
              block_number: string;
              size_delta_wad: string;
              new_size_wad: string;
              execution_price_wad: string;
              realized_pnl_wad: string;
            }>>("/v1/projections/trades?limit=100");
            const mine = (projected ?? []).filter(
              (r) => r.account_address?.toLowerCase() === account.toLowerCase(),
            );
            for (const row of mine) {
              if (!isAddress(row.market_address) || !row.transaction_hash) continue;
              const meta = await resolveMarketMeta(row.market_address as Address);
              const sizeDelta = Number(formatUnits(BigInt(row.size_delta_wad || "0"), 18));
              const price = Number(formatUnits(BigInt(row.execution_price_wad || "0"), 18));
              const pnl = Number(formatUnits(BigInt(row.realized_pnl_wad || "0"), 18));
              const newSize = Number(formatUnits(BigInt(row.new_size_wad || "0"), 18));
              collected.push({
                id: `proj-${row.transaction_hash}-${row.log_index}`,
                kind: "trade",
                market: row.market_address as Address,
                symbol: meta.symbol,
                label: meta.label,
                block: String(row.block_number),
                tx: row.transaction_hash as `0x${string}`,
                sizeDelta,
                price,
                pnl,
                detail: `${sizeDelta >= 0 ? "BUY" : "SELL"} ${Math.abs(sizeDelta).toLocaleString(undefined, { maximumFractionDigits: 4 })} @ $${price.toLocaleString(undefined, { maximumFractionDigits: 6 })} → size ${newSize.toLocaleString(undefined, { maximumFractionDigits: 4 })} · indexed`,
              });
            }
          } catch { /* fall through to RPC logs */ }
        }
        for (const market of markets) {
          try {
            const meta = await resolveMarketMeta(market);
            const [tradeLogs, depLogs, wdLogs] = await Promise.all([
              publicClient.getLogs({
                address: market,
                event: tradeHistoryEventAbi[0],
                args: { account },
                fromBlock,
                toBlock: latest,
              }),
              publicClient.getLogs({
                address: market,
                event: tradeHistoryEventAbi[1],
                args: { account },
                fromBlock,
                toBlock: latest,
              }),
              publicClient.getLogs({
                address: market,
                event: tradeHistoryEventAbi[2],
                args: { account },
                fromBlock,
                toBlock: latest,
              }),
            ]);
            for (const log of tradeLogs) {
              const tx = log.transactionHash as `0x${string}`;
              const id = `${tx}-${log.logIndex}`;
              if (collected.some((r) => r.id === id || r.id === `proj-${tx}-${log.logIndex}`)) continue;
              const block = log.blockNumber?.toString() ?? "?";
              const sizeDelta = Number(formatUnits(log.args.sizeDeltaBaseWad ?? 0n, 18));
              const price = Number(formatUnits(log.args.executionPriceWad ?? 0n, 18));
              const pnl = Number(formatUnits(log.args.realizedPnlWad ?? 0n, 18));
              const newSize = Number(formatUnits(log.args.newSizeBaseWad ?? 0n, 18));
              collected.push({
                id,
                kind: "trade",
                market,
                symbol: meta.symbol,
                label: meta.label,
                block,
                tx,
                sizeDelta,
                price,
                pnl,
                detail: `${sizeDelta >= 0 ? "BUY" : "SELL"} ${Math.abs(sizeDelta).toLocaleString(undefined, { maximumFractionDigits: 4 })} @ $${price.toLocaleString(undefined, { maximumFractionDigits: 6 })} → size ${newSize.toLocaleString(undefined, { maximumFractionDigits: 4 })}`,
              });
            }
            for (const log of depLogs) {
              const amt = Number(formatUnits(log.args.amountRaw ?? 0n, 6));
              collected.push({
                id: `${log.transactionHash}-${log.logIndex}`,
                kind: "deposit",
                market,
                symbol: meta.symbol,
                label: meta.label,
                block: log.blockNumber?.toString() ?? "?",
                tx: log.transactionHash as `0x${string}`,
                detail: `Margin +${amt.toLocaleString(undefined, { maximumFractionDigits: 2 })} apUSD`,
              });
            }
            for (const log of wdLogs) {
              const amt = Number(formatUnits(log.args.amountRaw ?? 0n, 6));
              collected.push({
                id: `${log.transactionHash}-${log.logIndex}`,
                kind: "withdraw",
                market,
                symbol: meta.symbol,
                label: meta.label,
                block: log.blockNumber?.toString() ?? "?",
                tx: log.transactionHash as `0x${string}`,
                detail: `Margin −${amt.toLocaleString(undefined, { maximumFractionDigits: 2 })} apUSD`,
              });
            }
          } catch { /* skip market log failures */ }
        }
        // newest first
        collected.sort((a, b) => Number(b.block) - Number(a.block));
        if (!cancelled) setRows(collected);
      } catch (cause) {
        if (!cancelled) setErr(cause instanceof Error ? cause.message : "Failed to load history");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    const t = setInterval(() => void load(), 15_000);
    return () => { cancelled = true; clearInterval(t); };
  }, [account]);

  return <>
    <PageHead eyebrow="Your paper trail" title="History" description="Trades and margin moves from on-chain events (last ~200k blocks on this RPC)." action={account ? <button className="button primary" type="button" onClick={onTrade}>Trade</button> : undefined} />
    {!account ? (
      <section className="panel"><EmptyState title="Connect to load history" text="We pull TradeExecuted and margin events for your address." action="Connect wallet" onAction={onConnect} /></section>
    ) : (
      <section className="panel table-panel">
        {err && <p className="form-error">{err}</p>}
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Type</th>
                <th>Detail</th>
                <th>Realized PnL</th>
                <th>Market</th>
                <th>Block</th>
                <th>Tx</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr className="empty-row">
                  <td colSpan={6}>
                    <EmptyState
                      title={loading ? "Scanning logs…" : "No events yet"}
                      text={loading ? "Reading TradeExecuted / margin events from known markets." : "Trade or deposit margin, then refresh — history is event-based."}
                      action="Trade now"
                      onAction={onTrade}
                    />
                  </td>
                </tr>
              ) : rows.map((r) => (
                <tr key={r.id}>
                  <td><strong>{r.kind.toUpperCase()}</strong></td>
                  <td>{r.detail}</td>
                  <td style={{ color: r.pnl == null ? undefined : r.pnl >= 0 ? "var(--pnl-up)" : "var(--pnl-down)", fontWeight: r.pnl == null ? undefined : 700 }}>
                    {r.pnl == null ? "—" : `${r.pnl >= 0 ? "+" : ""}${r.pnl.toLocaleString(undefined, { maximumFractionDigits: 4 })}`}
                  </td>
                  <MarketNameCell symbol={r.symbol} label={r.label} market={r.market} />
                  <td>{r.block}</td>
                  <td>
                    <a href={`${explorerBase}/tx/${r.tx}`} target="_blank" rel="noreferrer" className="mono">
                      {short(r.tx)}
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {loading && rows.length > 0 && <p className="section-copy">Refreshing…</p>}
      </section>
    )}
  </>;
}
function OfficialContracts() {
  const [copied, setCopied] = useState<string>("");
  async function copyAddr(addr: string) {
    try {
      await navigator.clipboard.writeText(addr);
      setCopied(addr);
      window.setTimeout(() => setCopied(""), 1500);
    } catch {
      /* ignore */
    }
  }
  return (
    <div className="contracts-page">
      <PageHead
        eyebrow="On-chain"
        title="Official contracts"
        description="Core AnyPerp addresses on Robinhood Chain testnet. Verify on explorer before you sign."
      />
      <div className="warning-banner">
        <strong>Testnet</strong>
        <span>apUSD is mintable play money — not real USDT. Unaudited prototype.</span>
      </div>
      <section className="panel table-panel">
        <div className="table-scroll">
          <table className="contracts-table">
            <thead>
              <tr>
                <th>Contract</th>
                <th>Role</th>
                <th>Address</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {OFFICIAL_CONTRACTS.filter((c) => c.address && isAddress(c.address)).map((c) => (
                <tr key={c.address + c.name}>
                  <td>
                    <strong>{c.name}</strong>
                    {c.mintable ? <span className="badge green" style={{ marginLeft: 8 }}>MINT</span> : null}
                  </td>
                  <td className="contracts-role">{c.role}</td>
                  <td>
                    <code className="mono contracts-addr">{c.address}</code>
                  </td>
                  <td className="contracts-actions">
                    <button type="button" className="button secondary sm" onClick={() => void copyAddr(c.address)}>
                      {copied === c.address ? "Copied" : "Copy"}
                    </button>
                    <a className="button secondary sm" href={`${explorerBase}/address/${c.address}`} target="_blank" rel="noreferrer">
                      Explorer ↗
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <p className="section-copy" style={{ marginTop: 12 }}>
        Source of truth: <code className="mono">deployments/ANYPERP-LATEST.md</code> · chain {appChain.id}
      </p>
    </div>
  );
}

function Governance() { return <><PageHead eyebrow="Slow by design" title="Governance" description="Risk tiers, adapters, fees, and upgrades wait on a timelock. No surprise parameter flips." /><div className="warning-banner"><strong>No governance token (yet)</strong><span>MVP runs on multisig + timelock. Token voting is out of scope for now.</span></div><section className="panel"><EmptyState title="No proposals live" text="They appear after governance contracts are deployed and indexed." /></section></>; }
function RiskDisclosure() { return <><PageHead eyebrow="Read this first" title="Risk disclosure" description="Isolated perps can still go insolvent - even with tight rails. Trade like that&apos;s true. We surface deferred claims and bad debt instead of faking solvency." /><div className="risk-disclosure-grid"><InfoCard title="Oracle &amp; spot games" text="Thin pools are easy to shove. Multi-source checks help a lot. They don&apos;t make risk zero. Demo uses mock adapters." /><InfoCard title="LP losses" text="The vault is the other side of your trade. Winning traders, gaps, and messy liquidations hurt LPs. Profit can become a deferred claim if free assets run out." /><InfoCard title="Liquidation lag" text="If sequencers, RPCs, keepers, or oracles stall, liquidations can arrive late - and equity can go red." /><InfoCard title="Stablecoin risk" text="USD collateral can depeg, freeze, or change. apUSD on testnet is mock mintable play money." /><InfoCard title="Admin trust" text="Guardians can restrict markets. Timelocked roles own adapters and params. Compromised keys are still a risk." /><InfoCard title="This is testnet software" text="Unaudited prototype. Green CI is not an audit. Don&apos;t put real money here. See docs/STATUS.md." /></div></>; }
function EmergencyConsole() { return <><PageHead eyebrow="Break glass only" title="Emergency console" description="Guardians can only cut risk: reduce-only or pause. They can&apos;t seize funds or raise limits." /><div className="danger-panel"><div><span className="badge red">NOT CONNECTED</span><h2>Guardian actions locked</h2><p>Connect an authorized testnet signer and wire up market addresses.</p></div><div className="emergency-actions"><button disabled>Set reduce-only</button><button disabled>Pause market</button></div></div><section className="panel runbook-list"><h2>Before you pull the lever</h2><ol><li>Log oracle health and sequencer status.</li><li>Note the market, block hash, and exposure.</li><li>Pick the lightest safe action that works.</li><li>Publish the reason hash and timeline.</li><li>Governance - not the guardian - reopens or settles.</li></ol></section></>; }

function Field({ label, value, setValue, placeholder, mono }: { label: string; value: string; setValue(value: string): void; placeholder: string; mono?: boolean }) { return <label className="field"><span>{label}</span><input className={mono ? "mono" : ""} value={value} onChange={(event) => setValue(event.target.value)} placeholder={placeholder} /></label>; }
function EmptyState({ title, text, action, onAction }: { title: string; text: string; action?: string; onAction?: () => void }) { return <div className="empty-state"><span className="empty-symbol">{"\u25CB"}</span><strong>{title}</strong><p>{text}</p>{action && <button className="text-button" onClick={onAction}>{action}</button>}</div>; }
function CheckRow({ pass, label }: { pass: boolean; label: string }) { return <div className={pass ? "check-row check-pass" : "check-row"}><span>{pass ? "\u2713" : "!"}</span>{label}</div>; }
function SourceCard({ title, status }: { title: string; status: string }) { return <div className="source-card"><span className="source-icon">S</span><strong>{title}</strong><small>{status}</small></div>; }
function InfoCard({ title, text }: { title: string; text: string }) { return <section className="info-card"><span /><h3>{title}</h3><p>{text}</p></section>; }
