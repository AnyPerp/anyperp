import fs from "node:fs";
import "dotenv/config";
import { createPublicClient, createWalletClient, defineChain, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const pendingPath = "deployments/pending-collateral-allowlist.json";
if (!fs.existsSync(pendingPath)) throw new Error("No pending-collateral-allowlist.json — schedule first.");
const pending = JSON.parse(fs.readFileSync(pendingPath, "utf8"));
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
const timelockAbi = JSON.parse(fs.readFileSync("contracts/out/GovernanceTimelock.json", "utf8")).abi;

const { target, value, data, predecessor, salt } = pending.execute;
const hash = await wallet.writeContract({
  address: pending.timelock,
  abi: timelockAbi,
  functionName: "execute",
  args: [target, BigInt(value), data, predecessor, salt],
  account,
  chain,
});
const receipt = await publicClient.waitForTransactionReceipt({ hash });
if (receipt.status !== "success") throw new Error(`execute failed: ${hash}`);
console.log(`Mock collateral allowlisted. tx=${hash} block=${receipt.blockNumber}`);
pending.executedAt = new Date().toISOString();
pending.executeTx = hash;
fs.writeFileSync(pendingPath, `${JSON.stringify(pending, null, 2)}\n`);
