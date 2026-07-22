import fs from "node:fs";
import { createPublicClient, http, isAddressEqual, keccak256 } from "viem";

const manifestPath = process.argv[2];
if (!manifestPath) throw new Error("Usage: node scripts/verify-deployment.mjs <manifest.json>");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
if (manifest.chainId !== 46630) throw new Error(`Refusing non-testnet manifest: ${manifest.chainId}`);

const client = createPublicClient({ transport: http(process.env.RPC_HTTP_URL ?? "https://rpc.testnet.chain.robinhood.com") });
const actualChainId = await client.getChainId();
if (actualChainId !== manifest.chainId) throw new Error(`Chain mismatch: ${actualChainId}`);

const checks = [];
for (const [name, deployment] of Object.entries(manifest.contracts)) {
  const [code, receipt] = await Promise.all([
    client.getCode({ address: deployment.address }),
    client.getTransactionReceipt({ hash: deployment.transactionHash }),
  ]);
  const passed = Boolean(code && code !== "0x" && receipt.status === "success" && isAddressEqual(receipt.contractAddress, deployment.address));
  checks.push({ name, address: deployment.address, blockNumber: receipt.blockNumber.toString(), codeBytes: (code.length - 2) / 2, codeHash: keccak256(code), passed });
}

const registryAbi = [{ type: "function", name: "factory", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] }];
const deployerAbi = [{ type: "function", name: "factory", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] }];
const factoryAbi = [
  { type: "function", name: "governance", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "guardian", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "supportedCollateral", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "bool" }] },
];
const [registryFactory, vaultFactory, marketFactoryWiring] = await Promise.all([
  client.readContract({ address: manifest.contracts.MarketRegistry.address, abi: registryAbi, functionName: "factory" }),
  client.readContract({ address: manifest.contracts.VaultDeployer.address, abi: deployerAbi, functionName: "factory" }),
  client.readContract({ address: manifest.contracts.MarketDeployer.address, abi: deployerAbi, functionName: "factory" }),
]);
const [governance, guardian, remainingBalance] = await Promise.all([
  client.readContract({ address: manifest.contracts.MarketFactory.address, abi: factoryAbi, functionName: "governance" }),
  client.readContract({ address: manifest.contracts.MarketFactory.address, abi: factoryAbi, functionName: "guardian" }),
  client.getBalance({ address: manifest.deployer }),
]);
const mockSupported = manifest.contracts.MockCollateral
  ? await client.readContract({ address: manifest.contracts.MarketFactory.address, abi: factoryAbi, functionName: "supportedCollateral", args: [manifest.contracts.MockCollateral.address] })
  : null;

const wiring = {
  registryFactoryMatches: isAddressEqual(registryFactory, manifest.contracts.MarketFactory.address),
  vaultFactoryMatches: isAddressEqual(vaultFactory, manifest.contracts.MarketFactory.address),
  marketDeployerFactoryMatches: isAddressEqual(marketFactoryWiring, manifest.contracts.MarketFactory.address),
  governanceMatches: isAddressEqual(governance, manifest.governance),
  guardianMatches: isAddressEqual(guardian, manifest.contracts.EmergencyGuardian.address),
  mockCollateralSupportedWhenLocallyConfigured: mockSupported ?? true,
};
const passed = checks.every((check) => check.passed) && Object.values(wiring).every(Boolean);
const report = { passed, chainId: actualChainId, checkedAt: new Date().toISOString(), manifestPath, checks, wiring, remainingBalanceWei: remainingBalance.toString() };
const reportPath = manifestPath.replace(/\.json$/, ".verification.json");
fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ ...report, reportPath }, null, 2));
if (!passed) process.exit(1);
