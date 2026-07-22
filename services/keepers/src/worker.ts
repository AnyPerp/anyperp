import "dotenv/config";
import { Queue, Worker } from "bullmq";
import IORedis from "ioredis";
import pg from "pg";
import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  fallback,
  getAddress,
  http,
  isAddress,
  parseAbiItem,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { liquidationEngineAbi, resolveAppChain } from "../../../packages/sdk/src/index.js";
import {
  clampBlockLookback,
  mergeAddresses,
  recentOrderIdWindow,
  recentRequestIdWindow,
} from "./discovery.js";

const appChain = resolveAppChain();

const registryAbi = [
  { type: "function", name: "isMarket", stateMutability: "view", inputs: [{ name: "market", type: "address" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "count", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "at", stateMutability: "view", inputs: [{ name: "index", type: "uint256" }], outputs: [{ type: "address" }] },
] as const;
const fundingAbi = [{ type: "function", name: "updateFunding", stateMutability: "nonpayable", inputs: [], outputs: [] }] as const;
const marketStateAbi = [{ type: "function", name: "state", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] }] as const;
const marketEquityAbi = [
  { type: "function", name: "accountEquityWad", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ type: "int256" }] },
  { type: "function", name: "position", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{
    type: "tuple",
    components: [
      { name: "sizeBaseWad", type: "int256" },
      { name: "entryPriceWad", type: "uint256" },
      { name: "marginWad", type: "uint256" },
      { name: "fundingCheckpointWad", type: "int256" },
      { name: "lastModified", type: "uint256" },
    ],
  }] },
  { type: "function", name: "liquidityVault", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
] as const;
const triggerAbi = [
  { type: "function", name: "executeTriggerOrder", stateMutability: "nonpayable", inputs: [{ name: "orderId", type: "uint256" }], outputs: [] },
  { type: "function", name: "nextOrderId", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  {
    type: "function",
    name: "orders",
    stateMutability: "view",
    inputs: [{ name: "orderId", type: "uint256" }],
    outputs: [
      { name: "account", type: "address" },
      { name: "market", type: "address" },
      { name: "sizeDelta", type: "int256" },
      { name: "triggerPrice", type: "uint256" },
      { name: "acceptablePrice", type: "uint256" },
      { name: "deadline", type: "uint256" },
      { name: "executionFee", type: "uint256" },
      { name: "triggerType", type: "uint8" },
      { name: "active", type: "bool" },
    ],
  },
] as const;
const withdrawalAbi = [
  { type: "function", name: "executeWithdraw", stateMutability: "nonpayable", inputs: [{ name: "requestId", type: "uint256" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "nextRequestId", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  {
    type: "function",
    name: "withdrawalRequests",
    stateMutability: "view",
    inputs: [{ name: "requestId", type: "uint256" }],
    outputs: [
      { name: "owner", type: "address" },
      { name: "shares", type: "uint256" },
      { name: "executableAt", type: "uint256" },
      { name: "executed", type: "bool" },
    ],
  },
] as const;

/** Matches Market.TradeExecuted — indexed account only. */
const tradeExecutedEvent = parseAbiItem(
  "event TradeExecuted(address indexed account, int256 sizeDeltaBaseWad, int256 newSizeBaseWad, uint256 executionPriceWad, int256 realizedPnlWad, uint256 feeWad)",
);
const marginDepositedEvent = parseAbiItem(
  "event MarginDeposited(address indexed account, uint256 amountRaw, uint256 amountWad)",
);

const connection = new IORedis(process.env.REDIS_URL ?? "redis://localhost:6379", { maxRetriesPerRequest: null });
const queueName = "anyperp-keeper-jobs";
export const keeperQueue = new Queue(queueName, { connection });
const rpcUrls = (process.env.RPC_HTTP_URLS ?? process.env.RPC_HTTP_URL ?? "https://rpc.testnet.chain.robinhood.com")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const transport = fallback(rpcUrls.map((url) => http(url, { retryCount: 2, timeout: 10_000 })));
const publicClient = createPublicClient({ chain: appChain, transport });

const registry = process.env.MARKET_REGISTRY_ADDRESS;
const liquidationEngine = process.env.LIQUIDATION_ENGINE_ADDRESS;
const triggerManager = process.env.TRIGGER_ORDER_MANAGER_ADDRESS;
if (registry && !isAddress(registry)) throw new Error("Invalid MARKET_REGISTRY_ADDRESS");
if (liquidationEngine && !isAddress(liquidationEngine)) throw new Error("Invalid LIQUIDATION_ENGINE_ADDRESS");
if (triggerManager && !isAddress(triggerManager)) throw new Error("Invalid TRIGGER_ORDER_MANAGER_ADDRESS");

/** Optional seed accounts (demo traders). Merged with on-chain event discovery. */
const watchAccounts = (process.env.KEEPER_WATCH_ACCOUNTS ?? "")
  .split(",")
  .map((value) => value.trim())
  .filter((value): value is Address => isAddress(value));

function envBigInt(name: string, fallback: string): bigint {
  const raw = (process.env[name] ?? fallback).replace(/_/g, "").trim();
  if (!/^\d+$/.test(raw)) throw new Error(`Invalid integer env ${name}=${process.env[name]}`);
  return BigInt(raw);
}

const tradeLookbackBlocks = envBigInt("KEEPER_TRADE_LOOKBACK_BLOCKS", "8000");
const triggerLookback = envBigInt("KEEPER_TRIGGER_LOOKBACK", "200");
const withdrawalLookback = envBigInt("KEEPER_WITHDRAWAL_LOOKBACK", "100");
const logChunkSize = envBigInt("KEEPER_LOG_CHUNK_BLOCKS", "2000");

const privateKey = process.env.KEEPER_PRIVATE_KEY as `0x${string}` | undefined;
const wallet = privateKey
  ? createWalletClient({ account: privateKeyToAccount(privateKey), chain: appChain, transport })
  : null;

const chainId = Number(process.env.CHAIN_ID ?? appChain.id);
const pgPool = process.env.DATABASE_URL
  ? new pg.Pool({ connectionString: process.env.DATABASE_URL, application_name: "anyperp-keeper", max: 4 })
  : null;

/** Open accounts from indexer projections (preferred) when migration 002 is applied. */
async function loadProjectedAccounts(market: Address): Promise<Address[]> {
  if (!pgPool) return [];
  try {
    const result = await pgPool.query<{ account_address: string }>(
      `select account_address from projected_open_accounts
       where chain_id = $1 and lower(market_address) = lower($2) and open = true
       limit 5000`,
      [chainId, market],
    );
    return result.rows
      .map((row) => row.account_address)
      .filter((value): value is Address => isAddress(value))
      .map((a) => getAddress(a));
  } catch {
    // Table missing or DB down — fall back to logs/watchlist only.
    return [];
  }
}

async function requireRegisteredMarket(market: unknown): Promise<Address> {
  if (!registry || !isAddress(String(market))) throw new Error("market or registry is not configured");
  const address = market as Address;
  const registered = await publicClient.readContract({
    address: registry as Address,
    abi: registryAbi,
    functionName: "isMarket",
    args: [address],
  });
  if (!registered) throw new Error("market is not registered");
  return address;
}

async function listActiveMarkets(): Promise<Address[]> {
  if (!registry) return [];
  const count = await publicClient.readContract({ address: registry as Address, abi: registryAbi, functionName: "count" });
  const markets: Address[] = [];
  for (let index = 0n; index < count; index += 1n) {
    const market = await publicClient.readContract({
      address: registry as Address,
      abi: registryAbi,
      functionName: "at",
      args: [index],
    });
    const state = await publicClient.readContract({ address: market, abi: marketStateAbi, functionName: "state" });
    // Active (3) or ReduceOnly (4)
    if (state === 3 || state === 4) markets.push(market);
  }
  return markets;
}

/**
 * Discover accounts that recently traded or deposited margin by reading market logs.
 * Not a full historical position index — honest about lookback — but no longer watchlist-only.
 */
async function discoverRecentAccounts(market: Address): Promise<Address[]> {
  const head = await publicClient.getBlockNumber();
  const fromBlock = clampBlockLookback(head, tradeLookbackBlocks);
  const found: string[] = [];
  for (let start = fromBlock; start <= head; start += logChunkSize) {
    const end = start + logChunkSize - 1n > head ? head : start + logChunkSize - 1n;
    try {
      const [trades, margins] = await Promise.all([
        publicClient.getLogs({ address: market, event: tradeExecutedEvent, fromBlock: start, toBlock: end }),
        publicClient.getLogs({ address: market, event: marginDepositedEvent, fromBlock: start, toBlock: end }),
      ]);
      for (const log of trades) {
        if (log.args.account) found.push(log.args.account);
      }
      for (const log of margins) {
        if (log.args.account) found.push(log.args.account);
      }
    } catch (error) {
      console.error("account discovery chunk failed", market, start.toString(), end.toString(), error);
    }
  }
  return mergeAddresses(found).filter((value): value is Address => isAddress(value)).map((a) => getAddress(a));
}

async function buildTransaction(name: string, data: Record<string, unknown>): Promise<{ to: Address; calldata: Hex }> {
  if (name === "funding") {
    const market = await requireRegisteredMarket(data.market);
    return { to: market, calldata: encodeFunctionData({ abi: fundingAbi, functionName: "updateFunding" }) };
  }
  if (name === "liquidation") {
    const market = await requireRegisteredMarket(data.market);
    if (!liquidationEngine || !isAddress(String(data.account))) throw new Error("liquidation configuration invalid");
    const maxClose = BigInt(String(data.maxCloseNotionalWad ?? "1000000000000000000000000"));
    return {
      to: liquidationEngine as Address,
      calldata: encodeFunctionData({
        abi: liquidationEngineAbi,
        functionName: "liquidate",
        args: [market, data.account as Address, maxClose],
      }),
    };
  }
  if (name === "trigger_order") {
    if (!triggerManager) throw new Error("trigger manager is not configured");
    return {
      to: triggerManager as Address,
      calldata: encodeFunctionData({
        abi: triggerAbi,
        functionName: "executeTriggerOrder",
        args: [BigInt(String(data.orderId))],
      }),
    };
  }
  if (name === "withdrawal") {
    if (!isAddress(String(data.vault))) throw new Error("invalid vault");
    const market = await requireRegisteredMarket(data.market);
    const vault = await publicClient.readContract({
      address: market,
      abi: marketEquityAbi,
      functionName: "liquidityVault",
    });
    if (vault.toLowerCase() !== String(data.vault).toLowerCase()) throw new Error("vault does not belong to market");
    return {
      to: vault,
      calldata: encodeFunctionData({
        abi: withdrawalAbi,
        functionName: "executeWithdraw",
        args: [BigInt(String(data.requestId))],
      }),
    };
  }
  throw new Error(`unsupported job ${name}`);
}

new Worker(
  queueName,
  async (job) => {
    if (job.name === "health") {
      return {
        chainId: await publicClient.getChainId(),
        block: (await publicClient.getBlockNumber()).toString(),
        watchAccounts: watchAccounts.length,
        tradeLookbackBlocks: tradeLookbackBlocks.toString(),
        scanners: ["funding", "liquidation", "trigger", "withdrawal"],
      };
    }
    if (!wallet) throw new Error("KEEPER_PRIVATE_KEY is unset; transaction jobs are intentionally disabled");
    const transaction = await buildTransaction(job.name, job.data as Record<string, unknown>);
    await publicClient.call({ account: wallet.account, to: transaction.to, data: transaction.calldata });
    const hash = await wallet.sendTransaction({
      to: transaction.to,
      data: transaction.calldata,
      account: wallet.account,
      chain: appChain,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 1 });
    if (receipt.status !== "success") throw new Error(`keeper transaction reverted: ${hash}`);
    return { transactionHash: hash, blockNumber: receipt.blockNumber.toString() };
  },
  { connection, concurrency: 1, lockDuration: 60_000 },
);

await keeperQueue.add(
  "health",
  {},
  { jobId: `health-${Math.floor(Date.now() / 60_000)}`, removeOnComplete: 100, attempts: 3 },
);

async function scheduleFunding() {
  const markets = await listActiveMarkets();
  const bucket = Math.floor(Date.now() / 60_000);
  for (const market of markets) {
    await keeperQueue.add(
      "funding",
      { market },
      {
        jobId: `funding-${market.toLowerCase()}-${bucket}`,
        attempts: 3,
        backoff: { type: "exponential", delay: 2_000 },
        removeOnComplete: 500,
      },
    );
  }
}

/**
 * Liquidation scanner (priority order):
 * 1) projected_open_accounts (indexer migration 002)
 * 2) recent TradeExecuted / MarginDeposited logs
 * 3) optional KEEPER_WATCH_ACCOUNTS seed
 * Engine still enforces maintenance margin on-chain.
 */
async function scheduleLiquidations() {
  if (!liquidationEngine) return;
  const markets = await listActiveMarkets();
  const bucket = Math.floor(Date.now() / 60_000);
  for (const market of markets) {
    let projected: Address[] = [];
    let discovered: Address[] = [];
    try {
      projected = await loadProjectedAccounts(market);
    } catch (error) {
      console.error("projection load failed", market, error);
    }
    try {
      discovered = await discoverRecentAccounts(market);
    } catch (error) {
      console.error("account discovery failed", market, error);
    }
    const accounts = mergeAddresses(projected, watchAccounts, discovered)
      .filter((value): value is Address => isAddress(value))
      .map((a) => getAddress(a));
    if (accounts.length === 0) continue;

    for (const account of accounts) {
      try {
        const position = await publicClient.readContract({
          address: market,
          abi: marketEquityAbi,
          functionName: "position",
          args: [account],
        });
        if (position.sizeBaseWad === 0n) continue;
        const equity = await publicClient.readContract({
          address: market,
          abi: marketEquityAbi,
          functionName: "accountEquityWad",
          args: [account],
        });
        // Queue when equity is non-positive or thin vs margin; engine enforces maintenance.
        if (equity > 0n && equity > position.marginWad / 20n) continue;
        await keeperQueue.add(
          "liquidation",
          { market, account, maxCloseNotionalWad: "1000000000000000000000000" },
          {
            jobId: `liq-${market.toLowerCase()}-${account.toLowerCase()}-${bucket}`,
            attempts: 2,
            backoff: { type: "exponential", delay: 3_000 },
            removeOnComplete: 200,
          },
        );
      } catch (error) {
        console.error("liquidation probe failed", market, account, error);
      }
    }
  }
}

/** Scan recent trigger order IDs and queue when still active and not expired. */
async function scheduleTriggers() {
  if (!triggerManager) return;
  try {
    const nextId = await publicClient.readContract({
      address: triggerManager as Address,
      abi: triggerAbi,
      functionName: "nextOrderId",
    });
    const bucket = Math.floor(Date.now() / 30_000);
    const { start, endExclusive } = recentOrderIdWindow(nextId, triggerLookback);
    for (let orderId = start; orderId < endExclusive; orderId += 1n) {
      const order = await publicClient.readContract({
        address: triggerManager as Address,
        abi: triggerAbi,
        functionName: "orders",
        args: [orderId],
      });
      if (!order.active) continue;
      if (order.deadline < BigInt(Math.floor(Date.now() / 1000))) continue;
      await keeperQueue.add(
        "trigger_order",
        { orderId: orderId.toString() },
        {
          jobId: `trigger-${orderId.toString()}-${bucket}`,
          attempts: 2,
          backoff: { type: "exponential", delay: 2_000 },
          removeOnComplete: 200,
        },
      );
    }
  } catch (error) {
    console.error("trigger scan failed", error);
  }
}

/** Scan matured LP withdrawal requests per active market vault. */
async function scheduleWithdrawals() {
  const markets = await listActiveMarkets();
  const bucket = Math.floor(Date.now() / 60_000);
  const now = BigInt(Math.floor(Date.now() / 1000));
  for (const market of markets) {
    try {
      const vault = await publicClient.readContract({
        address: market,
        abi: marketEquityAbi,
        functionName: "liquidityVault",
      });
      const nextId = await publicClient.readContract({
        address: vault,
        abi: withdrawalAbi,
        functionName: "nextRequestId",
      });
      const { start, endExclusive } = recentRequestIdWindow(nextId, withdrawalLookback);
      for (let requestId = start; requestId < endExclusive; requestId += 1n) {
        const request = await publicClient.readContract({
          address: vault,
          abi: withdrawalAbi,
          functionName: "withdrawalRequests",
          args: [requestId],
        });
        if (request.owner === "0x0000000000000000000000000000000000000000") continue;
        if (request.executed) continue;
        if (request.executableAt > now) continue;
        await keeperQueue.add(
          "withdrawal",
          { market, vault, requestId: requestId.toString() },
          {
            jobId: `wd-${vault.toLowerCase()}-${requestId.toString()}-${bucket}`,
            attempts: 2,
            backoff: { type: "exponential", delay: 3_000 },
            removeOnComplete: 200,
          },
        );
      }
    } catch (error) {
      console.error("withdrawal scan failed", market, error);
    }
  }
}

async function runScanners() {
  await scheduleFunding().catch((error) => console.error("funding scan failed", error));
  await scheduleLiquidations().catch((error) => console.error("liquidation scan failed", error));
  await scheduleTriggers().catch((error) => console.error("trigger scan failed", error));
  await scheduleWithdrawals().catch((error) => console.error("withdrawal scan failed", error));
}

await runScanners();
setInterval(() => void runScanners(), 60_000).unref();

console.log(
  JSON.stringify({
    service: "anyperp-keeper",
    signing: Boolean(wallet),
    registry: registry ?? null,
    watchAccounts: watchAccounts.length,
    tradeLookbackBlocks: tradeLookbackBlocks.toString(),
    database: Boolean(pgPool),
    scanners: ["funding", "liquidation", "trigger", "withdrawal"],
    discovery: "projected_open_accounts + TradeExecuted/MarginDeposited logs + KEEPER_WATCH_ACCOUNTS",
  }),
);
