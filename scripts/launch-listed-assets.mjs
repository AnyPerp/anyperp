#!/usr/bin/env node
/**
 * Launch BTC (existing) + ETH + SOL listed markets on RHC testnet.
 * Each asset gets: MockERC20 base (if new) → Pyth price on adapters → createRoute → create/seed/activate.
 *
 *   node scripts/launch-listed-assets.mjs
 *   node scripts/launch-listed-assets.mjs --only ETH,SOL
 *
 * Writes deployments/listed-markets.json for UI + oracle:push multi-asset loop.
 */
import fs from "node:fs";
import "dotenv/config";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeAbiParameters,
  http,
  isAddress,
  keccak256,
  parseUnits,
  formatUnits,
  stringToHex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const chainId = 46630;
const rpcUrl = process.env.RPC_HTTP_URL ?? "https://rpc.testnet.chain.robinhood.com";
const chain = defineChain({
  id: chainId,
  name: "RHC Testnet",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [rpcUrl] } },
});

const pk = process.env.DEPLOYER_PRIVATE_KEY;
if (!pk?.startsWith("0x")) throw new Error("DEPLOYER_PRIVATE_KEY required");
const account = privateKeyToAccount(pk);
const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
const wallet = createWalletClient({ account, chain, transport: http(rpcUrl) });

const FACTORY = process.env.NEXT_PUBLIC_MARKET_FACTORY_ADDRESS || "0xd1e154498a382074cf66f3274244d55b80b1a52d";
const COLLATERAL = process.env.NEXT_PUBLIC_COLLATERAL_ADDRESS || "0x8f3e02f6ae47ec0e5ff5dcd4dd1bfbd3c1fed2f0";
const ADAPTER_A = "0x957ce5792080b0aaf97632cc78c976905fe17962";
const ADAPTER_B = "0x5d669814ca06142581bcea83f51f794d0fd1eafb";
const ORACLE_ROUTER = process.env.NEXT_PUBLIC_ORACLE_ROUTER_ADDRESS || "0xd9e74c0ebdfbb9538b63fe5d7e4456456ef4a13b";

const PYTH = {
  BTC: "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43",
  ETH: "ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace",
  SOL: "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d",
};

const BINANCE = { BTC: "BTCUSDT", ETH: "ETHUSDT", SOL: "SOLUSDT" };

/** Existing live demo = BTC */
const EXISTING_BTC = {
  symbol: "BTC",
  label: "Bitcoin",
  market: "0x2D2EE857198874e89Db2Cf29C3E1B47Bfb184cEa",
  marketId: "0x0086bac6568bb3c77286c04f30a345f6cebca92a5619ec091faeda64e9079f82",
  baseToken: "0xf07a6d0b9453941c68dffebf181d556def09a8bf",
  routeId: "0x14deb0349513e213518bd0247addd8e42d964ef2a7e19388719fbcf52ecbed73",
  liquidityVault: "0xa6026956fA4c20C7C4A04da076fA0d38dac21407",
  insuranceFund: "0x391dFF40D80de2E3093DBDb3e022F1811F86b687",
  chartSymbol: "BTCUSDT",
  pyth: "BTC",
  source: "platform-demo",
};

/** Optional RH meme from prior E2E */
const EXISTING_RATDOG = {
  symbol: "RATDOG",
  label: "RATDOG (Robinhood)",
  market: "0x0152536235A3Be21481d66BA6CA51Ba26C054A08",
  marketId: "0x273fb084e92f9c0c6c5f85e9b6ebea208507c206c51c5c3b2191bad364204042",
  baseToken: "0x76bc45ad48439ab8ce1e5f5f9822abd01185409f",
  routeId: null,
  liquidityVault: "0x9c36FD6AF6EFA741682d71792b7b547127afBD6f",
  insuranceFund: "0x41527ae494B5953d6Cc11c0a7733FB2Cb241bd0e",
  chartSymbol: null,
  pyth: null,
  dexPrice: true,
  sourceCa: "0x6e48630073d7246a162Cc7536330c15f818096Cb",
  source: "dexscreener-robinhood",
};

function artifact(name) {
  return JSON.parse(fs.readFileSync(`contracts/out/${name}.json`, "utf8"));
}

async function nextNonce() {
  return publicClient.getTransactionCount({ address: account.address, blockTag: "pending" });
}

async function write(address, abi, functionName, args = []) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      // Let viem pick nonce (avoids race with oracle pusher / parallel txs)
      const hash = await wallet.writeContract({ address, abi, functionName, args, account, chain });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new Error(`${functionName} reverted ${hash}`);
      console.log(`  OK ${functionName} ${hash.slice(0, 14)}…`);
      return { hash, receipt };
    } catch (e) {
      const msg = e?.shortMessage || e?.message || String(e);
      if (/nonce|replacement|underpriced/i.test(msg) && attempt < 4) {
        console.log(`  retry ${functionName} (${msg.slice(0, 80)})`);
        await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
        continue;
      }
      throw e;
    }
  }
  throw new Error(`${functionName} failed after retries`);
}

async function fetchPyth(symbol) {
  const id = PYTH[symbol];
  if (!id) throw new Error(`No Pyth feed for ${symbol}`);
  const res = await fetch(
    `https://hermes.pyth.network/v2/updates/price/latest?ids[]=${id}&parsed=true`,
    { signal: AbortSignal.timeout(12_000) },
  );
  if (!res.ok) throw new Error(`Hermes ${res.status}`);
  const data = await res.json();
  const row = data.parsed?.[0];
  if (!row?.price) throw new Error("no pyth price");
  const expo = Number(row.price.expo);
  return Number(row.price.price) * 10 ** expo;
}

async function fetchDexRobinhood(ca) {
  const res = await fetch(`https://api.dexscreener.com/token-pairs/v1/robinhood/${ca}`);
  if (!res.ok) return null;
  const pairs = await res.json();
  const p = Array.isArray(pairs) ? pairs[0] : null;
  if (!p?.priceUsd) return null;
  return {
    priceUsd: Number(p.priceUsd),
    symbol: p.baseToken?.symbol,
    name: p.baseToken?.name,
    liquidityUsd: Number(p.liquidity?.usd || 0),
  };
}

const experimentalRisk = {
  initialMarginBps: 1_000n,
  maintenanceMarginBps: 500n,
  maxOpenInterestWad: parseUnits("1000000", 18),
  maxSkewWad: parseUnits("10000", 18),
  maxPositionWad: parseUnits("100000", 18),
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
    console.log("  createRoute note:", e.shortMessage || e.message, "→", routeId);
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

  const salt = keccak256(stringToHex(`listed:${saltTag}:${Date.now()}`));
  const params = {
    baseToken,
    collateralToken: COLLATERAL,
    tier: 3,
    risk: experimentalRisk,
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

  return {
    marketId,
    market: marketAddress,
    liquidityVault: liqVault,
    insuranceFund,
    index: formatUnits(index, 18),
  };
}

async function deployBase(name, symbol) {
  const mockArt = artifact("MockERC20");
  const hash = await wallet.deployContract({
    abi: mockArt.abi,
    bytecode: `0x${mockArt.evm.bytecode.object}`,
    args: [`AnyPerp ${name}`, symbol, 18],
    account,
    chain,
    nonce: await nextNonce(),
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (!receipt.contractAddress) throw new Error("base deploy failed");
  console.log("  baseToken", receipt.contractAddress);
  return receipt.contractAddress;
}

async function marketAlive(addr) {
  if (!addr || !isAddress(addr)) return false;
  try {
    const state = await publicClient.readContract({
      address: addr,
      abi: [{ type: "function", name: "state", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] }],
      functionName: "state",
    });
    return Number(state) === 3; // Active
  } catch {
    return false;
  }
}

const onlyArg = process.argv.find((a) => a.startsWith("--only="));
const only = onlyArg
  ? onlyArg.slice(7).split(",").map((s) => s.trim().toUpperCase())
  : process.argv.includes("--only")
    ? (process.argv[process.argv.indexOf("--only") + 1] || "").split(",").map((s) => s.trim().toUpperCase())
    : null;

const listed = [];

// --- BTC (keep existing) ---
if (!only || only.includes("BTC")) {
  console.log("\n==> BTC (existing demo)");
  const price = await fetchPyth("BTC");
  await pushOracle(EXISTING_BTC.baseToken, price);
  const alive = await marketAlive(EXISTING_BTC.market);
  listed.push({
    ...EXISTING_BTC,
    priceUsd: price,
    active: alive,
    chartSymbol: BINANCE.BTC,
  });
  console.log("  market", EXISTING_BTC.market, "active=", alive, "px=", price);
}

// --- ETH / SOL new ---
for (const sym of ["ETH", "SOL"]) {
  if (only && !only.includes(sym)) continue;
  console.log(`\n==> ${sym}`);
  const price = await fetchPyth(sym);
  console.log("  pyth", price);
  const baseToken = await deployBase(sym === "ETH" ? "Ether" : "Solana", sym);
  await pushOracle(baseToken, price);
  const routeId = await ensureRoute(baseToken);
  const m = await createActiveMarket(baseToken, routeId, sym);
  listed.push({
    symbol: sym,
    label: sym === "ETH" ? "Ethereum" : "Solana",
    market: m.market,
    marketId: m.marketId,
    baseToken,
    routeId,
    liquidityVault: m.liquidityVault,
    insuranceFund: m.insuranceFund,
    chartSymbol: BINANCE[sym],
    pyth: sym,
    source: "pyth-hermes",
    priceUsd: price,
    index: m.index,
    active: true,
  });
  console.log("  LIVE", m.market, "index", m.index);
}

// --- RATDOG (RH token mirror) if still active ---
if (!only || only.includes("RATDOG")) {
  console.log("\n==> RATDOG (Robinhood Dex token)");
  const alive = await marketAlive(EXISTING_RATDOG.market);
  let priceUsd = null;
  try {
    const dex = await fetchDexRobinhood(EXISTING_RATDOG.sourceCa);
    if (dex?.priceUsd) {
      priceUsd = dex.priceUsd;
      await pushOracle(EXISTING_RATDOG.baseToken, priceUsd, Math.max(1_000_000, dex.liquidityUsd || 0));
    }
  } catch (e) {
    console.log("  dex push skip", e.message);
  }
  listed.push({
    ...EXISTING_RATDOG,
    priceUsd,
    active: alive,
  });
  console.log("  market", EXISTING_RATDOG.market, "active=", alive);
}

const out = {
  chainId,
  factory: FACTORY,
  collateral: COLLATERAL,
  adapters: [ADAPTER_A, ADAPTER_B],
  generatedAt: new Date().toISOString(),
  markets: listed,
  note: "UI reads this via NEXT_PUBLIC or bundled listed-markets.json. Oracle loop pushes all pyth/dex assets.",
};

fs.mkdirSync("deployments", { recursive: true });
fs.writeFileSync("deployments/listed-markets.json", `${JSON.stringify(out, null, 2)}\n`);
console.log("\n==> wrote deployments/listed-markets.json");
console.log(JSON.stringify(out, null, 2));
