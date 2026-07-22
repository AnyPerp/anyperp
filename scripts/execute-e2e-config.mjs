/**
 * Executes pending AnyPerp timelock ops, then runs full market lifecycle:
 * create → validate → seed/LP → activate → long → short → extra LP.
 *
 * Prerequisites:
 * - deployments/pending-e2e-config.json
 * - DEPLOYER_PRIVATE_KEY with EXECUTOR_ROLE
 * - Timelock minDelay elapsed for each op
 */
import fs from "node:fs";
import "dotenv/config";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeAbiParameters,
  http,
  keccak256,
  parseUnits,
  stringToHex,
  zeroHash,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const privateKey = process.env.DEPLOYER_PRIVATE_KEY;
if (!privateKey?.startsWith("0x")) throw new Error("DEPLOYER_PRIVATE_KEY required");

const chain = defineChain({
  id: 46630,
  name: "Robinhood Chain Testnet",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [process.env.RPC_HTTP_URL ?? "https://rpc.testnet.chain.robinhood.com"] } },
});
const account = privateKeyToAccount(privateKey);
const publicClient = createPublicClient({ chain, transport: http(chain.rpcUrls.default.http[0]) });
const wallet = createWalletClient({ account, chain, transport: http(chain.rpcUrls.default.http[0]) });

function artifact(name) {
  return JSON.parse(fs.readFileSync(`contracts/out/${name}.json`, "utf8"));
}

function setEnv(key, value) {
  let env = fs.readFileSync(".env", "utf8");
  const re = new RegExp(`^${key}=.*$`, "m");
  if (re.test(env)) env = env.replace(re, `${key}=${value}`);
  else env += `\n${key}=${value}\n`;
  fs.writeFileSync(".env", env);
}

const tlAbi = artifact("GovernanceTimelock").abi;
const factoryAbi = artifact("MarketFactory").abi;
const marketAbi = artifact("Market").abi;
const vaultAbi = artifact("LiquidityVault").abi;
const tokenAbi = artifact("MockERC20").abi;
const oracleAbi = artifact("MockOracleAdapter").abi;

async function executeOp(timelock, op, label) {
  const opId =
    op.opId ??
    (await publicClient.readContract({
      address: timelock,
      abi: tlAbi,
      functionName: "hashOperation",
      args: [op.target, BigInt(op.value ?? 0), op.data, op.predecessor ?? zeroHash, op.salt],
    }));
  const done = await publicClient.readContract({
    address: timelock,
    abi: tlAbi,
    functionName: "isOperationDone",
    args: [opId],
  });
  if (done) {
    console.log(`SKIP ${label} (already executed)`);
    return;
  }
  const isReady = await publicClient.readContract({
    address: timelock,
    abi: tlAbi,
    functionName: "isOperationReady",
    args: [opId],
  });
  if (!isReady) {
    const ts = await publicClient.readContract({
      address: timelock,
      abi: tlAbi,
      functionName: "getTimestamp",
      args: [opId],
    });
    const now = Number((await publicClient.getBlock()).timestamp);
    throw new Error(`${label} not ready yet. wait ~${Number(ts) - now}s (readyAt=${ts})`);
  }
  const hash = await wallet.writeContract({
    address: timelock,
    abi: tlAbi,
    functionName: "execute",
    args: [op.target, BigInt(op.value ?? 0), op.data, op.predecessor ?? zeroHash, op.salt],
    account,
    chain,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${label} execute failed: ${hash}`);
  console.log(`EXEC ${label} tx=${hash} block=${receipt.blockNumber}`);
}

async function write(address, abi, functionName, args = []) {
  const hash = await wallet.writeContract({ address, abi, functionName, args, account, chain });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${functionName} reverted: ${hash}`);
  console.log(`OK ${functionName} ${hash}`);
  return receipt;
}

async function read(address, abi, functionName, args = []) {
  return publicClient.readContract({ address, abi, functionName, args });
}

const e2e = JSON.parse(fs.readFileSync("deployments/pending-e2e-config.json", "utf8"));

console.log("==> Executing AnyPerp governance config (order matters)");
for (const op of e2e.operations) {
  await executeOp(e2e.timelock, op, op.label);
}

const now = (await publicClient.getBlock()).timestamp;
for (const adapter of [e2e.adapterA, e2e.adapterB]) {
  await write(adapter, oracleAbi, "set", [
    e2e.baseToken,
    {
      priceWad: parseUnits("100", 18),
      confidenceBps: 20n,
      updatedAt: now,
      liquidityWad: parseUnits("5000000", 18),
      historySeconds: 2_592_000n,
      validSources: 1,
    },
  ]);
}

const routeId =
  e2e.routeId ||
  keccak256(
    encodeAbiParameters(
      [{ type: "uint256" }, { type: "address" }, { type: "address[]" }],
      [46630n, e2e.baseToken, [e2e.adapterA, e2e.adapterB]],
    ),
  );

const factory = e2e.factory;
const coll = e2e.collateral;
const bond = parseUnits("1000", 6);
const lpSeed = parseUnits("100000", 6);
const insuranceSeed = parseUnits("10000", 6);

const risk = {
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

console.log("==> mint mock apUSD (test faucet token)");
const mintAmount = parseUnits("500000", 6);
await write(coll, tokenAbi, "mint", [account.address, mintAmount]);

console.log("==> createMarket");
await write(coll, tokenAbi, "approve", [factory, bond + lpSeed + insuranceSeed + parseUnits("50000", 6)]);
const createParams = {
  baseToken: e2e.baseToken,
  collateralToken: coll,
  tier: 3,
  risk,
  oracleRouteId: routeId,
  creatorBond: bond,
  userSalt: keccak256(stringToHex(`anyperp-e2e-${Date.now()}`)),
};
const sim = await publicClient.simulateContract({
  account: account.address,
  address: factory,
  abi: factoryAbi,
  functionName: "createMarket",
  args: [createParams],
});
const [marketId, marketAddress] = sim.result;
await write(factory, factoryAbi, "createMarket", [createParams]);
const deployment = await read(factory, factoryAbi, "deployments", [marketId]);
const liquidityVault = deployment[2] ?? deployment.liquidityVault;
const insuranceFund = deployment[3] ?? deployment.insuranceFund;
console.log({ marketId, marketAddress, liquidityVault, insuranceFund });

console.log("==> validate + seed + activate");
await write(factory, factoryAbi, "validateMarket", [marketId]);
await write(coll, tokenAbi, "approve", [liquidityVault, lpSeed]);
await write(coll, tokenAbi, "approve", [insuranceFund, insuranceSeed]);
await write(factory, factoryAbi, "seedMarket", [marketId, lpSeed, insuranceSeed]);
await write(factory, factoryAbi, "activateMarket", [marketId]);
const state = await read(marketAddress, marketAbi, "state");
if (Number(state) !== 3) throw new Error(`market not Active: ${state}`);

const collateralVault = await read(marketAddress, marketAbi, "collateralVault");
const margin = parseUnits("5000", 6);

console.log("==> LONG");
await write(coll, tokenAbi, "approve", [collateralVault, margin * 4n]);
await write(marketAddress, marketAbi, "depositMargin", [margin]);
await write(marketAddress, marketAbi, "executeTrade", [
  parseUnits("10", 18),
  parseUnits("1000", 18),
  (await publicClient.getBlock()).timestamp + 600n,
]);
let pos = await read(marketAddress, marketAbi, "position", [account.address]);
if ((pos.sizeBaseWad ?? pos[0]) !== parseUnits("10", 18)) throw new Error("long size mismatch");
await write(marketAddress, marketAbi, "executeTrade", [
  -parseUnits("10", 18),
  1n,
  (await publicClient.getBlock()).timestamp + 600n,
]);
console.log("LONG closed");

console.log("==> SHORT");
await write(marketAddress, marketAbi, "depositMargin", [margin]);
await write(marketAddress, marketAbi, "executeTrade", [
  -parseUnits("10", 18),
  1n,
  (await publicClient.getBlock()).timestamp + 600n,
]);
pos = await read(marketAddress, marketAbi, "position", [account.address]);
if ((pos.sizeBaseWad ?? pos[0]) !== -parseUnits("10", 18)) throw new Error("short size mismatch");
await write(marketAddress, marketAbi, "executeTrade", [
  parseUnits("10", 18),
  parseUnits("1000", 18),
  (await publicClient.getBlock()).timestamp + 600n,
]);
console.log("SHORT closed");

// leave a small open long for demo board
await write(marketAddress, marketAbi, "depositMargin", [parseUnits("2000", 6)]);
await write(marketAddress, marketAbi, "executeTrade", [
  parseUnits("2", 18),
  parseUnits("1000", 18),
  (await publicClient.getBlock()).timestamp + 600n,
]);
console.log("DEMO long left open size=2");

try {
  const extra = parseUnits("1000", 6);
  await write(coll, tokenAbi, "approve", [liquidityVault, extra]);
  await write(liquidityVault, vaultAbi, "deposit", [extra, account.address]);
  console.log("EXTRA LP deposit OK");
} catch (error) {
  console.log(`EXTRA LP deposit note: ${error.shortMessage ?? error.message}`);
}

setEnv("NEXT_PUBLIC_DEMO_MARKET_ADDRESS", marketAddress);
setEnv("NEXT_PUBLIC_DEMO_MARKET_ID", marketId);
setEnv("NEXT_PUBLIC_DEMO_BASE_TOKEN", e2e.baseToken);
setEnv("NEXT_PUBLIC_DEMO_ORACLE_ROUTE_ID", routeId);
setEnv("NEXT_PUBLIC_DEMO_LIQUIDITY_VAULT", liquidityVault);
setEnv("NEXT_PUBLIC_DEMO_INSURANCE_FUND", insuranceFund);

const report = {
  status: "pass",
  brand: "AnyPerp",
  domain: "https://anyperp.fun",
  chainId: 46630,
  marketId,
  market: marketAddress,
  routeId,
  liquidityVault,
  insuranceFund,
  collateral: coll,
  baseToken: e2e.baseToken,
  factory,
  generatedAt: new Date().toISOString(),
};
fs.mkdirSync("build", { recursive: true });
fs.writeFileSync("build/testnet-e2e-lifecycle.json", `${JSON.stringify(report, null, 2)}\n`);
fs.writeFileSync("deployments/live-demo-market.json", `${JSON.stringify({ ...report, howToTest: [
  "Connect wallet to Robinhood Chain Testnet (46630)",
  "Open app → Trade → Mint 50k mock USD",
  "Approve + deposit margin, then long/short",
  "Liquidity tab → Add LP",
] }, null, 2)}\n`);
console.log("ANYPERP TESTNET E2E PASS", JSON.stringify(report, null, 2));
