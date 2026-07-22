import fs from "node:fs";
import path from "node:path";
import "dotenv/config";
import { createPublicClient, createWalletClient, defineChain, http, isAddress, zeroAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const chainId = Number(process.env.CHAIN_ID ?? 46630);
if (![31337, 46630].includes(chainId)) throw new Error("Governance deployment is restricted to local Anvil or Robinhood Chain testnet.");
const privateKey = process.env.DEPLOYER_PRIVATE_KEY;
if (!privateKey?.startsWith("0x")) throw new Error("DEPLOYER_PRIVATE_KEY is required and must stay outside the repository.");
const account = privateKeyToAccount(privateKey);
if (account.address.toLowerCase() === "0xfdd7083cf8050fe8c1e07877500243e92317ce02") {
  throw new Error("This deployer key was publicly disclosed. Generate and fund a fresh testnet-only key.");
}

function requiredAddress(name) {
  const value = process.env[name];
  if (!value || !isAddress(value)) throw new Error(`${name} must be a valid address.`);
  return value;
}

const proposer = requiredAddress("GOVERNANCE_PROPOSER_ADDRESS");
const executor = requiredAddress("GOVERNANCE_EXECUTOR_ADDRESS");
const admin = process.env.TIMELOCK_ADMIN_ADDRESS ?? zeroAddress;
if (!isAddress(admin)) throw new Error("TIMELOCK_ADMIN_ADDRESS must be a valid address when set.");
if (chainId === 46630 && proposer.toLowerCase() === account.address.toLowerCase()) {
  throw new Error("The testnet proposer must be an independently controlled multisig, not the deployer EOA.");
}
const minimumDelay = BigInt(process.env.GOVERNANCE_TIMELOCK_DELAY_SECONDS ?? 86_400);
if (minimumDelay < 3_600n) throw new Error("Governance delay must be at least one hour for this testnet deployment script.");

const rpcUrl = process.env.RPC_HTTP_URL ?? "https://rpc.testnet.chain.robinhood.com";
const chain = defineChain({
  id: chainId, name: chainId === 46630 ? "Robinhood Chain Testnet" : "Local Anvil",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } },
});
const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
const wallet = createWalletClient({ account, chain, transport: http(rpcUrl) });
if (await publicClient.getChainId() !== chainId) throw new Error("RPC chain ID does not match CHAIN_ID.");

await import("./compile-contracts.mjs");
const artifact = JSON.parse(fs.readFileSync(path.join("contracts", "out", "GovernanceTimelock.json"), "utf8"));
const hash = await wallet.deployContract({
  abi: artifact.abi, bytecode: `0x${artifact.evm.bytecode.object}`, args: [minimumDelay, [proposer], [executor], admin], account, chain,
});
const receipt = await publicClient.waitForTransactionReceipt({ hash });
if (receipt.status !== "success" || !receipt.contractAddress) throw new Error(`GovernanceTimelock deployment failed: ${hash}`);
const code = await publicClient.getCode({ address: receipt.contractAddress });
if (!code || code === "0x") throw new Error("No code found at the deployed timelock address.");

const manifest = {
  status: "unaudited_testnet_governance",
  chainId,
  deployer: account.address,
  governanceTimelock: receipt.contractAddress,
  proposer,
  executor,
  admin,
  minimumDelaySeconds: minimumDelay.toString(),
  transactionHash: hash,
  blockNumber: receipt.blockNumber.toString(),
  generatedAt: new Date().toISOString(),
  nextStep: "Set GOVERNANCE_TIMELOCK_ADDRESS to governanceTimelock, then run deploy-testnet.mjs.",
};
fs.mkdirSync("deployments", { recursive: true });
const outputPath = path.join("deployments", `governance-${chainId}-${Date.now()}.json`);
fs.writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Governance manifest written to ${outputPath}`);
