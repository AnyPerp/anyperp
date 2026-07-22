/**
 * After protocol deploy: deploy mock base + dual mock oracles, schedule
 * timelock ops for collateral/envelope/adapters/route, write pending-e2e-config.json.
 *
 * Deployer must hold PROPOSER_ROLE (and usually EXECUTOR_ROLE) on the timelock.
 */
import fs from "node:fs";
import path from "node:path";
import "dotenv/config";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeFunctionData,
  http,
  isAddress,
  keccak256,
  parseUnits,
  stringToHex,
  zeroHash,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const chainId = Number(process.env.CHAIN_ID ?? 46630);
const rpcUrl = process.env.RPC_HTTP_URL ?? "https://rpc.testnet.chain.robinhood.com";
const chain = defineChain({
  id: chainId,
  name: "Robinhood Chain Testnet",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [rpcUrl] } },
});
const privateKey = process.env.DEPLOYER_PRIVATE_KEY;
if (!privateKey?.startsWith("0x")) throw new Error("DEPLOYER_PRIVATE_KEY required");
const account = privateKeyToAccount(privateKey);
const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
const wallet = createWalletClient({ account, chain, transport: http(rpcUrl) });

function artifact(name) {
  return JSON.parse(fs.readFileSync(path.join("contracts", "out", `${name}.json`), "utf8"));
}

function latestProtocolManifest() {
  const files = fs
    .readdirSync("deployments")
    .filter((f) => f.startsWith(`${chainId}-`) && f.endsWith(".json") && !f.includes("verification") && !f.includes("governance"))
    .sort();
  if (!files.length) throw new Error("No protocol deployment manifest found");
  return JSON.parse(fs.readFileSync(path.join("deployments", files.at(-1)), "utf8"));
}

async function deploy(name, args = []) {
  const value = artifact(name);
  const hash = await wallet.deployContract({
    abi: value.abi,
    bytecode: `0x${value.evm.bytecode.object}`,
    args,
    account,
    chain,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (!receipt.contractAddress || receipt.status !== "success") throw new Error(`${name} deploy failed ${hash}`);
  console.log(`DEPLOY ${name} ${receipt.contractAddress}`);
  return receipt.contractAddress;
}

async function write(address, abi, functionName, args = []) {
  const hash = await wallet.writeContract({ address, abi, functionName, args, account, chain });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${functionName} reverted ${hash}`);
  return hash;
}

const deployed = latestProtocolManifest();
const c = deployed.contracts;
const factory = c.MarketFactory.address;
const risk = c.RiskManager.address;
const oracle = c.OracleRouter.address;
const collateral = c.MockCollateral?.address;
const timelock = deployed.governance;
if (!isAddress(factory) || !isAddress(collateral) || !isAddress(timelock)) {
  throw new Error("Manifest missing factory/collateral/governance");
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

console.log("==> Deploy mock base + dual oracle adapters");
const baseToken = await deploy("MockERC20", ["AnyPerp Demo Base", "apBASE", 18]);
const adapterA = await deploy("MockOracleAdapter");
const adapterB = await deploy("MockOracleAdapter");

const famA = keccak256(stringToHex("ANYPERP_MOCK_A"));
const famB = keccak256(stringToHex("ANYPERP_MOCK_B"));
const routeId = keccak256(
  // Must match OracleRouter: keccak256(abi.encode(chainId, asset, adapters))
  // viem encodeAbiParameters mirrors abi.encode for these types
  (await import("viem")).encodeAbiParameters(
    [{ type: "uint256" }, { type: "address" }, { type: "address[]" }],
    [BigInt(chainId), baseToken, [adapterA, adapterB]],
  ),
);

const factoryAbi = artifact("MarketFactory").abi;
const riskAbi = artifact("RiskManager").abi;
const oracleAbi = artifact("OracleRouter").abi;
const tlAbi = artifact("GovernanceTimelock").abi;

const minDelay = await publicClient.readContract({
  address: timelock,
  abi: tlAbi,
  functionName: "getMinDelay",
});

const saltBase = BigInt(Date.now());
const ops = [
  {
    label: "setSupportedCollateral(apUSD)",
    target: factory,
    data: encodeFunctionData({
      abi: factoryAbi,
      functionName: "setSupportedCollateral",
      args: [collateral, true],
    }),
    salt: `0x${(saltBase + 1n).toString(16).padStart(64, "0")}`,
  },
  {
    label: "setEnvelope(experimental=3)",
    target: risk,
    data: encodeFunctionData({
      abi: riskAbi,
      functionName: "setEnvelope",
      args: [3, experimentalRisk],
    }),
    salt: `0x${(saltBase + 2n).toString(16).padStart(64, "0")}`,
  },
  {
    label: "setAdapter A",
    target: oracle,
    data: encodeFunctionData({
      abi: oracleAbi,
      functionName: "setAdapter",
      args: [adapterA, true, famA, true],
    }),
    salt: `0x${(saltBase + 3n).toString(16).padStart(64, "0")}`,
  },
  {
    label: "setAdapter B",
    target: oracle,
    data: encodeFunctionData({
      abi: oracleAbi,
      functionName: "setAdapter",
      args: [adapterB, true, famB, false],
    }),
    salt: `0x${(saltBase + 4n).toString(16).padStart(64, "0")}`,
  },
  {
    label: "createRoute(base,[A,B])",
    target: oracle,
    data: encodeFunctionData({
      abi: oracleAbi,
      functionName: "createRoute",
      args: [baseToken, [adapterA, adapterB]],
    }),
    salt: `0x${(saltBase + 5n).toString(16).padStart(64, "0")}`,
  },
];

console.log(`==> Scheduling ${ops.length} timelock ops (minDelay=${minDelay}s)`);
const scheduled = [];
for (const op of ops) {
  const value = 0n;
  const predecessor = zeroHash;
  const delay = minDelay;
  const hash = await write(timelock, tlAbi, "schedule", [
    op.target,
    value,
    op.data,
    predecessor,
    op.salt,
    delay,
  ]);
  const opId = await publicClient.readContract({
    address: timelock,
    abi: tlAbi,
    functionName: "hashOperation",
    args: [op.target, value, op.data, predecessor, op.salt],
  });
  const readyAt = await publicClient.readContract({
    address: timelock,
    abi: tlAbi,
    functionName: "getTimestamp",
    args: [opId],
  });
  console.log(`SCHEDULE ${op.label} opId=${opId} readyAt=${readyAt} tx=${hash}`);
  scheduled.push({
    label: op.label,
    target: op.target,
    value: "0",
    data: op.data,
    predecessor,
    salt: op.salt,
    delay: delay.toString(),
    opId,
    readyAt: readyAt.toString(),
    scheduleTx: hash,
  });
}

const pending = {
  purpose: "AnyPerp S10a fresh deploy E2E enablement",
  brand: "AnyPerp",
  domain: "https://anyperp.fun",
  chainId,
  generatedAt: new Date().toISOString(),
  deployer: account.address,
  timelock,
  factory,
  risk,
  oracle,
  collateral,
  baseToken,
  adapterA,
  adapterB,
  routeId,
  marketLens: c.MarketLens?.address ?? null,
  deploymentManifest: fs
    .readdirSync("deployments")
    .filter((f) => f.startsWith(`${chainId}-`) && f.endsWith(".json") && !f.includes("verification") && !f.includes("governance"))
    .sort()
    .at(-1),
  operations: scheduled,
  executeOrder: [
    "setSupportedCollateral",
    "setEnvelope",
    "setAdapter A",
    "setAdapter B",
    "createRoute",
    "then: node scripts/execute-e2e-config.mjs",
  ],
  note: `minDelay ${minDelay}s. After readyAt, run: node scripts/execute-e2e-config.mjs`,
};

fs.writeFileSync("deployments/pending-e2e-config.json", `${JSON.stringify(pending, null, 2)}\n`);
console.log("Wrote deployments/pending-e2e-config.json");
console.log(`First readyAt unix=${scheduled[0]?.readyAt} (~${Number(minDelay)}s from now)`);
console.log("DONE schedule-e2e-config");
