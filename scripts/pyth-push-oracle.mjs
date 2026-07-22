#!/usr/bin/env node
/**
 * Push Pyth Hermes (and optional DexScreener) prices into MockOracleAdapter.set() on testnet.
 *
 *   pnpm oracle:push              # one shot — all listed markets
 *   pnpm oracle:push:loop         # every ORACLE_PUSH_INTERVAL_MS (default 30s)
 *
 * Reads assets from:
 *   1) deployments/listed-markets.json (multi-asset)
 *   2) ORACLE_ADAPTERS + ORACLE_BASE_TOKEN + ORACLE_PYTH_SYMBOL (legacy single)
 */
import fs from "node:fs";
import path from "node:path";
import "dotenv/config";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  isAddress,
  parseUnits,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const FEEDS = {
  BTC: "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43",
  ETH: "ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace",
  SOL: "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d",
  USDC: "eaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a",
};

const mockOracleAbi = [
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
];

function loadListed() {
  const p = path.join("deployments", "listed-markets.json");
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function loadDemoDefaults() {
  const pending = path.join("deployments", "pending-e2e-config.json");
  const live = path.join("deployments", "live-demo-market.json");
  let adapters = [];
  let baseToken = "";
  let market = "";
  if (fs.existsSync(pending)) {
    const j = JSON.parse(fs.readFileSync(pending, "utf8"));
    if (j.adapterA) adapters.push(j.adapterA);
    if (j.adapterB) adapters.push(j.adapterB);
    baseToken = j.baseToken ?? baseToken;
  }
  if (fs.existsSync(live)) {
    const j = JSON.parse(fs.readFileSync(live, "utf8"));
    baseToken = j.baseToken ?? baseToken;
    market = j.market ?? market;
  }
  return { adapters, baseToken, market };
}

function resolveAdapters() {
  const demo = loadDemoDefaults();
  const listed = loadListed();
  const fromEnv = (process.env.ORACLE_ADAPTERS ?? "")
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter((s) => isAddress(s));
  const fromListed = listed?.adapters?.filter((s) => isAddress(s)) ?? [];
  const adapters = fromEnv.length
    ? fromEnv
    : fromListed.length
      ? fromListed
      : demo.adapters.filter((s) => isAddress(s));
  return { adapters, listed, demo };
}

async function fetchPythPrice(feedId, hermesUrl, apiKey) {
  const qs = `ids[]=${encodeURIComponent(feedId)}&parsed=true`;
  const url = `${hermesUrl.replace(/\/$/, "")}/v2/updates/price/latest?${qs}`;
  const headers = { accept: "application/json", "user-agent": "AnyPerp-oracle-pusher/0.2" };
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
    headers["X-API-Key"] = apiKey;
  }
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(12_000) });
  if (!res.ok) throw new Error(`Hermes ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const row = data.parsed?.[0];
  if (!row?.price) throw new Error("Hermes returned no parsed price");
  const expo = Number(row.price.expo);
  const price = Number(row.price.price) * 10 ** expo;
  const conf = Number(row.price.conf) * 10 ** expo;
  if (!(price > 0) || !Number.isFinite(price)) throw new Error(`Invalid pyth price ${price}`);
  return {
    price,
    conf,
    publishTime: Number(row.price.publish_time),
    id: String(row.id).replace(/^0x/i, "").toLowerCase(),
  };
}

async function fetchDexPrice(sourceCa) {
  const res = await fetch(`https://api.dexscreener.com/token-pairs/v1/robinhood/${sourceCa}`, {
    signal: AbortSignal.timeout(12_000),
  });
  if (!res.ok) throw new Error(`DexScreener ${res.status}`);
  const pairs = await res.json();
  const p = Array.isArray(pairs) ? pairs[0] : null;
  if (!p?.priceUsd) throw new Error("no dex price");
  return {
    price: Number(p.priceUsd),
    conf: Number(p.priceUsd) * 0.002,
    liquidityUsd: Number(p.liquidity?.usd || 1_000_000),
    symbol: p.baseToken?.symbol,
  };
}

function toPriceData(price, conf, updatedAt, liquidityUsd = 5_000_000) {
  let confidenceBps = 20n;
  if (price > 0 && conf > 0) {
    const bps = Math.ceil((conf / price) * 10_000);
    confidenceBps = BigInt(Math.min(100, Math.max(1, bps)));
  }
  const priceStr = price >= 1 ? price.toFixed(8) : price.toFixed(18);
  return {
    priceWad: parseUnits(priceStr, 18),
    confidenceBps,
    updatedAt,
    liquidityWad: parseUnits(String(Math.max(1_000_000, Math.floor(liquidityUsd))), 18),
    historySeconds: BigInt(process.env.ORACLE_HISTORY_SECONDS ?? "2592000"),
    validSources: 1,
  };
}

/** Discover community launches from helper events (no user wallet needed). */
async function discoverLaunchTargets(publicClient) {
  const helper =
    process.env.LAUNCH_HELPER_ADDRESS ||
    process.env.NEXT_PUBLIC_LAUNCH_HELPER_ADDRESS ||
    "0xaec57bd44a14302c9d157f1ba14c0b664f00209c";
  if (!isAddress(helper)) return [];
  try {
    const latest = await publicClient.getBlockNumber();
    const fromBlock = latest > 120_000n ? latest - 120_000n : 0n;
    const logs = await publicClient.getLogs({
      address: helper,
      event: {
        type: "event",
        name: "MarketLaunched",
        inputs: [
          { name: "launcher", type: "address", indexed: true },
          { name: "market", type: "address", indexed: true },
          { name: "marketId", type: "bytes32", indexed: false },
          { name: "baseToken", type: "address", indexed: false },
          { name: "sourceHint", type: "address", indexed: false },
          { name: "symbol", type: "string", indexed: false },
        ],
      },
      fromBlock,
      toBlock: "latest",
    });
    return logs.map((log) => {
      const args = log.args || {};
      return {
        symbol: args.symbol || "DEX",
        baseToken: args.baseToken,
        kind: "dex",
        sourceCa: args.sourceHint,
      };
    }).filter((t) => t.baseToken && isAddress(t.baseToken) && t.sourceCa && isAddress(t.sourceCa));
  } catch (e) {
    console.error("discoverLaunchTargets", e instanceof Error ? e.message : e);
    return [];
  }
}

/** Build push targets: { symbol, baseToken, kind: 'pyth'|'dex', feed?, sourceCa? } */
function buildTargets(listed, demo, discovered = []) {
  const targets = [];
  if (listed?.markets?.length) {
    for (const m of listed.markets) {
      if (!m.baseToken || !isAddress(m.baseToken)) continue;
      if (m.pyth && FEEDS[String(m.pyth).toUpperCase()]) {
        targets.push({
          symbol: m.symbol || m.pyth,
          baseToken: m.baseToken,
          kind: "pyth",
          feed: FEEDS[String(m.pyth).toUpperCase()],
        });
      } else if (m.dexPrice && m.sourceCa) {
        targets.push({
          symbol: m.symbol || "DEX",
          baseToken: m.baseToken,
          kind: "dex",
          sourceCa: m.sourceCa,
        });
      }
    }
  }
  for (const d of discovered) targets.push(d);
  // Legacy single-asset fallback if no listed file
  if (!targets.length) {
    const baseToken = process.env.ORACLE_BASE_TOKEN || demo.baseToken;
    const symbol = (process.env.ORACLE_PYTH_SYMBOL ?? "BTC").toUpperCase();
    if (baseToken && isAddress(baseToken) && FEEDS[symbol]) {
      targets.push({ symbol, baseToken, kind: "pyth", feed: FEEDS[symbol] });
    }
  }
  // Dedupe by baseToken
  const seen = new Set();
  return targets.filter((t) => {
    const k = String(t.baseToken).toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

async function pushOnce() {
  const { adapters, listed, demo } = resolveAdapters();
  if (!adapters.length) throw new Error("No ORACLE_ADAPTERS (and no listed-markets adapters)");

  const pk =
    process.env.ORACLE_PUSHER_PRIVATE_KEY ||
    process.env.DEPLOYER_PRIVATE_KEY ||
    process.env.KEEPER_PRIVATE_KEY;
  if (!pk?.startsWith("0x")) {
    throw new Error("Need ORACLE_PUSHER_PRIVATE_KEY or DEPLOYER_PRIVATE_KEY or KEEPER_PRIVATE_KEY");
  }

  const chainId = Number(process.env.CHAIN_ID ?? 46630);
  const rpcUrl = process.env.RPC_HTTP_URL ?? "https://rpc.testnet.chain.robinhood.com";
  const chain = defineChain({
    id: chainId,
    name: "AnyPerp target",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
  const account = privateKeyToAccount(pk);
  const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
  const wallet = createWalletClient({ account, chain, transport: http(rpcUrl) });

  const discovered = await discoverLaunchTargets(publicClient);
  const targets = buildTargets(listed, demo, discovered);
  if (!targets.length) throw new Error("No oracle targets (listed-markets.json or ORACLE_BASE_TOKEN)");

  const hermes = process.env.PYTH_HERMES_URL ?? "https://hermes.pyth.network";
  const block = await publicClient.getBlock();
  const updatedAt = block.timestamp;

  const results = [];
  for (const t of targets) {
    try {
      let price;
      let conf;
      let liq = Number(process.env.ORACLE_LIQUIDITY_USD ?? "5000000");
      let meta = {};
      if (t.kind === "pyth") {
        const pyth = await fetchPythPrice(t.feed, hermes, process.env.PYTH_API_KEY);
        price = pyth.price;
        conf = pyth.conf;
        meta = { feedId: t.feed, publishTime: pyth.publishTime };
      } else {
        const dex = await fetchDexPrice(t.sourceCa);
        price = dex.price;
        conf = dex.conf;
        liq = Math.max(liq, dex.liquidityUsd || 0);
        meta = { sourceCa: t.sourceCa };
      }
      const hashes = [];
      for (const adapter of adapters) {
        let hash;
        for (let attempt = 0; attempt < 8; attempt++) {
          try {
            const tip = await publicClient.getBlock();
            const data = toPriceData(price, conf, tip.timestamp, liq);
            const nonce = await publicClient.getTransactionCount({
              address: account.address,
              blockTag: "pending",
            });
            hash = await wallet.writeContract({
              address: adapter,
              abi: mockOracleAbi,
              functionName: "set",
              args: [t.baseToken, data],
              account,
              chain,
              nonce,
            });
            break;
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (
              /nonce|replacement|underpriced|already known|exceeds allowance|timeout|TIMED_OUT/i.test(msg) &&
              attempt < 7
            ) {
              await new Promise((r) => setTimeout(r, 1200 * (attempt + 1) + Math.floor(Math.random() * 500)));
              continue;
            }
            throw err;
          }
        }
        const receipt = await publicClient.waitForTransactionReceipt({ hash });
        if (receipt.status !== "success") throw new Error(`set reverted on ${adapter}: ${hash}`);
        hashes.push(hash);
        // brief gap so parallel loop / RPC nonce lag does not collide on last assets
        await new Promise((r) => setTimeout(r, 400));
      }
      results.push({
        ok: true,
        symbol: t.symbol,
        kind: t.kind,
        baseToken: t.baseToken,
        price,
        txs: hashes,
        ...meta,
      });
    } catch (err) {
      results.push({
        ok: false,
        symbol: t.symbol,
        baseToken: t.baseToken,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const result = {
    ok: results.every((r) => r.ok),
    pushed: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    adapters,
    results,
    pusher: account.address,
    at: new Date().toISOString(),
  };
  console.log(JSON.stringify(result, null, 2));
  fs.mkdirSync("deployments", { recursive: true });
  fs.writeFileSync("deployments/oracle-push-latest.json", `${JSON.stringify(result, null, 2)}\n`);
  if (!result.ok && !results.some((r) => r.ok)) throw new Error("All oracle pushes failed");
  return result;
}

const loop = process.argv.includes("--loop");
const intervalMs = Number(process.env.ORACLE_PUSH_INTERVAL_MS ?? 30_000);

if (loop) {
  console.log(`oracle multi-asset pusher every ${intervalMs}ms`);
  const tick = async () => {
    try {
      await pushOnce();
    } catch (err) {
      console.error("push failed", err instanceof Error ? err.message : err);
    }
  };
  await tick();
  setInterval(() => void tick(), intervalMs);
} else {
  await pushOnce();
}
