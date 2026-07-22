import "dotenv/config";
import { z } from "zod";

const schema = z.object({
  PORT: z.coerce.number().int().positive().default(4000),
  HOST: z.string().default("127.0.0.1"),
  CHAIN_ID: z.coerce.number().int().default(46630),
  RPC_HTTP_URL: z.string().url().default("https://rpc.testnet.chain.robinhood.com"),
  DATABASE_URL: z.string().default("postgresql://anyperp:anyperp@localhost:5432/anyperp"),
  REDIS_URL: z.string().default("redis://localhost:6379"),
  MARKET_FACTORY_ADDRESS: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(),
  MARKET_REGISTRY_ADDRESS: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(),
  LIQUIDATION_ENGINE_ADDRESS: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(),
  TRIGGER_ORDER_MANAGER_ADDRESS: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(),
  LOG_LEVEL: z.string().default("info"),
  CORS_ORIGINS: z.string().default("http://localhost:3000,http://127.0.0.1:3000"),
  /** Simple per-IP request budget for public testnet API (requests per window). */
  API_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(120),
  API_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),

  // Market data — DexScreener (UI reference: MC / vol / pair price)
  DEXSCREENER_BASE_URL: z.string().url().default("https://api.dexscreener.com"),
  DEXSCREENER_CACHE_TTL_MS: z.coerce.number().int().positive().default(30_000),
  DEXSCREENER_DEFAULT_CHAIN: z.string().default("robinhood"),

  // Market data — Pyth Hermes (index-style prices; not a substitute for on-chain oracle yet)
  PYTH_HERMES_URL: z.string().url().default("https://hermes.pyth.network"),
  /** Optional gateway key. Public Hermes works without it. Do not commit real secrets. */
  PYTH_API_KEY: z.string().optional(),
  /** Comma-separated hex feed ids and/or presets: BTC,ETH,SOL */
  PYTH_DEFAULT_FEED_IDS: z.string().default("BTC,ETH,SOL"),
  PYTH_MAX_PRICE_AGE_SECONDS: z.coerce.number().int().positive().default(120),
  PYTH_CACHE_TTL_MS: z.coerce.number().int().positive().default(5_000),

  /**
   * Testnet oracle bridge: push DexScreener/Pyth into MockOracleAdapter.set().
   * Same keys as `pnpm oracle:push`. Without a key, POST /v1/oracle/push returns 503.
   */
  ORACLE_PUSHER_PRIVATE_KEY: z.string().optional(),
  DEPLOYER_PRIVATE_KEY: z.string().optional(),
  KEEPER_PRIVATE_KEY: z.string().optional(),
  /** Comma-separated mock oracle adapter addresses */
  ORACLE_ADAPTERS: z.string().optional(),
  NEXT_PUBLIC_ORACLE_ADAPTERS: z.string().optional(),
  ORACLE_LIQUIDITY_USD: z.coerce.number().positive().default(5_000_000),
  ORACLE_HISTORY_SECONDS: z.coerce.number().int().positive().default(2_592_000),
});

export const config = schema.parse(process.env);
