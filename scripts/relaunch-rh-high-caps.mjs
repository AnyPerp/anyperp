#!/usr/bin/env node
/**
 * Re-launch RH meme markets with correct risk units after size-caps envelope:
 *   maxPosition / maxOI = notional $
 *   maxSkew = base tokens (must be huge for cheap tokens)
 *
 *   node scripts/relaunch-rh-high-caps.mjs
 */
import fs from "node:fs";
import "dotenv/config";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeAbiParameters,
  formatUnits,
  http,
  keccak256,
  parseUnits,
  stringToHex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const chainId = 46630;
const rpcUrl = process.env.RPC_HTTP_URL ?? "https://rpc.testnet.chain.robinhood.com";
const chain = defineChain({
  id: chainId,
  name: "RHC",
  nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [rpcUrl] } },
});
const account = privateKeyToAccount(process.env.DEPLOYER_PRIVATE_KEY);
const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
const wallet = createWalletClient({ account, chain, transport: http(rpcUrl) });

const FACTORY = "0xd1e154498a382074cf66f3274244d55b80b1a52d";
const COLLATERAL = "0x8f3e02f6ae47ec0e5ff5dcd4dd1bfbd3c1fed2f0";
const ADAPTER_A = "0x957ce5792080b0aaf97632cc78c976905fe17962";
const ADAPTER_B = "0x5d669814ca06142581bcea83f51f794d0fd1eafb";
const ORACLE_ROUTER = "0xd9e74c0ebdfbb9538b63fe5d7e4456456ef4a13b";

function artifact(name) {
  return JSON.parse(fs.readFileSync(`contracts/out/${name}.json`, "utf8"));
}

async function write(address, abi, functionName, args = []) {
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const hash = await wallet.writeContract({ address, abi, functionName, args, account, chain });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new Error(`${functionName} reverted ${hash}`);
      console.log(`  OK ${functionName} ${hash.slice(0, 14)}…`);
      return hash;
    } catch (e) {
      const msg = e?.shortMessage || e?.message || String(e);
      if (/nonce|replacement|underpriced/i.test(msg) && attempt < 5) {
        console.log(`  retry ${functionName}: ${msg.slice(0, 100)}`);
        await new Promise((r) => setTimeout(r, 1200 * (attempt + 1)));
        continue;
      }
      throw e;
    }
  }
}

/** Risk: pos/OI are $ notional; skew is base size (Market._checkCaps). */
function riskForLaunch() {
  return {
    initialMarginBps: 1_000n, // 10x (envelope floor IM=100 allows this)
    maintenanceMarginBps: 500n,
    maxOpenInterestWad: parseUnits("1000000", 18), // $1M notional OI
    maxSkewWad: parseUnits("100000000000000000", 18), // 1e17 base tokens
    maxPositionWad: parseUnits("100000", 18), // $100k notional / position
    maxUtilizationBps: 9_000n,
    maxPriceImpactBps: 100n,
    tradingFeeBps: 10n,
    liquidationPenaltyBps: 500n,
    minSeedLiquidityWad: parseUnits("100000", 18),
    minInsuranceWad: parseUnits("10000", 18),
    minOracleLiquidityWad: parseUnits("1000000", 18),
    minOracleHistory: 86_400n,
    maxOracleConfidenceBps: 100n,
    maxOracleDeviationBps: 500n,
    oracleMaxAge: 31_536_000n,
    minOracleSources: 2,
    minCreatorBondWad: parseUnits("1000", 18),
    baseSpreadBps: 10n,
    longPayoutStressBps: 90_000n,
    shortPayoutStressBps: 10_000n,
    fundingVelocityWad: 1_000_000_000_000n,
    maxFundingRatePerSecondWad: 1_000_000_000_000n,
    maxFundingAccrualSeconds: 3_600n,
  };
}

async function fetchDex(ca) {
  const res = await fetch(`https://api.dexscreener.com/token-pairs/v1/robinhood/${ca}`, {
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`dex ${res.status}`);
  const pairs = await res.json();
  const p = Array.isArray(pairs) ? pairs[0] : null;
  if (!p?.priceUsd) throw new Error("no dex price");
  return {
    priceUsd: Number(p.priceUsd),
    symbol: p.baseToken?.symbol || "TOKEN",
    name: p.baseToken?.name || "Token",
    liquidityUsd: Number(p.liquidity?.usd || 0),
  };
}

async function pushOracle(baseToken, priceUsd, liqUsd = 5_000_000) {
  const mockOracleAbi = artifact("MockOracleAdapter").abi;
  const block = await publicClient.getBlock();
  const priceStr = priceUsd >= 1 ? priceUsd.toFixed(8) : priceUsd.toFixed(18);
  const data = {
    priceWad: parseUnits(priceStr, 18),
    confidenceBps: 20n,
    updatedAt: block.timestamp,
    liquidityWad: parseUnits(String(Math.max(1_000_000, Math.floor(liqUsd))), 18),
    historySeconds: 2_592_000n,
    validSources: 1,
  };
  for (const adapter of [ADAPTER_A, ADAPTER_B]) {
    await write(adapter, mockOracleAbi, "set", [baseToken, data]);
  }
}

async function ensureRoute(baseToken) {
  const routerAbi = artifact("OracleRouter").abi;
  try {
    const sim = await publicClient.simulateContract({
      account,
      address: ORACLE_ROUTER,
      abi: routerAbi,
      functionName: "createRoute",
      args: [baseToken, [ADAPTER_A, ADAPTER_B]],
    });
    await write(ORACLE_ROUTER, routerAbi, "createRoute", [baseToken, [ADAPTER_A, ADAPTER_B]]);
    return sim.result;
  } catch (e) {
    const routeId = keccak256(
      encodeAbiParameters(
        [{ type: "uint256" }, { type: "address" }, { type: "address[]" }],
        [BigInt(chainId), baseToken, [ADAPTER_A, ADAPTER_B]],
      ),
    );
    console.log("  route exists →", routeId);
    return routeId;
  }
}

async function createActiveMarket(baseToken, routeId, saltTag) {
  const erc20Abi = artifact("MockERC20").abi;
  const factoryAbi = artifact("MarketFactory").abi;
  const bond = parseUnits("1000", 6);
  const lp = parseUnits("200000", 6);
  const ins = parseUnits("20000", 6);

  await write(COLLATERAL, erc20Abi, "mint", [account.address, parseUnits("300000", 6)]);
  await write(COLLATERAL, erc20Abi, "approve", [FACTORY, bond]);

  const salt = keccak256(stringToHex(`rh-hicap:${saltTag}:${Date.now()}`));
  const params = {
    baseToken,
    collateralToken: COLLATERAL,
    tier: 3,
    risk: riskForLaunch(),
    oracleRouteId: routeId,
    creatorBond: bond,
    userSalt: salt,
  };
  const createSim = await publicClient.simulateContract({
    account,
    address: FACTORY,
    abi: factoryAbi,
    functionName: "createMarket",
    args: [params],
  });
  const [marketId, marketAddress] = createSim.result;
  await write(FACTORY, factoryAbi, "createMarket", [params]);
  await write(FACTORY, factoryAbi, "validateMarket", [marketId]);
  const deployment = await publicClient.readContract({
    address: FACTORY,
    abi: factoryAbi,
    functionName: "deployments",
    args: [marketId],
  });
  const liqVault = deployment[2];
  const insuranceFund = deployment[3];
  await write(COLLATERAL, erc20Abi, "approve", [liqVault, lp]);
  await write(COLLATERAL, erc20Abi, "approve", [insuranceFund, ins]);
  await write(FACTORY, factoryAbi, "seedMarket", [marketId, lp, ins]);
  await write(FACTORY, factoryAbi, "activateMarket", [marketId]);

  const marketAbi = artifact("Market").abi;
  const index = await publicClient.readContract({
    address: marketAddress,
    abi: marketAbi,
    functionName: "indexPrice",
  });
  const risk = await publicClient.readContract({
    address: marketAddress,
    abi: marketAbi,
    functionName: "riskParams",
  });
  const px = Number(formatUnits(index, 18));
  console.log("  caps check:", {
    maxPosUsd: Number(formatUnits(risk.maxPositionWad, 18)),
    maxOiUsd: Number(formatUnits(risk.maxOpenInterestWad, 18)),
    maxSkewBase: Number(formatUnits(risk.maxSkewWad, 18)),
    maxSkewUsdApprox: Number(formatUnits(risk.maxSkewWad, 18)) * px,
  });

  return {
    marketId,
    market: marketAddress,
    liquidityVault: liqVault,
    insuranceFund,
    index: formatUnits(index, 18),
    priceUsd: px,
  };
}

const RH = [
  {
    symbol: "RATDOG",
    label: "RATDOG (Robinhood)",
    baseToken: "0x76bc45ad48439ab8ce1e5f5f9822abd01185409f",
    sourceCa: "0x6e48630073d7246a162Cc7536330c15f818096Cb",
  },
  {
    symbol: "RWA",
    label: "RWA Real World Assets (RH)",
    baseToken: "0x578B554A7132c9f577F7d8d88ff85783626701ed",
    sourceCa: "0x4a380618777eED8D513bcd6e983DF3c5D2ba7777",
  },
  {
    symbol: "CAPYBARA",
    label: "CAPYBARA (RH)",
    baseToken: "0xD735B5259e3D7e8AEC664239a1cEA5Fc61793b19",
    sourceCa: "0xcd74186f308BC3D90BFDA5Ff6556eA89bFed81E6",
  },
];

const prev = JSON.parse(fs.readFileSync("app/listed-markets.json", "utf8"));
const keep = (prev.markets || []).filter((m) => !["RATDOG", "RWA", "CAPYBARA"].includes(m.symbol));

const launched = [];
for (const row of RH) {
  console.log(`\n==> ${row.symbol}`);
  const dex = await fetchDex(row.sourceCa);
  console.log("  dex px", dex.priceUsd, dex.symbol);
  await pushOracle(row.baseToken, dex.priceUsd, Math.max(1_000_000, dex.liquidityUsd || 0));
  const routeId = await ensureRoute(row.baseToken);
  const m = await createActiveMarket(row.baseToken, routeId, row.symbol);
  launched.push({
    symbol: row.symbol,
    label: row.label,
    market: m.market,
    marketId: m.marketId,
    baseToken: row.baseToken,
    routeId,
    liquidityVault: m.liquidityVault,
    insuranceFund: m.insuranceFund,
    chartSymbol: null,
    pyth: null,
    dexPrice: true,
    sourceCa: row.sourceCa,
    source: "dexscreener-robinhood",
    priceUsd: m.priceUsd,
    index: m.index,
    active: true,
    highCaps: true,
  });
  console.log("  LIVE", m.market, "index", m.index);
}

const out = {
  chainId,
  factory: FACTORY,
  collateral: COLLATERAL,
  adapters: [ADAPTER_A, ADAPTER_B],
  generatedAt: new Date().toISOString(),
  markets: [...keep, ...launched],
  note: "RH markets re-launched with $100k max position notional + 1e17 base skew (cheap-token safe).",
};

fs.writeFileSync("deployments/listed-markets.json", `${JSON.stringify(out, null, 2)}\n`);
fs.writeFileSync("app/listed-markets.json", `${JSON.stringify(out, null, 2)}\n`);
console.log("\n==> updated app/listed-markets.json + deployments/listed-markets.json");
console.log(launched.map((m) => `${m.symbol} ${m.market}`).join("\n"));
