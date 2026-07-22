import fs from "node:fs";
import path from "node:path";
import "dotenv/config";
import { createPublicClient, createWalletClient, defineChain, encodeFunctionData, http, isAddress, parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const rpcUrl = process.env.RPC_HTTP_URL ?? "https://rpc.testnet.chain.robinhood.com";
const chainId = Number(process.env.CHAIN_ID ?? 46630);
const chain = defineChain({
  id: chainId,
  name: "Robinhood Chain Testnet",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [rpcUrl] } },
});

const privateKey = process.env.DEPLOYER_PRIVATE_KEY;
if (!privateKey?.startsWith("0x")) throw new Error("DEPLOYER_PRIVATE_KEY missing");
const account = privateKeyToAccount(privateKey);
const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
const wallet = createWalletClient({ account, chain, transport: http(rpcUrl) });

function setEnv(key, value) {
  const envPath = ".env";
  let env = fs.readFileSync(envPath, "utf8");
  const re = new RegExp(`^${key}=.*$`, "m");
  if (re.test(env)) env = env.replace(re, `${key}=${value}`);
  else env += `\n${key}=${value}\n`;
  fs.writeFileSync(envPath, env);
}

const balance = await publicClient.getBalance({ address: account.address });
console.log(`Deployer ${account.address}`);
console.log(`Balance  ${balance} wei (${Number(balance) / 1e18} ETH)`);
console.log(`Faucet   https://faucet.testnet.chain.robinhood.com/`);

const minWei = parseEther("0.008");
if (balance < minWei) {
  console.error(`\nNeed at least ~0.008 testnet ETH on the deployer.`);
  console.error(`1) Open the faucet and send to: ${account.address}`);
  console.error(`2) Re-run: node scripts/bootstrap-testnet-deploy.mjs`);
  process.exit(2);
}

// Ensure governance roles present
for (const name of ["GOVERNANCE_PROPOSER_ADDRESS", "GOVERNANCE_EXECUTOR_ADDRESS", "EMERGENCY_COUNCIL_ADDRESS", "PROTOCOL_TREASURY_ADDRESS"]) {
  if (!isAddress(process.env[name] ?? "")) throw new Error(`${name} missing`);
}

if (!process.env.GOVERNANCE_TIMELOCK_ADDRESS || !isAddress(process.env.GOVERNANCE_TIMELOCK_ADDRESS)) {
  console.log("\n==> Deploying GovernanceTimelock...");
  await import(`./deploy-governance-testnet.mjs?t=${Date.now()}`);
  const files = fs.readdirSync("deployments").filter((f) => f.startsWith(`governance-${chainId}-`)).sort();
  const latest = files.at(-1);
  if (!latest) throw new Error("Governance manifest not found");
  const manifest = JSON.parse(fs.readFileSync(path.join("deployments", latest), "utf8"));
  process.env.GOVERNANCE_TIMELOCK_ADDRESS = manifest.governanceTimelock;
  setEnv("GOVERNANCE_TIMELOCK_ADDRESS", manifest.governanceTimelock);
  console.log(`Timelock: ${manifest.governanceTimelock}`);
}

console.log("\n==> Deploying protocol suite...");
// re-load dotenv values by spawning fresh is hard; ensure env for child-like import
await import(`./deploy-testnet.mjs?t=${Date.now()}`);

const protocolFiles = fs.readdirSync("deployments")
  .filter((f) => f.startsWith(`${chainId}-`) && f.endsWith(".json") && !f.includes("verification") && !f.includes("governance"))
  .sort();
const latestProtocol = protocolFiles.at(-1);
if (!latestProtocol) throw new Error("Protocol deployment manifest not found");
const deployed = JSON.parse(fs.readFileSync(path.join("deployments", latestProtocol), "utf8"));
const c = deployed.contracts;

const map = {
  MARKET_FACTORY_ADDRESS: c.MarketFactory.address,
  MARKET_REGISTRY_ADDRESS: c.MarketRegistry.address,
  ORACLE_ROUTER_ADDRESS: c.OracleRouter.address,
  LIQUIDATION_ENGINE_ADDRESS: c.LiquidationEngine.address,
  TRIGGER_ORDER_MANAGER_ADDRESS: c.TriggerOrderManager.address,
  PROTOCOL_BACKSTOP_ADDRESS: c.ProtocolBackstop?.address ?? "",
  NEXT_PUBLIC_MARKET_FACTORY_ADDRESS: c.MarketFactory.address,
  NEXT_PUBLIC_MARKET_REGISTRY_ADDRESS: c.MarketRegistry.address,
  NEXT_PUBLIC_ORACLE_ROUTER_ADDRESS: c.OracleRouter.address,
  NEXT_PUBLIC_LIQUIDATION_ENGINE_ADDRESS: c.LiquidationEngine.address,
  NEXT_PUBLIC_TRIGGER_ORDER_MANAGER_ADDRESS: c.TriggerOrderManager.address,
  NEXT_PUBLIC_COLLATERAL_ADDRESS: c.MockCollateral?.address ?? "",
  INDEXED_CONTRACT_ADDRESSES: [
    c.MarketFactory.address,
    c.MarketRegistry.address,
    c.OracleRouter.address,
    c.LiquidationEngine.address,
    c.TriggerOrderManager.address,
    c.ProtocolBackstop?.address,
    c.MockCollateral?.address,
  ].filter(Boolean).join(","),
};

for (const [k, v] of Object.entries(map)) {
  if (v) setEnv(k, v);
}

console.log(`\nWired .env from ${latestProtocol}`);
console.log(JSON.stringify({
  factory: c.MarketFactory.address,
  registry: c.MarketRegistry.address,
  oracleRouter: c.OracleRouter.address,
  mockCollateral: c.MockCollateral?.address ?? null,
  governance: deployed.governance,
  deployer: deployed.deployer,
}, null, 2));

// If mock collateral exists, try schedule allowlist through timelock using deployer as temporary admin/proposer if possible
if (c.MockCollateral?.address) {
  console.log("\nNote: Mock collateral was deployed. Timelock governance must allowlist it before markets can use it.");
  console.log(`Collateral: ${c.MockCollateral.address}`);
  console.log("If TIMELOCK_ADMIN is the deployer, grant proposer/executor if needed, then schedule setSupportedCollateral via governance.");
}

console.log("\nDone. Hard-refresh the app to pick up NEXT_PUBLIC_* addresses.");
