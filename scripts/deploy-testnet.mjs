import fs from "node:fs";
import path from "node:path";
import "dotenv/config";
import { createPublicClient, createWalletClient, http, isAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { applyConfigToEnv, defineNetworkChain, loadNetworkConfig, resolveEnvName } from "./lib/network-config.mjs";

const { config } = loadNetworkConfig(resolveEnvName(process.env.ANYPERP_ENV ?? process.env.NETWORK_MODE ?? "testnet"));
applyConfigToEnv(config);

const expectedChainId = Number(process.env.CHAIN_ID ?? config.chain.id);
const allowed = new Set([...(config.deploy?.allowedChainIds ?? []), 31337, 46630]);
if (!allowed.has(expectedChainId)) {
  throw new Error(`Deployment blocked for chain ${expectedChainId}. Allowed: ${[...allowed].join(", ")}. Use configs/*.json + ANYPERP_ENV.`);
}
if (config.env === "mainnet" && config.features?.deployMockCollateral) {
  throw new Error("Refusing deploy: mainnet config must not enable deployMockCollateral.");
}
const privateKey = process.env.DEPLOYER_PRIVATE_KEY;
if (!privateKey?.startsWith("0x")) throw new Error("DEPLOYER_PRIVATE_KEY is required and must never be committed.");
const rpcUrl = process.env.RPC_HTTP_URL ?? config.chain.rpcHttp;
const account = privateKeyToAccount(privateKey);
const compromisedAddresses = new Set([
  "0xfdd7083cf8050fe8c1e07877500243e92317ce02",
]);
if (compromisedAddresses.has(account.address.toLowerCase())) {
  throw new Error("This deployer was disclosed publicly. Generate and fund a new testnet-only deployer key.");
}
const chain = defineNetworkChain({
  ...config.chain,
  id: expectedChainId,
  name: expectedChainId === 31337 ? "Anvil" : config.chain.name,
  rpcHttp: rpcUrl,
  testnet: expectedChainId !== Number(config.chain.id) || config.chain.testnet,
});
const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
const wallet = createWalletClient({ account, chain, transport: http(rpcUrl) });
const actualChainId = await publicClient.getChainId();
if (actualChainId !== expectedChainId) throw new Error(`Chain mismatch: expected ${expectedChainId}, RPC returned ${actualChainId}`);

function requiredRole(name, localDefault) {
  const value = process.env[name] ?? (expectedChainId === 31337 ? localDefault : undefined);
  if (!value || !isAddress(value)) throw new Error(`${name} must be a valid, independently reviewed address.`);
  return value;
}

const governanceAddress = requiredRole("GOVERNANCE_TIMELOCK_ADDRESS", account.address);
const emergencyCouncilAddress = requiredRole("EMERGENCY_COUNCIL_ADDRESS", account.address);
const treasuryAddress = requiredRole("PROTOCOL_TREASURY_ADDRESS", account.address);
if (expectedChainId === 46630) {
  if (governanceAddress.toLowerCase() === account.address.toLowerCase()) {
    throw new Error("Testnet governance must not be the deployer EOA. Provide GOVERNANCE_TIMELOCK_ADDRESS.");
  }
  const governanceCode = await publicClient.getCode({ address: governanceAddress });
  if (!governanceCode || governanceCode === "0x") throw new Error("GOVERNANCE_TIMELOCK_ADDRESS must contain contract code.");
}

function artifact(name) {
  return JSON.parse(fs.readFileSync(path.join("contracts", "out", `${name}.json`), "utf8"));
}
async function deploy(name, args = []) {
  const value = artifact(name);
  const hash = await wallet.deployContract({ abi: value.abi, bytecode: `0x${value.evm.bytecode.object}`, args, account, chain });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (!receipt.contractAddress || receipt.status !== "success") throw new Error(`${name} deployment failed: ${hash}`);
  return { address: receipt.contractAddress, transactionHash: hash, blockNumber: receipt.blockNumber.toString() };
}

await import("./compile-contracts.mjs");
const deployed = {};
deployed.OracleRouter = await deploy("OracleRouter", [governanceAddress]);
deployed.RiskManager = await deploy("RiskManager", [governanceAddress]);
deployed.FundingEngine = await deploy("FundingEngine");
deployed.FeeManager = await deploy("FeeManager", [governanceAddress, treasuryAddress]);
deployed.LiquidationEngine = await deploy("LiquidationEngine");
deployed.TriggerOrderManager = await deploy("TriggerOrderManager");
deployed.KeeperRegistry = await deploy("KeeperRegistry");
deployed.MarketRegistry = await deploy("MarketRegistry", [governanceAddress, account.address]);
deployed.EmergencyGuardian = await deploy("EmergencyGuardian", [emergencyCouncilAddress]);
deployed.ProtocolBackstop = await deploy("ProtocolBackstop", [governanceAddress]);
deployed.MarketImplementation = await deploy("Market");
deployed.VaultDeployer = await deploy("VaultDeployer", [governanceAddress, account.address]);
deployed.MarketDeployer = await deploy("MarketDeployer", [governanceAddress, account.address, deployed.MarketImplementation.address]);
const allowMockCollateral =
  config.features?.deployMockCollateral === true ||
  expectedChainId === 31337 ||
  process.env.DEPLOY_MOCK_COLLATERAL === "true";
if (config.env === "mainnet" && allowMockCollateral) {
  throw new Error("Mock collateral deploy is forbidden on mainnet.");
}
if (allowMockCollateral) {
  deployed.MockCollateral = await deploy("MockERC20", ["AnyPerp Test USD", "apUSD", 6]);
}
deployed.MarketLens = await deploy("MarketLens");
deployed.MarketFactory = await deploy("MarketFactory", [
  governanceAddress,
  deployed.EmergencyGuardian.address,
  deployed.RiskManager.address,
  deployed.OracleRouter.address,
  deployed.MarketRegistry.address,
  deployed.FundingEngine.address,
  deployed.FeeManager.address,
  deployed.LiquidationEngine.address,
  deployed.TriggerOrderManager.address,
  deployed.ProtocolBackstop.address,
  deployed.VaultDeployer.address,
  deployed.MarketDeployer.address,
  86_400n,
]);

const registry = artifact("MarketRegistry");
let hash = await wallet.writeContract({ address: deployed.MarketRegistry.address, abi: registry.abi, functionName: "setFactory", args: [deployed.MarketFactory.address], account, chain });
await publicClient.waitForTransactionReceipt({ hash });
const vaultDeployerArtifact = artifact("VaultDeployer");
hash = await wallet.writeContract({ address: deployed.VaultDeployer.address, abi: vaultDeployerArtifact.abi, functionName: "setFactory", args: [deployed.MarketFactory.address], account, chain });
await publicClient.waitForTransactionReceipt({ hash });
const marketDeployerArtifact = artifact("MarketDeployer");
hash = await wallet.writeContract({ address: deployed.MarketDeployer.address, abi: marketDeployerArtifact.abi, functionName: "setFactory", args: [deployed.MarketFactory.address], account, chain });
await publicClient.waitForTransactionReceipt({ hash });
if (deployed.MockCollateral) {
  if (governanceAddress.toLowerCase() === account.address.toLowerCase()) {
    const factory = artifact("MarketFactory");
    hash = await wallet.writeContract({ address: deployed.MarketFactory.address, abi: factory.abi, functionName: "setSupportedCollateral", args: [deployed.MockCollateral.address, true], account, chain });
    await publicClient.waitForTransactionReceipt({ hash });
  }
}

const output = {
  project: "AnyPerp",
  env: config.env,
  status: config.deploy?.statusLabel ?? "unaudited_testnet_prototype",
  chainId: actualChainId,
  deployer: account.address,
  governance: governanceAddress,
  emergencyCouncil: emergencyCouncilAddress,
  treasury: treasuryAddress,
  features: {
    mockCollateral: Boolean(deployed.MockCollateral),
    allowMockOracle: Boolean(config.features?.allowMockOracle),
  },
  configurationRequired: governanceAddress.toLowerCase() === account.address.toLowerCase() ? [] : [
    "Timelock must configure supported collateral, risk envelopes, oracle adapters, routes, fees, and backstop allowances.",
  ],
  generatedAt: new Date().toISOString(),
  contracts: deployed,
};
fs.mkdirSync("deployments", { recursive: true });
const outputPath = path.join("deployments", `${actualChainId}-${Date.now()}.json`);
fs.writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`);
const latestPath = path.join("deployments", `${actualChainId}-latest.json`);
fs.copyFileSync(outputPath, latestPath);
console.log(`Deployment manifest written to ${outputPath}`);
console.log(`Latest pointer written to ${latestPath}`);
