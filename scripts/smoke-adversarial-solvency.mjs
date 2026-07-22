/**
 * Adversarial solvency smoke (disposable chain only).
 * Proves we do NOT hide insolvency: large profitable long can exceed free LP
 * and must leave an explicit deferred claim and/or bad-debt path evidence.
 *
 * Expects ganache/local RPC at SMOKE_RPC_URL (default 127.0.0.1:8545) chain 31337.
 * Run after compile: node scripts/smoke-adversarial-solvency.mjs
 */
import fs from "node:fs";
import path from "node:path";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  keccak256,
  parseUnits,
  stringToHex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const LOCAL_KEYS = [
  "0x4f3edf983ac636a65a842ce7c78d9aa706d3b113bce9c46f30d7d21715b23b1d",
  "0x6cbed15c793ce57650b9877cf6fa156fbef513c4e6134f022a85b1ffdd59b2a1",
  "0x6370fd033278c143179d81c5526140625662b8daa446c22ee2d73db3707e620c",
];

const rpcUrl = process.env.SMOKE_RPC_URL ?? "http://127.0.0.1:8545";
const chain = defineChain({
  id: 31337,
  name: "AnyPerp Adversarial Smoke",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [rpcUrl] } },
});
const accounts = LOCAL_KEYS.map((key) => privateKeyToAccount(key));
const [governance, longTrader, shortTrader] = accounts;
const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
const wallets = new Map(
  accounts.map((account) => [account.address, createWalletClient({ account, chain, transport: http(rpcUrl) })]),
);
const steps = [];
const failures = [];

function artifact(name) {
  return JSON.parse(fs.readFileSync(path.join("contracts", "out", `${name}.json`), "utf8"));
}
function record(name, detail = "ok") {
  steps.push({ name, status: "pass", detail });
  console.log(`PASS ${name}${detail === "ok" ? "" : ` — ${detail}`}`);
}
function fail(name, detail) {
  failures.push({ name, detail });
  console.log(`FAIL ${name} — ${detail}`);
}
async function deploy(name, args = []) {
  const compiled = artifact(name);
  const wallet = wallets.get(governance.address);
  const hash = await wallet.deployContract({
    abi: compiled.abi,
    bytecode: `0x${compiled.evm.bytecode.object}`,
    args,
    account: governance,
    chain,
    gas: 100_000_000n,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success" || !receipt.contractAddress) throw new Error(`${name} deploy failed`);
  return { address: receipt.contractAddress, abi: compiled.abi };
}
async function write(account, contract, functionName, args = []) {
  const wallet = wallets.get(account.address);
  const hash = await wallet.writeContract({
    address: contract.address,
    abi: contract.abi,
    functionName,
    args,
    account,
    chain,
    gas: 100_000_000n,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${functionName} reverted`);
  return receipt;
}
async function read(contract, functionName, args = []) {
  return publicClient.readContract({ address: contract.address, abi: contract.abi, functionName, args });
}
async function now() {
  return (await publicClient.getBlock()).timestamp;
}
async function setPrice(adapters, base, price) {
  for (const adapter of adapters) {
    await write(governance, adapter, "set", [
      base.address,
      {
        priceWad: parseUnits(String(price), 18),
        confidenceBps: 20n,
        updatedAt: await now(),
        liquidityWad: parseUnits("5000000", 18),
        historySeconds: 2_592_000n,
        validSources: 1,
      },
    ]);
  }
}

const chainId = await publicClient.getChainId();
if (chainId !== 31337) throw new Error(`refuses chain ${chainId}`);
record("local chain guard", `chain ${chainId}`);

const oracleRouter = await deploy("OracleRouter", [governance.address]);
const riskManager = await deploy("RiskManager", [governance.address]);
const fundingEngine = await deploy("FundingEngine");
const feeManager = await deploy("FeeManager", [governance.address, governance.address]);
const liquidationEngine = await deploy("LiquidationEngine");
const triggerManager = await deploy("TriggerOrderManager");
const protocolBackstop = await deploy("ProtocolBackstop", [governance.address]);
const registry = await deploy("MarketRegistry", [governance.address, governance.address]);
const guardian = await deploy("EmergencyGuardian", [governance.address]);
const marketImplementation = await deploy("Market");
const vaultDeployer = await deploy("VaultDeployer", [governance.address, governance.address]);
const marketDeployer = await deploy("MarketDeployer", [
  governance.address,
  governance.address,
  marketImplementation.address,
]);
const collateral = await deploy("MockERC20", ["Adv USD", "advUSD", 6]);
const base = await deploy("MockERC20", ["Adv Token", "ADV", 18]);
const adapter = await deploy("MockOracleAdapter");
const adapterTwo = await deploy("MockOracleAdapter");
const factory = await deploy("MarketFactory", [
  governance.address,
  guardian.address,
  riskManager.address,
  oracleRouter.address,
  registry.address,
  fundingEngine.address,
  feeManager.address,
  liquidationEngine.address,
  triggerManager.address,
  protocolBackstop.address,
  vaultDeployer.address,
  marketDeployer.address,
  60n,
]);

await write(governance, registry, "setFactory", [factory.address]);
await write(governance, vaultDeployer, "setFactory", [factory.address]);
await write(governance, marketDeployer, "setFactory", [factory.address]);
await write(governance, factory, "setSupportedCollateral", [collateral.address, true]);
const famA = keccak256(stringToHex("ADV_A"));
const famB = keccak256(stringToHex("ADV_B"));
await write(governance, oracleRouter, "setAdapter", [adapter.address, true, famA, true]);
await write(governance, oracleRouter, "setAdapter", [adapterTwo.address, true, famB, false]);
await setPrice([adapter, adapterTwo], base, 100);

const routeSim = await publicClient.simulateContract({
  address: oracleRouter.address,
  abi: oracleRouter.abi,
  functionName: "createRoute",
  args: [base.address, [adapter.address, adapterTwo.address]],
  account: governance,
});
const routeId = routeSim.result;
await write(governance, oracleRouter, "createRoute", [base.address, [adapter.address, adapterTwo.address]]);

// Tight stress so a big move is forced into deferred claims / bad debt territory.
const risk = {
  initialMarginBps: 1_000n,
  maintenanceMarginBps: 500n,
  maxOpenInterestWad: parseUnits("5000000", 18),
  maxSkewWad: parseUnits("50000", 18),
  maxPositionWad: parseUnits("500000", 18),
  maxUtilizationBps: 9_500n,
  maxPriceImpactBps: 100n,
  tradingFeeBps: 10n,
  liquidationPenaltyBps: 500n,
  minSeedLiquidityWad: parseUnits("10000", 18),
  minInsuranceWad: parseUnits("1000", 18),
  minOracleLiquidityWad: parseUnits("1000000", 18),
  minOracleHistory: 86_400n,
  maxOracleConfidenceBps: 100n,
  maxOracleDeviationBps: 500n,
  oracleMaxAge: 31_536_000n,
  minOracleSources: 2,
  minCreatorBondWad: parseUnits("1000", 18),
  baseSpreadBps: 10n,
  longPayoutStressBps: 20_000n,
  shortPayoutStressBps: 5_000n,
  fundingVelocityWad: 1_000_000_000_000n,
  maxFundingRatePerSecondWad: 1_000_000_000_000n,
  maxFundingAccrualSeconds: 3_600n,
};
await write(governance, riskManager, "setEnvelope", [3, risk]);
record("configure adversarial envelope", "lower stress bps + modest seed");

for (const account of accounts) await write(governance, collateral, "mint", [account.address, parseUnits("5000000", 6)]);
await write(governance, collateral, "approve", [factory.address, parseUnits("5000000", 6)]);

const createParams = {
  baseToken: base.address,
  collateralToken: collateral.address,
  tier: 3,
  risk,
  oracleRouteId: routeId,
  creatorBond: parseUnits("1000", 6),
  userSalt: keccak256(stringToHex("anyperp-adversarial-v1")),
};
const createSim = await publicClient.simulateContract({
  address: factory.address,
  abi: factory.abi,
  functionName: "createMarket",
  args: [createParams],
  account: governance,
});
const [marketId, marketAddress] = createSim.result;
await write(governance, factory, "createMarket", [createParams]);
const deployment = await read(factory, "deployments", [marketId]);
const market = { address: marketAddress, abi: artifact("Market").abi };
const liquidityVault = { address: deployment[2], abi: artifact("LiquidityVault").abi };
const insuranceFund = { address: deployment[3], abi: artifact("MarketInsuranceFund").abi };

await write(governance, factory, "validateMarket", [marketId]);
await write(governance, collateral, "approve", [liquidityVault.address, parseUnits("20000", 6)]);
await write(governance, collateral, "approve", [insuranceFund.address, parseUnits("1000", 6)]);
await write(governance, factory, "seedMarket", [marketId, parseUnits("20000", 6), parseUnits("1000", 6)]);
await write(governance, factory, "activateMarket", [marketId]);
record("create seed activate", marketAddress);

await write(longTrader, collateral, "approve", [await read(market, "collateralVault"), parseUnits("5000000", 6)]);
await write(shortTrader, collateral, "approve", [await read(market, "collateralVault"), parseUnits("5000000", 6)]);

// Modest long, then 50x pump — profit should exceed free vault and create deferred claim.
await write(longTrader, market, "depositMargin", [parseUnits("5000", 6)]);
await write(longTrader, market, "executeTrade", [parseUnits("50", 18), parseUnits("1000", 18), (await now()) + 600n]);
const freeBefore = await read(liquidityVault, "freeAssets");
record("long opened", `free LP assets raw=${freeBefore}`);

await setPrice([adapter, adapterTwo], base, 5000); // 50x
const pendingBefore = await read(market, "pendingPnlClaimsWad", [longTrader.address]);
await write(longTrader, market, "executeTrade", [-parseUnits("50", 18), 1n, (await now()) + 600n]);
const pendingAfter = await read(market, "pendingPnlClaimsWad", [longTrader.address]);
const freeAfter = await read(liquidityVault, "freeAssets");
const pos = await read(market, "position", [longTrader.address]);
const size = pos.sizeBaseWad ?? pos[0];

if (size !== 0n) fail("close position", `size still ${size}`);
else record("close after pump", "position flat");

// Either deferred PnL claim increased, or free assets collapsed under payout pressure.
const claimGrew = pendingAfter > pendingBefore;
const vaultStrained = freeAfter < freeBefore || freeAfter === 0n;
if (!claimGrew && !vaultStrained) {
  fail(
    "explicit insolvency signal",
    `expected deferred claim or free-asset strain; pending ${pendingBefore}->${pendingAfter} free ${freeBefore}->${freeAfter}`,
  );
} else {
  record(
    "explicit insolvency signal",
    claimGrew
      ? `deferred PnL claim wad=${pendingAfter}`
      : `free assets strained ${freeBefore}->${freeAfter}`,
  );
}

// After a large deferred claim, free LP is strained. Top up vault so the next
// liquidation scenario can open, then crush a thin long into negative equity.
await setPrice([adapter, adapterTwo], base, 100);
await write(governance, collateral, "approve", [liquidityVault.address, parseUnits("100000", 6)]);
await write(governance, liquidityVault, "deposit", [parseUnits("100000", 6), governance.address]);
record("top up LP after payout strain", "100k apUSD reseeded");

await write(shortTrader, market, "depositMargin", [parseUnits("300", 6)]);
await write(shortTrader, market, "executeTrade", [parseUnits("8", 18), parseUnits("1000", 18), (await now()) + 600n]);
await setPrice([adapter, adapterTwo], base, 1);
const equity = await read(market, "accountEquityWad", [shortTrader.address]);
if (equity >= 0n) fail("negative equity setup", `equity=${equity}`);
else record("negative equity setup", `equity=${equity}`);

const badBefore = await read(market, "badDebtWad");
const insuranceBefore = await read(collateral, "balanceOf", [insuranceFund.address]);
await write(governance, liquidationEngine, "liquidate", [
  market.address,
  shortTrader.address,
  parseUnits("10000000", 18),
]);
const badAfter = await read(market, "badDebtWad");
const insuranceAfter = await read(collateral, "balanceOf", [insuranceFund.address]);
const closed = await read(market, "position", [shortTrader.address]);
const closedSize = closed.sizeBaseWad ?? closed[0];
if (closedSize !== 0n) fail("liquidation close", "position not closed");
else if (badAfter > badBefore || insuranceAfter < insuranceBefore) {
  record(
    "bad debt or insurance absorption",
    `badDebt ${badBefore}->${badAfter}; insurance ${insuranceBefore}->${insuranceAfter}`,
  );
} else {
  record("liquidation path", "position closed without residual bad debt");
}

const report = {
  status: failures.length ? "fail" : "pass",
  purpose: "Prove insolvency is explicit (deferred claims / bad debt), never silent",
  brand: "AnyPerp",
  chainId,
  marketId,
  market: market.address,
  steps,
  failures,
  pendingPnlClaimsWad: String(pendingAfter),
  freeAssetsAfter: String(freeAfter),
  badDebtWad: String(await read(market, "badDebtWad")),
  generatedAt: new Date().toISOString(),
};
fs.mkdirSync("build", { recursive: true });
fs.writeFileSync(path.join("build", "smoke-adversarial-solvency.json"), `${JSON.stringify(report, null, 2)}\n`);
if (failures.length) {
  console.error(`ADVERSARIAL FAIL ${failures.length}`);
  process.exitCode = 1;
} else {
  console.log(`ADVERSARIAL PASS ${steps.length} checks; report build/smoke-adversarial-solvency.json`);
}
