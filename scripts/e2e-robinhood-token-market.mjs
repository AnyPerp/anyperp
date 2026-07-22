#!/usr/bin/env node
/**
 * Full E2E: DexScreener Robinhood token → testnet market → LP → long/short
 *
 * DexScreener "robinhood" CAs usually have no bytecode on RHC *testnet*, so we:
 *  1) pick a live Robinhood listing from DexScreener
 *  2) deploy a testnet MockERC20 "mirror" with the same symbol
 *  3) push Dex price into mock oracle adapters
 *  4) createRoute (public) + createMarket + seed + activate
 *  5) open long then close / short
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

function artifact(name) {
  return JSON.parse(fs.readFileSync(`contracts/out/${name}.json`, "utf8"));
}

async function nextNonce() {
  return publicClient.getTransactionCount({ address: account.address, blockTag: "pending" });
}

async function write(address, abi, functionName, args = []) {
  const nonce = await nextNonce();
  const hash = await wallet.writeContract({ address, abi, functionName, args, account, chain, nonce });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${functionName} reverted ${hash}`);
  console.log(`OK ${functionName} ${hash}`);
  return { hash, receipt };
}

async function pickRobinhoodToken() {
  const res = await fetch("https://api.dexscreener.com/token-profiles/latest/v1");
  const profiles = await res.json();
  const rh = (Array.isArray(profiles) ? profiles : []).filter((p) => p.chainId === "robinhood");
  let best = null;
  for (const p of rh.slice(0, 15)) {
    const pr = await fetch(`https://api.dexscreener.com/token-pairs/v1/robinhood/${p.tokenAddress}`);
    const pairs = await pr.json();
    const pair = Array.isArray(pairs) ? pairs[0] : null;
    if (!pair?.priceUsd || !pair.baseToken?.symbol) continue;
    const liq = Number(pair.liquidity?.usd || 0);
    const row = {
      sourceCa: p.tokenAddress,
      symbol: String(pair.baseToken.symbol).slice(0, 12),
      name: String(pair.baseToken.name || pair.baseToken.symbol).slice(0, 32),
      priceUsd: Number(pair.priceUsd),
      liquidityUsd: liq,
      marketCap: pair.marketCap != null ? Number(pair.marketCap) : null,
      url: pair.url || p.url,
    };
    if (!best || row.liquidityUsd > best.liquidityUsd) best = row;
  }
  if (!best) throw new Error("No Robinhood token found on DexScreener");
  return best;
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
  // For micro-priced memes, keep stress high but size tiny when trading
  longPayoutStressBps: 90_000n,
  shortPayoutStressBps: 10_000n,
  fundingVelocityWad: 1_000_000_000_000n,
  maxFundingRatePerSecondWad: 1_000_000_000_000n,
  maxFundingAccrualSeconds: 3_600n,
};

console.log("==> Pick DexScreener Robinhood token");
const token = await pickRobinhoodToken();
console.log(JSON.stringify(token, null, 2));

console.log("==> Deploy testnet mirror ERC20 for", token.symbol);
const mockArt = artifact("MockERC20");
const deployHash = await wallet.deployContract({
  abi: mockArt.abi,
  bytecode: `0x${mockArt.evm.bytecode.object}`,
  args: [`AnyPerp ${token.name}`, token.symbol, 18],
  account,
  chain,
  nonce: await nextNonce(),
});
const deployReceipt = await publicClient.waitForTransactionReceipt({ hash: deployHash });
if (!deployReceipt.contractAddress) throw new Error("base token deploy failed");
const baseToken = deployReceipt.contractAddress;
console.log("mirror baseToken", baseToken, "(source CA", token.sourceCa, "not on testnet)");

// Mint mirror is not needed for trading (perp doesn't need base inventory); oracle only needs address.

console.log("==> Push DexScreener price into mock oracles");
const price = token.priceUsd > 0 ? token.priceUsd : 0.0001;
// Avoid scientific notation / precision issues for micro prices
const priceStr = price >= 1 ? price.toFixed(8) : price.toFixed(18);
const block = await publicClient.getBlock();
const priceData = {
  priceWad: parseUnits(priceStr, 18),
  confidenceBps: 20n,
  updatedAt: block.timestamp,
  liquidityWad: parseUnits(String(Math.max(1_000_000, Math.floor(token.liquidityUsd || 0))), 18),
  historySeconds: 2_592_000n,
  validSources: 1,
};
const mockOracleAbi = artifact("MockOracleAdapter").abi;
for (const adapter of [ADAPTER_A, ADAPTER_B]) {
  await write(adapter, mockOracleAbi, "set", [baseToken, priceData]);
}

console.log("==> createRoute (public)");
const routerAbi = artifact("OracleRouter").abi;
let routeId;
try {
  const sim = await publicClient.simulateContract({
    account,
    address: ORACLE_ROUTER,
    abi: routerAbi,
    functionName: "createRoute",
    args: [baseToken, [ADAPTER_A, ADAPTER_B]],
  });
  routeId = sim.result;
  await write(ORACLE_ROUTER, routerAbi, "createRoute", [baseToken, [ADAPTER_A, ADAPTER_B]]);
} catch (e) {
  // maybe exists
  routeId = keccak256(
    encodeAbiParameters(
      [{ type: "uint256" }, { type: "address" }, { type: "address[]" }],
      [BigInt(chainId), baseToken, [ADAPTER_A, ADAPTER_B]],
    ),
  );
  console.log("createRoute note:", e.shortMessage || e.message, "using", routeId);
}

console.log("routeId", routeId);

// Fund creator with collateral
const erc20Abi = artifact("MockERC20").abi;
const mintAmt = parseUnits("500000", 6);
await write(COLLATERAL, erc20Abi, "mint", [account.address, mintAmt]);

const factoryAbi = artifact("MarketFactory").abi;
const bond = parseUnits("1000", 6);
const lp = parseUnits("100000", 6);
const ins = parseUnits("10000", 6);

console.log("==> createMarket lifecycle");
await write(COLLATERAL, erc20Abi, "approve", [FACTORY, bond]);
const salt = keccak256(stringToHex(`rh-token:${token.symbol}:${Date.now()}`));
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
console.log("market", marketAddress, "id", marketId);

await write(FACTORY, factoryAbi, "validateMarket", [marketId]);
const deployment = await publicClient.readContract({
  address: FACTORY,
  abi: factoryAbi,
  functionName: "deployments",
  args: [marketId],
});
// deployment: market, collateralVault, liquidityVault, insuranceFund, ...
const liqVault = deployment[2];
const insuranceFund = deployment[3];
await write(COLLATERAL, erc20Abi, "approve", [liqVault, lp]);
await write(COLLATERAL, erc20Abi, "approve", [insuranceFund, ins]);
await write(FACTORY, factoryAbi, "seedMarket", [marketId, lp, ins]);
await write(FACTORY, factoryAbi, "activateMarket", [marketId]);

const marketAbi = artifact("Market").abi;
const index = await publicClient.readContract({ address: marketAddress, abi: marketAbi, functionName: "indexPrice" });
console.log("index", formatUnits(index, 18));

// Margin + trade — size scaled for micro price so notional is small but util-safe
// notional = size * price; stress long 9x; util limit ~ 90k
// use size that gives notional ~ $2000 → size = 2000/price
const targetNotional = 500; // USD
const sizeFloat = Math.min(1_000_000, Math.max(1, targetNotional / price));
const sizeWad = parseUnits(sizeFloat.toFixed(6), 18);
const limitLong = parseUnits((price * 1.05).toFixed(18), 18);
const limitShort = parseUnits(Math.max(price * 0.95, price * 1e-12).toFixed(18), 18);
const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);

console.log("==> deposit margin + long");
const margin = parseUnits("20000", 6);
await write(COLLATERAL, erc20Abi, "approve", [deployment[1], margin]); // collateral vault
await write(marketAddress, marketAbi, "depositMargin", [margin]);
await write(marketAddress, marketAbi, "executeTrade", [sizeWad, limitLong, deadline]);
let pos = await publicClient.readContract({
  address: marketAddress,
  abi: marketAbi,
  functionName: "position",
  args: [account.address],
});
console.log("after long size", formatUnits(pos.sizeBaseWad, 18), "entry", formatUnits(pos.entryPriceWad, 18));

console.log("==> close long / open short");
// close long
await write(marketAddress, marketAbi, "executeTrade", [-pos.sizeBaseWad, 1n, deadline + 60n]);
// open short
await write(marketAddress, marketAbi, "executeTrade", [-sizeWad / 2n, limitShort, deadline + 120n]);
pos = await publicClient.readContract({
  address: marketAddress,
  abi: marketAbi,
  functionName: "position",
  args: [account.address],
});
console.log("after short size", formatUnits(pos.sizeBaseWad, 18));

// close short flat
if (pos.sizeBaseWad !== 0n) {
  const closeLimit = parseUnits((price * 1.1).toFixed(18), 18); // buy back short: sizeDelta>0, exec <= limit
  await write(marketAddress, marketAbi, "executeTrade", [-pos.sizeBaseWad, closeLimit, deadline + 180n]);
}
pos = await publicClient.readContract({
  address: marketAddress,
  abi: marketAbi,
  functionName: "position",
  args: [account.address],
});

const out = {
  status: "pass",
  source: "dexscreener",
  chain: "robinhood",
  sourceToken: token,
  testnetMirrorBase: baseToken,
  routeId,
  marketId,
  market: marketAddress,
  liquidityVault: liqVault,
  insuranceFund,
  collateral: COLLATERAL,
  index: formatUnits(index, 18),
  finalPosition: formatUnits(pos.sizeBaseWad, 18),
  tradeSizeBase: sizeFloat,
  generatedAt: new Date().toISOString(),
};
fs.mkdirSync("deployments", { recursive: true });
fs.writeFileSync("deployments/e2e-robinhood-token-market.json", `${JSON.stringify(out, null, 2)}\n`);
console.log("\n==> E2E PASS");
console.log(JSON.stringify(out, null, 2));
