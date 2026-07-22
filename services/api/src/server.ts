import Fastify from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  http,
  isAddress,
  parseUnits,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { z } from "zod";
import {
  liquidationEngineAbi,
  marketAbi,
  marketFactoryAbi,
  resolveAppChain,
  triggerOrderManagerAbi,
} from "../../../packages/sdk/src/index.js";
import { config } from "./config.js";
import { pool, query } from "./db.js";
import {
  PYTH_FEED_PRESETS,
  bestPairForToken,
  fetchHermesPrices,
  fetchLatestTokenProfiles,
  resolveFeedIds,
  searchPairs,
  searchPriceFeeds,
  tokenPairs,
  tokensByAddresses,
} from "./market-data/index.js";

const appChain = resolveAppChain({ chainId: config.CHAIN_ID, rpcUrl: config.RPC_HTTP_URL });
const app = Fastify({ logger: { level: config.LOG_LEVEL } });

const mockOracleSetAbi = [
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

function resolveOraclePusherKey(): Hex | null {
  const raw =
    config.ORACLE_PUSHER_PRIVATE_KEY ||
    config.KEEPER_PRIVATE_KEY ||
    config.DEPLOYER_PRIVATE_KEY;
  if (!raw?.startsWith("0x") || raw.length < 66) return null;
  return raw as Hex;
}

/** Testnet mock adapters (same defaults as app/page.tsx) when env not set. */
const DEFAULT_TESTNET_ORACLE_ADAPTERS =
  "0x957ce5792080b0aaf97632cc78c976905fe17962,0x5d669814ca06142581bcea83f51f794d0fd1eafb";

function resolveOracleAdapters(): Address[] {
  const raw =
    config.ORACLE_ADAPTERS ||
    config.NEXT_PUBLIC_ORACLE_ADAPTERS ||
    DEFAULT_TESTNET_ORACLE_ADAPTERS;
  return raw
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter((s): s is Address => isAddress(s));
}

async function fetchDexPriceUsd(sourceCa: string): Promise<{ price: number; liquidityUsd: number }> {
  const urls = [
    `${config.DEXSCREENER_BASE_URL}/token-pairs/v1/robinhood/${sourceCa}`,
    `${config.DEXSCREENER_BASE_URL}/latest/dex/tokens/${sourceCa}`,
  ];
  for (const url of urls) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(12_000) });
      if (!res.ok) continue;
      const body = await res.json();
      const pairs = Array.isArray(body) ? body : body?.pairs;
      const list = Array.isArray(pairs) ? pairs : [];
      const best = list
        .map((p: { priceUsd?: string; liquidity?: { usd?: number } }) => ({
          price: Number(p.priceUsd),
          liquidityUsd: Number(p.liquidity?.usd || 0),
        }))
        .filter((p: { price: number }) => p.price > 0)
        .sort((a: { liquidityUsd: number }, b: { liquidityUsd: number }) => b.liquidityUsd - a.liquidityUsd)[0];
      if (best) return best;
    } catch {
      /* try next */
    }
  }
  throw new Error("dex_price_unavailable");
}
app.setErrorHandler((error, _request, reply) => {
  if (error instanceof z.ZodError) return reply.code(400).send({ error: "invalid_request", issues: error.issues });
  app.log.error(error);
  return reply.code(500).send({ error: "internal_error" });
});
const allowedOrigins = config.CORS_ORIGINS.split(",").map((value) => value.trim()).filter(Boolean);
await app.register(cors, { origin: allowedOrigins });
await app.register(websocket);
const rpc = createPublicClient({ chain: appChain, transport: http(config.RPC_HTTP_URL) });
const registryAbi = [{ type: "function", name: "isMarket", stateMutability: "view", inputs: [{ name: "market", type: "address" }], outputs: [{ type: "bool" }] }] as const;

/** In-memory fixed-window rate limiter (single-process testnet API). Not a substitute for edge WAF. */
const rateBuckets = new Map<string, { count: number; resetAt: number }>();
function rateLimitHit(ip: string): { limited: boolean; remaining: number; resetAt: number } {
  const now = Date.now();
  const windowMs = config.API_RATE_LIMIT_WINDOW_MS;
  const max = config.API_RATE_LIMIT_MAX;
  let bucket = rateBuckets.get(ip);
  if (!bucket || now >= bucket.resetAt) {
    bucket = { count: 0, resetAt: now + windowMs };
    rateBuckets.set(ip, bucket);
  }
  bucket.count += 1;
  return { limited: bucket.count > max, remaining: Math.max(0, max - bucket.count), resetAt: bucket.resetAt };
}

app.addHook("onRequest", async (request, reply) => {
  const path = request.url.split("?")[0] ?? "";
  if (path === "/health/live" || path === "/health/ready" || path === "/metrics") return;
  const ip = request.ip || request.headers["x-forwarded-for"]?.toString().split(",")[0]?.trim() || "unknown";
  const result = rateLimitHit(ip);
  reply.header("x-ratelimit-limit", String(config.API_RATE_LIMIT_MAX));
  reply.header("x-ratelimit-remaining", String(result.remaining));
  reply.header("x-ratelimit-reset", String(Math.ceil(result.resetAt / 1000)));
  if (result.limited) {
    return reply.code(429).send({ error: "rate_limited", retryAfterMs: result.resetAt - Date.now() });
  }
});

function marketDataError(reply: { code: (n: number) => { send: (b: unknown) => unknown } }, error: unknown) {
  const message = error instanceof Error ? error.message : "market_data_error";
  return reply.code(502).send({ error: "upstream_error", message });
}

async function isRegisteredMarket(market: `0x${string}`) {
  if (!config.MARKET_REGISTRY_ADDRESS) return true;
  return rpc.readContract({ address: config.MARKET_REGISTRY_ADDRESS as `0x${string}`, abi: registryAbi, functionName: "isMarket", args: [market] });
}

app.get("/health/live", async () => ({ status: "ok", service: "anyperp-api" }));
app.get("/health/ready", async (_request, reply) => {
  try {
    const [chainId] = await Promise.all([rpc.getChainId(), pool.query("select 1")]);
    return { status: "ready", chainId, database: "reachable" };
  } catch (error) {
    return reply.code(503).send({ status: "not_ready", reason: error instanceof Error ? error.message : "unknown" });
  }
});

/** Honest testnet ops snapshot — what is configured, not marketing claims. */
app.get("/v1/ops/status", async () => {
  let chainId: number | null = null;
  let blockNumber: string | null = null;
  let rpcOk = false;
  let dbOk = false;
  try {
    chainId = await rpc.getChainId();
    blockNumber = (await rpc.getBlockNumber()).toString();
    rpcOk = true;
  } catch {
    rpcOk = false;
  }
  try {
    await pool.query("select 1");
    dbOk = true;
  } catch {
    dbOk = false;
  }
  return {
    service: "anyperp-api",
    networkMode: process.env.NETWORK_MODE ?? process.env.NEXT_PUBLIC_NETWORK_MODE ?? "testnet",
    chainId: chainId ?? config.CHAIN_ID,
    blockNumber,
    rpcOk,
    databaseOk: dbOk,
    registryConfigured: Boolean(config.MARKET_REGISTRY_ADDRESS),
    factoryConfigured: Boolean(config.MARKET_FACTORY_ADDRESS),
    liquidationEngineConfigured: Boolean(config.LIQUIDATION_ENGINE_ADDRESS),
    triggerManagerConfigured: Boolean(config.TRIGGER_ORDER_MANAGER_ADDRESS),
    rateLimit: { max: config.API_RATE_LIMIT_MAX, windowMs: config.API_RATE_LIMIT_WINDOW_MS },
    projections: await (async () => {
      try {
        const [m, a, t] = await Promise.all([
          pool.query("select count(*)::int as c from projected_markets where chain_id=$1", [config.CHAIN_ID]),
          pool.query("select count(*)::int as c from projected_open_accounts where chain_id=$1 and open=true", [config.CHAIN_ID]),
          pool.query("select count(*)::int as c from projected_trades where chain_id=$1 and canonical=true", [config.CHAIN_ID]),
        ]);
        return {
          available: true,
          markets: m.rows[0]?.c ?? 0,
          openAccounts: a.rows[0]?.c ?? 0,
          trades: t.rows[0]?.c ?? 0,
        };
      } catch {
        return { available: false, hint: "Apply database/migrations/002_projections.sql" };
      }
    })(),
    honesty: {
      audit: "none",
      realFunds: false,
      oracle: "testnet may use mock adapters / Pyth bridge — not multi-venue production",
      collateral: "testnet may use mintable apUSD — not USD",
    },
  };
});

app.get("/metrics", async (_request, reply) => {
  const memory = process.memoryUsage();
  reply.type("text/plain; version=0.0.4; charset=utf-8");
  return [
    "# HELP anyperp_api_up Whether the API process is serving requests.",
    "# TYPE anyperp_api_up gauge",
    "anyperp_api_up 1",
    "# HELP anyperp_api_process_uptime_seconds API process uptime.",
    "# TYPE anyperp_api_process_uptime_seconds gauge",
    `anyperp_api_process_uptime_seconds ${process.uptime()}`,
    "# HELP anyperp_api_heap_used_bytes Node.js heap currently used.",
    "# TYPE anyperp_api_heap_used_bytes gauge",
    `anyperp_api_heap_used_bytes ${memory.heapUsed}`,
    "",
  ].join("\n");
});

app.get("/v1/chains", async () => query("select chain_id, name, explorer_url, native_symbol, enabled from chains where deleted_at is null order by chain_id"));
app.get("/v1/tokens", async (request) => {
  const parsed = z.object({ search: z.string().max(64).optional(), limit: z.coerce.number().int().min(1).max(100).default(50) }).parse(request.query);
  return query(
    `select id, chain_id, address, name, symbol, decimals, token_type, metadata_status
     from tokens where deleted_at is null and ($1::text is null or symbol ilike '%' || $1 || '%' or address ilike '%' || $1 || '%')
     order by first_seen_block desc limit $2`,
    [parsed.search ?? null, parsed.limit],
  );
});

app.get("/v1/tokens/:address/eligibility", async (request, reply) => {
  const { address } = z.object({ address: z.string() }).parse(request.params);
  if (!isAddress(address)) return reply.code(400).send({ eligible: false, blockers: ["invalid_address"] });
  const rows = await query<{ decimals: number; token_type: string; behavior_flags: Record<string, boolean> }>(
    "select decimals, token_type, behavior_flags from tokens where chain_id=$1 and lower(address)=lower($2) and deleted_at is null",
    [config.CHAIN_ID, address],
  );
  if (!rows[0]) return { eligible: false, state: "unknown", blockers: ["token_not_indexed", "oracle_route_unverified"] };
  const blockers = Object.entries(rows[0].behavior_flags ?? {}).filter(([, value]) => value).map(([key]) => key);
  if (rows[0].token_type === "stock_token") blockers.push("rwa_excluded_from_mvp");
  return { eligible: blockers.length === 0, state: blockers.length ? "rejected" : "pending_oracle_validation", blockers };
});

app.get("/v1/markets", async (request) => {
  const parsed = z.object({ status: z.string().optional(), limit: z.coerce.number().int().min(1).max(100).default(50) }).parse(request.query);
  try {
    const full = await query(
      `select m.id, m.market_key, m.contract_address, m.status, m.tier, m.created_at,
              b.symbol base_symbol, c.symbol collateral_symbol, lv.total_assets, lv.reserved_assets
       from markets m join tokens b on b.id=m.base_token_id join tokens c on c.id=m.collateral_token_id
       left join liquidity_vaults lv on lv.market_id=m.id
       where m.deleted_at is null and ($1::market_status is null or m.status=$1) order by m.created_at desc limit $2`,
      [parsed.status ?? null, parsed.limit],
    );
    if (full.length > 0) return full;
  } catch {
    // Full schema empty or query failed — fall through to projections.
  }
  try {
    return await query(
      `select market_address as contract_address, market_id_bytes32 as market_key,
              creator_address, first_seen_block, last_event_block, updated_at,
              'projected' as source
       from projected_markets
       where chain_id = $1
       order by last_event_block desc
       limit $2`,
      [config.CHAIN_ID, parsed.limit],
    );
  } catch {
    return [];
  }
});

/** Lightweight indexer projections (migration 002). Empty array if tables not applied yet. */
app.get("/v1/projections/markets", async (request) => {
  const parsed = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }).parse(request.query);
  try {
    return await query(
      `select market_address, market_id_bytes32, creator_address, first_seen_block, last_event_block, updated_at
       from projected_markets where chain_id=$1 order by last_event_block desc limit $2`,
      [config.CHAIN_ID, parsed.limit],
    );
  } catch {
    return [];
  }
});

app.get("/v1/projections/open-accounts", async (request, reply) => {
  const parsed = z.object({
    market: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(500).default(100),
  }).parse(request.query);
  if (parsed.market && !isAddress(parsed.market)) return reply.code(400).send({ error: "invalid_market" });
  try {
    return await query(
      `select market_address, account_address, last_size_base_wad, last_trade_block, last_trade_tx, open, updated_at
       from projected_open_accounts
       where chain_id=$1 and open=true
         and ($2::text is null or lower(market_address)=lower($2))
       order by last_trade_block desc
       limit $3`,
      [config.CHAIN_ID, parsed.market ?? null, parsed.limit],
    );
  } catch {
    return []; // migration 002 not applied yet
  }
});

app.get("/v1/projections/trades", async (request, reply) => {
  const parsed = z.object({
    market: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  }).parse(request.query);
  if (parsed.market && !isAddress(parsed.market)) return reply.code(400).send({ error: "invalid_market" });
  try {
    return await query(
      `select market_address, account_address, transaction_hash, log_index, block_number,
              size_delta_wad, new_size_wad, execution_price_wad, realized_pnl_wad, fee_wad, occurred_at
       from projected_trades
       where chain_id=$1 and canonical=true
         and ($2::text is null or lower(market_address)=lower($2))
       order by block_number desc, log_index desc
       limit $3`,
      [config.CHAIN_ID, parsed.market ?? null, parsed.limit],
    );
  } catch {
    return []; // migration 002 not applied yet
  }
});

app.get("/v1/markets/:marketId", async (request, reply) => {
  const { marketId } = z.object({ marketId: z.string().uuid() }).parse(request.params);
  const rows = await query("select * from markets where id=$1 and deleted_at is null", [marketId]);
  return rows[0] ?? reply.code(404).send({ error: "market_not_found" });
});

app.get("/v1/markets/:marketId/oracle", async (request) => {
  const { marketId } = z.object({ marketId: z.string().uuid() }).parse(request.params);
  return query(
    `select op.price, op.confidence_bps, op.liquidity_value, op.source_timestamp, op.block_number,
            op.block_hash, op.confirmation, os.adapter_address, os.source_type, os.source_address
     from oracle_prices op
     join oracle_sources os on os.id=op.source_id and os.chain_id=op.chain_id and os.enabled=true
     join markets m on m.base_token_id=op.token_id and m.chain_id=op.chain_id
     where m.id=$1 and op.confirmation <> 'orphaned'
     order by op.block_number desc limit 20`, [marketId],
  );
});

app.get("/v1/markets/:marketId/risk", async (request) => {
  const { marketId } = z.object({ marketId: z.string().uuid() }).parse(request.params);
  return (await query("select * from market_parameters where market_id=$1 order by effective_block desc limit 1", [marketId]))[0] ?? null;
});

app.post("/v1/markets/prepare", async (request, reply) => {
  const body = z.object({ factory: z.string(), params: z.unknown() }).parse(request.body);
  if (!isAddress(body.factory)) return reply.code(400).send({ error: "invalid_factory" });
  if (config.MARKET_FACTORY_ADDRESS && body.factory.toLowerCase() !== config.MARKET_FACTORY_ADDRESS.toLowerCase()) {
    return reply.code(400).send({ error: "unregistered_factory" });
  }
  try {
    const data = encodeFunctionData({ abi: marketFactoryAbi, functionName: "createMarket", args: [body.params as never] });
    return { chainId: config.CHAIN_ID, to: body.factory, data, value: "0", warning: "Simulate this calldata against the latest block immediately before signing." };
  } catch (error) {
    return reply.code(400).send({ error: "invalid_market_parameters", detail: error instanceof Error ? error.message : "unknown" });
  }
});

app.post("/v1/orders/prepare", async (request, reply) => {
  const body = z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("market"), market: z.string(), sizeDeltaWad: z.string().regex(/^-?[0-9]+$/),
      acceptablePriceWad: z.string().regex(/^[0-9]+$/), deadline: z.coerce.number().int().positive(),
      from: z.string().optional(),
    }),
    z.object({
      kind: z.literal("trigger"), manager: z.string(), market: z.string(),
      sizeDeltaWad: z.string().regex(/^-?[0-9]+$/), triggerPriceWad: z.string().regex(/^[0-9]+$/),
      acceptablePriceWad: z.string().regex(/^[0-9]+$/), deadline: z.coerce.number().int().positive(),
      triggerType: z.coerce.number().int().min(0).max(1), executionFeeWei: z.string().regex(/^[0-9]+$/),
      from: z.string().optional(),
    }),
  ]).parse(request.body);
  if (!isAddress(body.market)) return reply.code(400).send({ error: "invalid_market" });
  if (!(await isRegisteredMarket(body.market))) return reply.code(400).send({ error: "unregistered_market" });
  const now = Math.floor(Date.now() / 1000);
  if (body.deadline <= now || body.deadline > now + 30 * 24 * 60 * 60) return reply.code(400).send({ error: "invalid_deadline" });
  try {
    if (body.kind === "market") {
      const data = encodeFunctionData({
        abi: marketAbi, functionName: "executeTrade",
        args: [BigInt(body.sizeDeltaWad), BigInt(body.acceptablePriceWad), BigInt(body.deadline)],
      });
      let simulation: { ok: boolean; blockNumber?: string; error?: string } | undefined;
      if (body.from && isAddress(body.from)) {
        try {
          await rpc.call({
            account: body.from as `0x${string}`,
            to: body.market as `0x${string}`,
            data: data as `0x${string}`,
          });
          simulation = { ok: true, blockNumber: (await rpc.getBlockNumber()).toString() };
        } catch (error) {
          simulation = {
            ok: false,
            blockNumber: (await rpc.getBlockNumber().catch(() => null))?.toString(),
            error: error instanceof Error ? error.message : "simulation_failed",
          };
        }
      }
      return {
        chainId: config.CHAIN_ID,
        to: body.market,
        data,
        value: "0",
        schemaVersion: 1,
        simulation: simulation ?? { ok: null, note: "Pass `from` to eth_call simulate before signing." },
        warning: "Re-simulate in the wallet against the latest block immediately before signing.",
      };
    }
    if (!isAddress(body.manager)) return reply.code(400).send({ error: "invalid_trigger_manager" });
    if (config.TRIGGER_ORDER_MANAGER_ADDRESS && body.manager.toLowerCase() !== config.TRIGGER_ORDER_MANAGER_ADDRESS.toLowerCase()) {
      return reply.code(400).send({ error: "unregistered_trigger_manager" });
    }
    const data = encodeFunctionData({
      abi: triggerOrderManagerAbi, functionName: "placeTriggerOrder",
      args: [body.market, BigInt(body.sizeDeltaWad), BigInt(body.triggerPriceWad), BigInt(body.acceptablePriceWad), BigInt(body.deadline), body.triggerType],
    });
    return { chainId: config.CHAIN_ID, to: body.manager, data, value: body.executionFeeWei, schemaVersion: 1 };
  } catch (error) {
    return reply.code(400).send({ error: "invalid_order", detail: error instanceof Error ? error.message : "unknown" });
  }
});

app.post("/v1/liquidations/:account/prepare", async (request, reply) => {
  const { account } = z.object({ account: z.string() }).parse(request.params);
  const body = z.object({
    engine: z.string(), market: z.string(), maxCloseNotionalWad: z.string().regex(/^[0-9]+$/),
  }).parse(request.body);
  if (!isAddress(account) || !isAddress(body.engine) || !isAddress(body.market)) {
    return reply.code(400).send({ error: "invalid_address" });
  }
  if (!(await isRegisteredMarket(body.market))) return reply.code(400).send({ error: "unregistered_market" });
  if (config.LIQUIDATION_ENGINE_ADDRESS && body.engine.toLowerCase() !== config.LIQUIDATION_ENGINE_ADDRESS.toLowerCase()) {
    return reply.code(400).send({ error: "unregistered_liquidation_engine" });
  }
  const data = encodeFunctionData({
    abi: liquidationEngineAbi, functionName: "liquidate",
    args: [body.market, account, BigInt(body.maxCloseNotionalWad)],
  });
  return { chainId: config.CHAIN_ID, to: body.engine, data, value: "0", schemaVersion: 1 };
});

app.get("/v1/accounts/:address/portfolio", async (request, reply) => {
  const { address } = z.object({ address: z.string() }).parse(request.params);
  if (!isAddress(address)) return reply.code(400).send({ error: "invalid_address" });
  return query(
    `select p.*, m.market_key, m.status from positions p join wallets w on w.id=p.wallet_id join markets m on m.id=p.market_id
     where lower(w.address)=lower($1) order by p.updated_at desc`, [address],
  );
});

app.get("/v1/accounts/:address/orders", async (request) => {
  const { address } = z.object({ address: z.string() }).parse(request.params);
  return query("select o.* from orders o join wallets w on w.id=o.wallet_id where lower(w.address)=lower($1) and o.deleted_at is null order by o.created_at desc", [address]);
});

app.get("/v1/accounts/:address/transactions", async (request) => {
  const { address } = z.object({ address: z.string() }).parse(request.params);
  return query("select * from transactions where chain_id=$1 and (lower(from_address)=lower($2) or lower(to_address)=lower($2)) order by first_seen_at desc limit 100", [config.CHAIN_ID, address]);
});

app.get("/v1/transactions/:hash", async (request, reply) => {
  const { hash } = z.object({ hash: z.string().regex(/^0x[0-9a-fA-F]{64}$/) }).parse(request.params);
  const rows = await query("select * from transactions where chain_id=$1 and hash=$2", [config.CHAIN_ID, hash]);
  return rows[0] ?? reply.code(404).send({ error: "transaction_not_found" });
});

// ── Market data: DexScreener (reference MC/vol) + Pyth Hermes (index prices) ──

app.get("/v1/market-data/health", async () => ({
  dexscreener: { baseUrl: config.DEXSCREENER_BASE_URL, defaultChain: config.DEXSCREENER_DEFAULT_CHAIN },
  pyth: {
    hermesUrl: config.PYTH_HERMES_URL,
    apiKeyConfigured: Boolean(config.PYTH_API_KEY),
    defaultFeeds: resolveFeedIds(config.PYTH_DEFAULT_FEED_IDS, ["BTC", "ETH", "SOL"]),
    presets: Object.keys(PYTH_FEED_PRESETS),
  },
  note: "DexScreener = UI reference. Pyth Hermes = off-chain index reference. On-chain settlement still uses registered oracle routes.",
}));

app.get("/v1/market-data/dex/profiles/latest", async (_request, reply) => {
  try {
    const profiles = await fetchLatestTokenProfiles(config.DEXSCREENER_BASE_URL, config.DEXSCREENER_CACHE_TTL_MS);
    return { source: "dexscreener", count: profiles.length, profiles };
  } catch (error) {
    return marketDataError(reply, error);
  }
});

app.get("/v1/market-data/dex/search", async (request, reply) => {
  const { q, limit } = z.object({
    q: z.string().min(1).max(128),
    limit: z.coerce.number().int().min(1).max(50).default(20),
  }).parse(request.query);
  try {
    const pairs = (await searchPairs(config.DEXSCREENER_BASE_URL, q, config.DEXSCREENER_CACHE_TTL_MS)).slice(0, limit);
    return { source: "dexscreener", query: q, count: pairs.length, pairs };
  } catch (error) {
    return marketDataError(reply, error);
  }
});

app.get("/v1/market-data/dex/token/:chainId/:tokenAddress", async (request, reply) => {
  const { chainId, tokenAddress } = z.object({
    chainId: z.string().min(1).max(64),
    tokenAddress: z.string().min(4).max(128),
  }).parse(request.params);
  try {
    const pairs = await tokenPairs(
      config.DEXSCREENER_BASE_URL,
      chainId,
      tokenAddress,
      config.DEXSCREENER_CACHE_TTL_MS,
    );
    const best = pairs[0] ?? null;
    return {
      source: "dexscreener",
      chainId,
      tokenAddress,
      best,
      pairs,
      reference: best
        ? {
            priceUsd: best.priceUsd,
            marketCap: best.marketCap,
            fdv: best.fdv,
            volume24h: best.volume24h,
            liquidityUsd: best.liquidityUsd,
            symbol: best.baseToken.symbol,
          }
        : null,
    };
  } catch (error) {
    return marketDataError(reply, error);
  }
});

app.get("/v1/market-data/dex/tokens", async (request, reply) => {
  const parsed = z.object({
    chainId: z.string().min(1).max(64).default(config.DEXSCREENER_DEFAULT_CHAIN),
    addresses: z.string().min(1).max(2000),
  }).parse(request.query);
  const addresses = parsed.addresses.split(",").map((s) => s.trim()).filter(Boolean);
  try {
    const pairs = await tokensByAddresses(
      config.DEXSCREENER_BASE_URL,
      parsed.chainId,
      addresses,
      config.DEXSCREENER_CACHE_TTL_MS,
    );
    return { source: "dexscreener", chainId: parsed.chainId, count: pairs.length, pairs };
  } catch (error) {
    return marketDataError(reply, error);
  }
});

app.get("/v1/market-data/pyth/prices", async (request, reply) => {
  const parsed = z.object({
    ids: z.string().optional(),
    symbols: z.string().optional(),
  }).parse(request.query);
  const fromSymbols = parsed.symbols
    ? resolveFeedIds(parsed.symbols, [])
    : [];
  const fromIds = parsed.ids
    ? resolveFeedIds(parsed.ids, [])
    : [];
  const ids = fromIds.length || fromSymbols.length
    ? [...new Set([...fromIds, ...fromSymbols])]
    : resolveFeedIds(config.PYTH_DEFAULT_FEED_IDS, ["BTC", "ETH", "SOL"]);
  try {
    const prices = await fetchHermesPrices({
      hermesUrl: config.PYTH_HERMES_URL,
      apiKey: config.PYTH_API_KEY,
      ids,
      maxAgeSeconds: config.PYTH_MAX_PRICE_AGE_SECONDS,
      ttlMs: config.PYTH_CACHE_TTL_MS,
    });
    return {
      source: "pyth-hermes",
      hermesUrl: config.PYTH_HERMES_URL,
      count: prices.length,
      prices,
      disclaimer: "Off-chain reference. Settlement uses on-chain OracleRouter routes.",
    };
  } catch (error) {
    return marketDataError(reply, error);
  }
});

app.get("/v1/market-data/pyth/search", async (request, reply) => {
  const { q } = z.object({ q: z.string().min(1).max(64) }).parse(request.query);
  try {
    const feeds = await searchPriceFeeds({
      hermesUrl: config.PYTH_HERMES_URL,
      apiKey: config.PYTH_API_KEY,
      query: q,
      ttlMs: config.PYTH_CACHE_TTL_MS * 6,
    });
    return { source: "pyth-hermes", query: q, count: feeds.length, feeds };
  } catch (error) {
    return marketDataError(reply, error);
  }
});

/** Combined card: DexScreener pair stats + optional Pyth index for a symbol preset. */
app.get("/v1/market-data/quote", async (request, reply) => {
  const parsed = z.object({
    chainId: z.string().min(1).max(64).optional(),
    token: z.string().min(4).max(128).optional(),
    q: z.string().min(1).max(128).optional(),
    pythSymbol: z.string().min(1).max(32).optional(),
    pythId: z.string().min(1).max(128).optional(),
  }).parse(request.query);

  try {
    let dex = null as Awaited<ReturnType<typeof bestPairForToken>> | Awaited<ReturnType<typeof searchPairs>>[number] | null;
    if (parsed.token) {
      const chain = parsed.chainId ?? config.DEXSCREENER_DEFAULT_CHAIN;
      dex = await bestPairForToken(
        config.DEXSCREENER_BASE_URL,
        chain,
        parsed.token,
        config.DEXSCREENER_CACHE_TTL_MS,
      );
    } else if (parsed.q) {
      const hits = await searchPairs(config.DEXSCREENER_BASE_URL, parsed.q, config.DEXSCREENER_CACHE_TTL_MS);
      dex = hits[0] ?? null;
    }

    const feedIds = resolveFeedIds(
      parsed.pythId ?? parsed.pythSymbol ?? "",
      parsed.pythSymbol || parsed.pythId ? [] : [],
    );
    let pyth = null as Awaited<ReturnType<typeof fetchHermesPrices>>[number] | null;
    if (feedIds.length) {
      const prices = await fetchHermesPrices({
        hermesUrl: config.PYTH_HERMES_URL,
        apiKey: config.PYTH_API_KEY,
        ids: feedIds,
        maxAgeSeconds: config.PYTH_MAX_PRICE_AGE_SECONDS,
        ttlMs: config.PYTH_CACHE_TTL_MS,
      });
      pyth = prices[0] ?? null;
    }

    return {
      dexscreener: dex
        ? {
            priceUsd: dex.priceUsd,
            marketCap: dex.marketCap,
            fdv: dex.fdv,
            volume24h: dex.volume24h,
            liquidityUsd: dex.liquidityUsd,
            symbol: dex.baseToken.symbol,
            name: dex.baseToken.name,
            chainId: dex.chainId,
            pairAddress: dex.pairAddress,
            url: dex.url,
            priceChange24h: dex.priceChange24h,
          }
        : null,
      pyth,
      roles: {
        dexscreener: "reference_mc_volume_pair_price",
        pyth: "reference_index_price_offchain",
        settlement: "onchain_oracle_router_only",
      },
    };
  } catch (error) {
    return marketDataError(reply, error);
  }
});

/**
 * Testnet: push a live Dex (or explicit) price into both mock oracle adapters
 * so Market.indexPrice / PnL / open-close match mainnet chart price.
 * Body: { baseToken, sourceCa?, priceUsd?, liquidityUsd? }
 */
app.post("/v1/oracle/push", async (request, reply) => {
  const body = z
    .object({
      baseToken: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
      sourceCa: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(),
      priceUsd: z.number().positive().optional(),
      liquidityUsd: z.number().nonnegative().optional(),
    })
    .parse(request.body ?? {});

  const pk = resolveOraclePusherKey();
  if (!pk) {
    return reply.code(503).send({
      error: "oracle_pusher_unconfigured",
      message: "Set ORACLE_PUSHER_PRIVATE_KEY (or KEEPER/DEPLOYER) on the API host.",
    });
  }
  const adapters = resolveOracleAdapters();
  if (adapters.length < 1) {
    return reply.code(503).send({
      error: "oracle_adapters_unconfigured",
      message: "Set ORACLE_ADAPTERS (comma-separated mock adapter addresses).",
    });
  }

  let price = body.priceUsd ?? 0;
  let liq = body.liquidityUsd ?? config.ORACLE_LIQUIDITY_USD;
  if (!(price > 0)) {
    if (!body.sourceCa) {
      return reply.code(400).send({ error: "need_priceUsd_or_sourceCa" });
    }
    try {
      const dex = await fetchDexPriceUsd(body.sourceCa);
      price = dex.price;
      liq = Math.max(liq, dex.liquidityUsd || 0);
    } catch (error) {
      return marketDataError(reply, error);
    }
  }

  const account = privateKeyToAccount(pk);
  const wallet = createWalletClient({ account, chain: appChain, transport: http(config.RPC_HTTP_URL) });
  const block = await rpc.getBlock();
  const priceStr = price >= 1 ? price.toFixed(8) : price.toFixed(18);
  const data = {
    priceWad: parseUnits(priceStr, 18),
    confidenceBps: 20n,
    updatedAt: block.timestamp,
    liquidityWad: parseUnits(String(Math.max(1_000_000, Math.floor(liq))), 18),
    historySeconds: BigInt(config.ORACLE_HISTORY_SECONDS),
    validSources: 1,
  } as const;

  // Fresh block timestamp per adapter write reduces reduces "stale" edge cases under concurrent loop pushes
  const txs: string[] = [];
  for (const adapter of adapters) {
    let hash: `0x${string}` | undefined;
    let lastErr: unknown;
    for (let attempt = 0; attempt < 8; attempt++) {
      try {
        const tip = await rpc.getBlock();
        const liveData = { ...data, updatedAt: tip.timestamp };
        // Explicit nonce avoids races with STACK oracle:push:loop on the same key
        const nonce = await rpc.getTransactionCount({ address: account.address, blockTag: "pending" });
        hash = await wallet.writeContract({
          address: adapter,
          abi: mockOracleSetAbi,
          functionName: "set",
          args: [body.baseToken as Address, liveData],
          account,
          chain: appChain,
          nonce,
        });
        const receipt = await rpc.waitForTransactionReceipt({ hash, timeout: 60_000 });
        if (receipt.status !== "success") throw new Error(`oracle set reverted on ${adapter}`);
        txs.push(hash);
        lastErr = undefined;
        break;
      } catch (err) {
        lastErr = err;
        const msg = err instanceof Error ? err.message : String(err);
        // Concurrent oracle loop shares the same pusher key — retry nonce / fee / gas estimate blips
        if (
          !/nonce|replacement|underpriced|already known|exceeds allowance|rate limit|timeout|TIMED_OUT/i.test(msg) ||
          attempt === 7
        ) {
          break;
        }
        await new Promise((r) => setTimeout(r, 900 * (attempt + 1) + Math.floor(Math.random() * 400)));
      }
    }
    if (lastErr || !hash) {
      return reply.code(502).send({
        error: "oracle_push_failed",
        message: lastErr instanceof Error ? lastErr.message.slice(0, 500) : String(lastErr).slice(0, 500),
        adapter,
        txs,
        price,
      });
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  return {
    ok: true,
    baseToken: body.baseToken,
    price,
    liquidityUsd: liq,
    adapters,
    txs,
    pusher: account.address,
    updatedAt: Number(block.timestamp),
    note: "On-chain index now tracks this price for settlement / PnL.",
  };
});

/** Readiness for UI: can the API push settlement prices without a user wallet? */
app.get("/v1/oracle/status", async () => {
  const pk = resolveOraclePusherKey();
  const adapters = resolveOracleAdapters();
  return {
    pushEnabled: Boolean(pk) && adapters.length >= 1,
    adapterCount: adapters.length,
    hasPusherKey: Boolean(pk),
    chainId: config.CHAIN_ID,
  };
});

type WsClient = { socket: { send: (data: string) => void; readyState?: number }; topics: Set<string> };
const wsClients = new Set<WsClient>();

function broadcast(topic: string, payload: Record<string, unknown>) {
  const envelope = JSON.stringify({
    schemaVersion: 1,
    topic,
    chainId: config.CHAIN_ID,
    timestamp: new Date().toISOString(),
    payload,
  });
  for (const client of wsClients) {
    if (client.topics.has(topic) || client.topics.has("*") || topic.startsWith("system.")) {
      try {
        client.socket.send(envelope);
      } catch {
        // drop dead socket on next GC
      }
    }
  }
}

app.get("/ws", { websocket: true }, (socket, request) => {
  const url = new URL(request.url, "http://localhost");
  const topicsParam = url.searchParams.get("topics") ?? "system.*,projections.summary";
  const topics = new Set(
    topicsParam.split(",").map((t) => t.trim()).filter(Boolean),
  );
  // system.* subscription expands to system.ready / system.heartbeat
  if ([...topics].some((t) => t === "system.*" || t.startsWith("system"))) {
    topics.add("system.ready");
    topics.add("system.heartbeat");
  }
  const client: WsClient = { socket, topics };
  wsClients.add(client);

  socket.send(JSON.stringify({
    schemaVersion: 1,
    topic: "system.ready",
    chainId: config.CHAIN_ID,
    timestamp: new Date().toISOString(),
    payload: { topics: [...topics], note: "Subscribe via ?topics=system.*,projections.summary,projections.trades" },
  }));

  const heartbeat = setInterval(() => {
    broadcast("system.heartbeat", { clients: wsClients.size });
  }, 15_000);

  const projectionsPulse = setInterval(async () => {
    if (![...topics].some((t) => t === "projections.summary" || t === "*")) return;
    try {
      const [markets, openAccounts, trades] = await Promise.all([
        query<{ count: string }>("select count(*)::text as count from projected_markets where chain_id=$1", [config.CHAIN_ID]),
        query<{ count: string }>("select count(*)::text as count from projected_open_accounts where chain_id=$1 and open=true", [config.CHAIN_ID]),
        query<{ count: string }>("select count(*)::text as count from projected_trades where chain_id=$1 and canonical=true", [config.CHAIN_ID]),
      ]);
      let blockNumber: string | null = null;
      try {
        blockNumber = (await rpc.getBlockNumber()).toString();
      } catch {
        blockNumber = null;
      }
      socket.send(JSON.stringify({
        schemaVersion: 1,
        topic: "projections.summary",
        chainId: config.CHAIN_ID,
        timestamp: new Date().toISOString(),
        payload: {
          blockNumber,
          markets: Number(markets[0]?.count ?? 0),
          openAccounts: Number(openAccounts[0]?.count ?? 0),
          trades: Number(trades[0]?.count ?? 0),
        },
      }));
    } catch {
      // projections table missing — skip quietly
    }
  }, 20_000);

  socket.on("message", (raw) => {
    try {
      const msg = JSON.parse(String(raw)) as { action?: string; topics?: string[] };
      if (msg.action === "subscribe" && Array.isArray(msg.topics)) {
        for (const t of msg.topics) topics.add(t);
        socket.send(JSON.stringify({
          schemaVersion: 1,
          topic: "system.subscribed",
          timestamp: new Date().toISOString(),
          payload: { topics: [...topics] },
        }));
      }
    } catch {
      // ignore malformed
    }
  });

  socket.on("close", () => {
    clearInterval(heartbeat);
    clearInterval(projectionsPulse);
    wsClients.delete(client);
  });
});

const close = async () => { await app.close(); await pool.end(); };
process.on("SIGINT", close);
process.on("SIGTERM", close);
await app.listen({ port: config.PORT, host: config.HOST });
