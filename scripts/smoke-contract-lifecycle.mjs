import fs from "node:fs";
import path from "node:path";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  keccak256,
  parseEther,
  parseUnits,
  stringToHex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

// Public Ganache deterministic accounts. Never use these keys outside a disposable local chain.
const LOCAL_KEYS = [
  "0x4f3edf983ac636a65a842ce7c78d9aa706d3b113bce9c46f30d7d21715b23b1d",
  "0x6cbed15c793ce57650b9877cf6fa156fbef513c4e6134f022a85b1ffdd59b2a1",
  "0x6370fd033278c143179d81c5526140625662b8daa446c22ee2d73db3707e620c",
  "0x646f1ce2fdad0e6deeeb5c7e8e5543bdde65e86029e2fd9fc169899c440a7913",
  "0xadd53f9a7e588d003326d1cbf9e4a43c061aadd9bc938c843a79e7b4fd2ad743",
];

const rpcUrl = process.env.SMOKE_RPC_URL ?? "http://127.0.0.1:8545";
const chain = defineChain({
  id: 31337,
  name: "Disposable AnyPerp Smoke Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [rpcUrl] } },
});
const accounts = LOCAL_KEYS.map((key) => privateKeyToAccount(key));
const [governance, longTrader, shortTrader, triggerTrader, liquidationTrader] = accounts;
const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
const wallets = new Map(accounts.map((account) => [account.address, createWalletClient({ account, chain, transport: http(rpcUrl) })]));
const steps = [];
const failures = [];

function artifact(name) {
  return JSON.parse(fs.readFileSync(path.join("contracts", "out", `${name}.json`), "utf8"));
}

function record(name, detail = "ok") {
  steps.push({ name, status: "pass", detail });
  console.log(`PASS ${name}${detail === "ok" ? "" : ` — ${detail}`}`);
}

async function shouldSucceed(name, action) {
  try {
    await action();
    record(name);
  } catch (error) {
    const detail = error instanceof Error ? error.shortMessage ?? error.message : String(error);
    failures.push({ name, detail });
    console.log(`FAIL ${name} — ${detail}`);
  }
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
  if (receipt.status !== "success" || !receipt.contractAddress) {
    throw new Error(`${name} deployment failed: hash=${hash} status=${receipt.status} gasUsed=${receipt.gasUsed}`);
  }
  return { address: receipt.contractAddress, abi: compiled.abi };
}

async function write(account, contract, functionName, args = [], value) {
  const wallet = wallets.get(account.address);
  const hash = await wallet.writeContract({
    address: contract.address,
    abi: contract.abi,
    functionName,
    args,
    value,
    account,
    chain,
    gas: 100_000_000n,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${functionName} reverted: ${hash}`);
  return receipt;
}

async function read(contract, functionName, args = []) {
  return publicClient.readContract({ address: contract.address, abi: contract.abi, functionName, args });
}

async function expectRevert(name, account, contract, functionName, args = [], value) {
  try {
    await publicClient.simulateContract({
      address: contract.address,
      abi: contract.abi,
      functionName,
      args,
      value,
      account,
    });
  } catch {
    record(name, "reverted as required");
    return;
  }
  throw new Error(`${name}: expected revert but simulation succeeded`);
}

async function increaseTime(seconds) {
  await publicClient.request({ method: "evm_increaseTime", params: [seconds] });
  await publicClient.request({ method: "evm_mine", params: [] });
}

async function now() {
  return (await publicClient.getBlock()).timestamp;
}

async function setPrice(adapters, base, price) {
  for (const adapter of adapters) {
    await write(governance, adapter, "set", [base.address, {
      priceWad: parseUnits(String(price), 18),
      confidenceBps: 20n,
      updatedAt: await now(),
      liquidityWad: parseUnits("5000000", 18),
      historySeconds: 2_592_000n,
      validSources: 1,
    }]);
  }
}

async function approve(account, token, spender, amount) {
  await write(account, token, "approve", [spender, amount]);
}

async function position(market, account) {
  const value = await read(market, "position", [account.address]);
  return {
    size: value.sizeBaseWad ?? value[0],
    entry: value.entryPriceWad ?? value[1],
    margin: value.marginWad ?? value[2],
    funding: value.fundingCheckpointWad ?? value[3],
    modified: value.lastModified ?? value[4],
  };
}

const chainId = await publicClient.getChainId();
if (chainId !== 31337) throw new Error(`Smoke test refuses chain ${chainId}; expected disposable chain 31337`);
record("local chain guard", `chain ${chainId}`);

for (const name of ["MarketFactory", "Market", "MarketDeployer", "VaultDeployer", "LiquidityVault"]) {
  const bytes = artifact(name).evm.deployedBytecode.object.length / 2;
  if (bytes > 24_576) throw new Error(`${name} exceeds EIP-170 runtime limit: ${bytes}`);
}
record("standard EVM code-size limits", "factory, implementation, deployers, and vault fit EIP-170");

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
const marketDeployer = await deploy("MarketDeployer", [governance.address, governance.address, marketImplementation.address]);
const collateral = await deploy("MockERC20", ["Smoke USD", "sUSD", 6]);
const base = await deploy("MockERC20", ["Smoke Token", "SMOKE", 18]);
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
record("deploy protocol", "factory, registry, market dependencies, mocks");

await write(governance, registry, "setFactory", [factory.address]);
await write(governance, vaultDeployer, "setFactory", [factory.address]);
await write(governance, marketDeployer, "setFactory", [factory.address]);
await write(governance, factory, "setSupportedCollateral", [collateral.address, true]);
const sourceFamilyA = keccak256(stringToHex("MOCK_SOURCE_A"));
const sourceFamilyB = keccak256(stringToHex("MOCK_SOURCE_B"));
await write(governance, oracleRouter, "setAdapter", [adapter.address, true, sourceFamilyA, true]);
await write(governance, oracleRouter, "setAdapter", [adapterTwo.address, true, sourceFamilyA, false]);
await expectRevert(
  "reject economically correlated oracle sources",
  governance,
  oracleRouter,
  "createRoute",
  [base.address, [adapter.address, adapterTwo.address]],
);
await write(governance, oracleRouter, "setAdapter", [adapterTwo.address, true, sourceFamilyB, false]);
await setPrice([adapter, adapterTwo], base, 100);

const singleRouteSimulation = await publicClient.simulateContract({
  address: oracleRouter.address,
  abi: oracleRouter.abi,
  functionName: "createRoute",
  args: [base.address, [adapter.address]],
  account: governance,
});
const singleRouteId = singleRouteSimulation.result;
await write(governance, oracleRouter, "createRoute", [base.address, [adapter.address]]);

const routeSimulation = await publicClient.simulateContract({
  address: oracleRouter.address,
  abi: oracleRouter.abi,
  functionName: "createRoute",
  args: [base.address, [adapter.address, adapterTwo.address]],
  account: governance,
});
const routeId = routeSimulation.result;
await write(governance, oracleRouter, "createRoute", [base.address, [adapter.address, adapterTwo.address]]);

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
await write(governance, riskManager, "setEnvelope", [3, risk]);
await shouldSucceed("single-source oracle route validates", () => read(oracleRouter, "validate", [singleRouteId, { ...risk, minOracleSources: 1 }]));
const oracleProbe = await read(oracleRouter, "getPrice", [routeId]);
const chainTimeProbe = await now();
const oracleUpdatedAt = oracleProbe.updatedAt ?? oracleProbe[2];
if (chainTimeProbe < oracleUpdatedAt || chainTimeProbe - oracleUpdatedAt > risk.oracleMaxAge) {
  throw new Error(`oracle freshness probe failed: chain=${chainTimeProbe} updatedAt=${oracleUpdatedAt}`);
}
record("configure admission", "collateral, oracle route, experimental risk envelope");

for (const account of accounts) await write(governance, collateral, "mint", [account.address, parseUnits("2000000", 6)]);
await approve(governance, collateral, factory.address, parseUnits("2000000", 6));

const createParams = {
  baseToken: base.address,
  collateralToken: collateral.address,
  tier: 3,
  risk,
  oracleRouteId: routeId,
  creatorBond: parseUnits("1000", 6),
  userSalt: keccak256(stringToHex("anyperp-smoke-market-v1")),
};
const createSimulation = await publicClient.simulateContract({
  address: factory.address,
  abi: factory.abi,
  functionName: "createMarket",
  args: [createParams],
  account: governance,
});
const [marketId, marketAddress] = createSimulation.result;
await write(governance, factory, "createMarket", [createParams]);
const deployment = await read(factory, "deployments", [marketId]);
const market = { address: marketAddress, abi: artifact("Market").abi };
const liquidityVault = { address: deployment[2], abi: artifact("LiquidityVault").abi };
const insuranceFund = { address: deployment[3], abi: artifact("MarketInsuranceFund").abi };
if ((await read(market, "state")) !== 1) throw new Error("market did not start PendingValidation");
record("create market", marketAddress);
await expectRevert("reject duplicate market", governance, factory, "createMarket", [createParams]);

await write(governance, factory, "validateMarket", [marketId]);
if ((await read(market, "state")) !== 2) throw new Error("market did not enter Bootstrapping");
record("validate market", "PendingValidation → Bootstrapping");

await approve(governance, collateral, liquidityVault.address, parseUnits("200000", 6));
await approve(governance, collateral, insuranceFund.address, parseUnits("10000", 6));
await write(governance, factory, "seedMarket", [marketId, parseUnits("200000", 6), parseUnits("10000", 6)]);
await write(governance, factory, "activateMarket", [marketId]);
if ((await read(market, "state")) !== 3) throw new Error("market did not become Active");
record("seed and activate", "isolated LP and insurance minimums funded");

const lpShares = await read(liquidityVault, "balanceOf", [governance.address]);
const queuedShares = lpShares / 100n;
await write(governance, liquidityVault, "requestWithdraw", [queuedShares]);
await expectRevert("enforce LP withdrawal delay", governance, liquidityVault, "executeWithdraw", [1n]);
await increaseTime(61);
await write(governance, liquidityVault, "executeWithdraw", [1n]);
record("LP deposit and queued withdrawal", "request → delay → execute");

const collateralVaultAddress = await read(market, "collateralVault");
for (const account of [longTrader, shortTrader, triggerTrader, liquidationTrader]) {
  await approve(account, collateral, collateralVaultAddress, parseUnits("2000000", 6));
}

await write(longTrader, market, "depositMargin", [parseUnits("50000", 6)]);
await expectRevert(
  "reject trade above stressed utilization",
  longTrader,
  market,
  "executeTrade",
  [parseUnits("500", 18), parseUnits("1000", 18), (await now()) + 600n],
);
const lossBudget = await read(market, "lossBudgetCapacityRaw");
const lpAssets = await read(liquidityVault, "totalAssets");
const insuranceBal = await read(insuranceFund, "balance");
if (lossBudget === 0n) throw new Error("lossBudgetCapacityRaw is zero after seed");
if (lossBudget < lpAssets + insuranceBal) throw new Error("loss budget undercounts LP+insurance");
record(
  "loss budget capacity",
  `budget=${lossBudget} lp=${lpAssets} insurance=${insuranceBal}`,
);
// Deploy lens and read full snapshot (UI path).
const marketLens = await deploy("MarketLens");
const snap = await read(marketLens, "solvencySnapshot", [market.address]);
const maxAddLong = snap.maxAdditionalLongBaseWad ?? snap[11];
if (maxAddLong === 0n) throw new Error("MarketLens maxAdditionalLongBaseWad should be positive after seed");
record("market lens snapshot", `maxAddLongBase=${maxAddLong} requiredReserve=${snap.requiredReserveRaw ?? snap[6]}`);
await write(longTrader, market, "withdrawMargin", [parseUnits("50000", 6)]);

await write(longTrader, market, "depositMargin", [parseUnits("5000", 6)]);
await write(longTrader, market, "executeTrade", [parseUnits("10", 18), parseUnits("1000", 18), (await now()) + 600n]);
if ((await position(market, longTrader)).size !== parseUnits("10", 18)) throw new Error("long position size mismatch");
await setPrice([adapter, adapterTwo], base, 110);
await write(longTrader, market, "executeTrade", [-parseUnits("10", 18), 1n, (await now()) + 600n]);
const longClosed = await position(market, longTrader);
if (longClosed.size !== 0n || longClosed.margin <= parseUnits("5000", 18)) throw new Error("profitable long did not close correctly");
record("long trade lifecycle", "deposit → open → profitable close");

await setPrice([adapter, adapterTwo], base, 100);
await write(shortTrader, market, "depositMargin", [parseUnits("5000", 6)]);
await write(shortTrader, market, "executeTrade", [-parseUnits("10", 18), 1n, (await now()) + 600n]);
await setPrice([adapter, adapterTwo], base, 90);
await write(shortTrader, market, "executeTrade", [parseUnits("10", 18), parseUnits("1000", 18), (await now()) + 600n]);
const shortClosed = await position(market, shortTrader);
if (shortClosed.size !== 0n || shortClosed.margin <= parseUnits("5000", 18)) throw new Error("profitable short did not close correctly");
record("short trade lifecycle", "deposit → open → profitable close");

await setPrice([adapter, adapterTwo], base, 100);
await write(triggerTrader, market, "depositMargin", [parseUnits("2000", 6)]);
await write(triggerTrader, triggerManager, "placeTriggerOrder", [market.address, parseUnits("1", 18), parseUnits("101", 18), parseUnits("110", 18), (await now()) + 3600n, 0], parseEther("0.001"));
await write(liquidationTrader, triggerManager, "executeTriggerOrder", [1n]);
if ((await position(market, triggerTrader)).size !== parseUnits("1", 18)) throw new Error("trigger order did not open position");
await write(triggerTrader, market, "executeTrade", [-parseUnits("1", 18), 1n, (await now()) + 600n]);
await write(triggerTrader, triggerManager, "placeTriggerOrder", [market.address, parseUnits("1", 18), parseUnits("50", 18), parseUnits("110", 18), (await now()) + 3600n, 0], parseEther("0.001"));
await write(triggerTrader, triggerManager, "cancelTriggerOrder", [2n]);
record("trigger orders", "place → execute and place → cancel");

await write(longTrader, market, "executeTrade", [parseUnits("2", 18), parseUnits("1000", 18), (await now()) + 600n]);
await increaseTime(3600);
await write(liquidationTrader, market, "updateFunding");
if ((await read(market, "cumulativeFundingPerBaseWad")) === 0n) throw new Error("funding index did not change");
await write(longTrader, market, "executeTrade", [-parseUnits("2", 18), 1n, (await now()) + 600n]);
if ((await read(market, "fundingPoolWad")) === 0n) throw new Error("collected funding was not reserved");
record("funding update and settlement", "skewed market produced a non-zero cumulative index");

const fundingCheckpointBefore = await read(market, "lastFundingTime");
for (const source of [adapter, adapterTwo]) {
  await write(governance, source, "set", [base.address, {
    priceWad: parseUnits("100", 18), confidenceBps: 20n, updatedAt: 1n,
    liquidityWad: parseUnits("5000000", 18), historySeconds: 2_592_000n, validSources: 1,
  }]);
}
await increaseTime(120);
await write(liquidationTrader, market, "updateFunding");
if ((await read(market, "lastFundingTime")) <= fundingCheckpointBefore) throw new Error("invalid funding interval was not checkpointed");
await setPrice([adapter, adapterTwo], base, 100);
record("oracle-outage funding checkpoint", "invalid interval skipped instead of retroactively charged");

await setPrice([adapter, adapterTwo], base, 100);
await write(liquidationTrader, market, "depositMargin", [parseUnits("100", 6)]);
await write(liquidationTrader, market, "executeTrade", [parseUnits("5", 18), parseUnits("1000", 18), (await now()) + 600n]);
await setPrice([adapter, adapterTwo], base, 75);
const equityBeforeLiquidation = await read(market, "accountEquityWad", [liquidationTrader.address]);
if (equityBeforeLiquidation >= 0n) throw new Error("liquidation scenario did not reach negative equity");
await write(shortTrader, liquidationEngine, "liquidate", [market.address, liquidationTrader.address, parseUnits("1000000", 18)]);
if ((await position(market, liquidationTrader)).size !== 0n) throw new Error("liquidation did not fully close negative-equity position");
record("liquidation and bad-debt path", "negative equity → full liquidation");

await setPrice([adapter, adapterTwo], base, 100);
await write(liquidationTrader, market, "depositMargin", [parseUnits("2200", 6)]);
await write(liquidationTrader, market, "executeTrade", [parseUnits("190", 18), parseUnits("1000", 18), (await now()) + 600n]);
await setPrice([adapter, adapterTwo], base, 1);
await write(shortTrader, liquidationEngine, "liquidate", [market.address, liquidationTrader.address, parseUnits("1000000", 18)]);
const insuranceAfterWaterfall = await read(collateral, "balanceOf", [insuranceFund.address]);
const badDebtAfterWaterfall = await read(market, "badDebtWad");
if (insuranceAfterWaterfall !== 0n || badDebtAfterWaterfall === 0n) throw new Error("insurance exhaustion did not record bad debt");
record("insurance exhaustion and bad debt", "market insurance depleted before bad debt was recorded");

await increaseTime(30 * 24 * 60 * 60 + 1);
await setPrice([adapter, adapterTwo], base, 100);
await write(governance, factory, "claimCreatorBond", [marketId]);
record("creator bond unlock", "active market + 30-day lock");

await write(triggerTrader, market, "executeTrade", [parseUnits("2", 18), parseUnits("1000", 18), (await now()) + 600n]);
await write(governance, guardian, "setReduceOnly", [market.address, keccak256(stringToHex("SMOKE_REDUCE_ONLY"))]);
await expectRevert("block position increase in reduce-only", triggerTrader, market, "executeTrade", [parseUnits("1", 18), parseUnits("1000", 18), (await now()) + 600n]);
await write(triggerTrader, market, "executeTrade", [-parseUnits("1", 18), 1n, (await now()) + 600n]);
record("reduce-only controls", "increase blocked; reduction allowed");

await write(governance, guardian, "pauseMarket", [market.address, keccak256(stringToHex("SMOKE_PAUSE"))]);
await expectRevert("block trades while paused", triggerTrader, market, "executeTrade", [-parseUnits("1", 18), 1n, (await now()) + 600n]);
await write(governance, market, "beginSettlement", [keccak256(stringToHex("SMOKE_SETTLEMENT"))]);
await expectRevert("block settlement claims before final price", triggerTrader, market, "claimSettlement");
await expectRevert("enforce settlement dispute window", governance, market, "finalizeSettlement");
await increaseTime(86_401);
await write(governance, market, "finalizeSettlement");
if ((await read(market, "state")) !== 7) throw new Error("market did not close after settlement");
await write(triggerTrader, market, "claimSettlement");
if ((await position(market, triggerTrader)).size !== 0n) throw new Error("settlement claim did not close position");
await expectRevert("block deposits after close", triggerTrader, market, "depositMargin", [parseUnits("1", 6)]);
record("pause and settlement", "pause → settling → dispute delay → finalize price → claim → closed");

for (const account of [longTrader, shortTrader, triggerTrader]) {
  const current = await position(market, account);
  const raw = current.margin / 1_000_000_000_000n;
  if (raw > 0n) await write(account, market, "withdrawMargin", [raw]);
}
record("margin withdrawal", "closed traders withdrew available collateral");

const final = {
  status: failures.length === 0 ? "pass" : "fail",
  chainId,
  marketId,
  market: market.address,
  steps,
  failures,
  state: Number(await read(market, "state")),
  longOpenInterestBaseWad: String(await read(market, "longOpenInterestBaseWad")),
  shortOpenInterestBaseWad: String(await read(market, "shortOpenInterestBaseWad")),
  badDebtWad: String(await read(market, "badDebtWad")),
  generatedAt: new Date().toISOString(),
};
if (final.longOpenInterestBaseWad !== "0" || final.shortOpenInterestBaseWad !== "0") throw new Error("open interest did not reconcile to zero");
fs.mkdirSync("build", { recursive: true });
fs.writeFileSync(path.join("build", "smoke-contract-lifecycle.json"), `${JSON.stringify(final, null, 2)}\n`);
console.log(`SMOKE PASS ${steps.length} checks; report build/smoke-contract-lifecycle.json`);
if (failures.length > 0) {
  console.log(`SMOKE FAIL ${failures.length} known issue(s); see report`);
  process.exitCode = 1;
}
