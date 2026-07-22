#!/usr/bin/env node
/**
 * Raise experimental envelope base-size caps so low-priced RH tokens can
 * support ~$100k+ notionals (old maxPosition=100k base ≈ $1 at $0.00001).
 *
 * Also attempts to execute pending 100x envelope if ready.
 *   node scripts/schedule-size-caps.mjs
 *   node scripts/schedule-size-caps.mjs --execute-only
 */
import fs from "node:fs";
import "dotenv/config";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeFunctionData,
  formatUnits,
  http,
  parseUnits,
  zeroHash,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const chain = defineChain({
  id: 46630,
  name: "RHC",
  nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.testnet.chain.robinhood.com"] } },
});
const account = privateKeyToAccount(process.env.DEPLOYER_PRIVATE_KEY);
const publicClient = createPublicClient({ chain, transport: http() });
const wallet = createWalletClient({ account, chain, transport: http() });

const risk = "0x084e967a17b550075674c502de1a845583da3d05";
const timelock = "0xaf494c7ad0732d2a2a7b8d47757f4aa2b2908ace";

const riskComponents = [
  { name: "initialMarginBps", type: "uint256" },
  { name: "maintenanceMarginBps", type: "uint256" },
  { name: "maxOpenInterestWad", type: "uint256" },
  { name: "maxSkewWad", type: "uint256" },
  { name: "maxPositionWad", type: "uint256" },
  { name: "maxUtilizationBps", type: "uint256" },
  { name: "maxPriceImpactBps", type: "uint256" },
  { name: "tradingFeeBps", type: "uint256" },
  { name: "liquidationPenaltyBps", type: "uint256" },
  { name: "minSeedLiquidityWad", type: "uint256" },
  { name: "minInsuranceWad", type: "uint256" },
  { name: "minOracleLiquidityWad", type: "uint256" },
  { name: "minOracleHistory", type: "uint256" },
  { name: "maxOracleConfidenceBps", type: "uint256" },
  { name: "maxOracleDeviationBps", type: "uint256" },
  { name: "oracleMaxAge", type: "uint256" },
  { name: "minOracleSources", type: "uint8" },
  { name: "minCreatorBondWad", type: "uint256" },
  { name: "baseSpreadBps", type: "uint256" },
  { name: "longPayoutStressBps", type: "uint256" },
  { name: "shortPayoutStressBps", type: "uint256" },
  { name: "fundingVelocityWad", type: "uint256" },
  { name: "maxFundingRatePerSecondWad", type: "uint256" },
  { name: "maxFundingAccrualSeconds", type: "uint256" },
];

const riskAbi = [
  {
    type: "function",
    name: "envelope",
    stateMutability: "view",
    inputs: [{ type: "uint8" }],
    outputs: [{ type: "tuple", components: riskComponents }],
  },
  {
    type: "function",
    name: "setEnvelope",
    stateMutability: "nonpayable",
    inputs: [{ type: "uint8" }, { type: "tuple", components: riskComponents }],
    outputs: [],
  },
];

const tlAbi = [
  {
    type: "function",
    name: "schedule",
    stateMutability: "nonpayable",
    inputs: [
      { name: "target", type: "address" },
      { name: "value", type: "uint256" },
      { name: "data", type: "bytes" },
      { name: "predecessor", type: "bytes32" },
      { name: "salt", type: "bytes32" },
      { name: "delay", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "execute",
    stateMutability: "payable",
    inputs: [
      { name: "target", type: "address" },
      { name: "value", type: "uint256" },
      { name: "payload", type: "bytes" },
      { name: "predecessor", type: "bytes32" },
      { name: "salt", type: "bytes32" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "getMinDelay",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "hashOperation",
    stateMutability: "pure",
    inputs: [
      { type: "address" },
      { type: "uint256" },
      { type: "bytes" },
      { type: "bytes32" },
      { type: "bytes32" },
    ],
    outputs: [{ type: "bytes32" }],
  },
  {
    type: "function",
    name: "isOperationReady",
    stateMutability: "view",
    inputs: [{ type: "bytes32" }],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "isOperationDone",
    stateMutability: "view",
    inputs: [{ type: "bytes32" }],
    outputs: [{ type: "bool" }],
  },
];

const executeOnly = process.argv.includes("--execute-only");
const pendingPath = "deployments/envelope-size-caps-pending.json";

async function tryExecute100x() {
  const path = "deployments/envelope-100x-pending.json";
  if (!fs.existsSync(path)) return;
  const pending = JSON.parse(fs.readFileSync(path, "utf8"));
  const ready = await publicClient.readContract({
    address: timelock,
    abi: tlAbi,
    functionName: "isOperationReady",
    args: [pending.opId],
  });
  const done = await publicClient.readContract({
    address: timelock,
    abi: tlAbi,
    functionName: "isOperationDone",
    args: [pending.opId],
  });
  console.log("100x ready=", ready, "done=", done);
  if (!ready || done) return;
  const cur = await publicClient.readContract({ address: risk, abi: riskAbi, functionName: "envelope", args: [3] });
  const next = { ...cur, initialMarginBps: 100n, maintenanceMarginBps: 50n };
  const data = encodeFunctionData({ abi: riskAbi, functionName: "setEnvelope", args: [3, next] });
  try {
    const hash = await wallet.writeContract({
      address: timelock,
      abi: tlAbi,
      functionName: "execute",
      args: [risk, 0n, data, zeroHash, pending.salt],
      account,
      chain,
    });
    const rec = await publicClient.waitForTransactionReceipt({ hash });
    console.log("executed 100x", hash, rec.status);
  } catch (e) {
    console.log("100x execute failed:", e.shortMessage || e.message);
  }
}

async function executeSizeCaps() {
  if (!fs.existsSync(pendingPath)) {
    console.error("No pending size-caps op at", pendingPath);
    process.exit(1);
  }
  const pending = JSON.parse(fs.readFileSync(pendingPath, "utf8"));
  const ready = await publicClient.readContract({
    address: timelock,
    abi: tlAbi,
    functionName: "isOperationReady",
    args: [pending.opId],
  });
  if (!ready) {
    console.error("Not ready until", new Date(pending.readyAt * 1000).toISOString());
    process.exit(1);
  }
  const cur = await publicClient.readContract({ address: risk, abi: riskAbi, functionName: "envelope", args: [3] });
  const next = {
    ...cur,
    maxOpenInterestWad: parseUnits(pending.maxOpenInterestWad, 18),
    maxSkewWad: parseUnits(pending.maxSkewWad, 18),
    maxPositionWad: parseUnits(pending.maxPositionWad, 18),
  };
  // Prefer exact payload from file if present
  const data =
    pending.payload ||
    encodeFunctionData({ abi: riskAbi, functionName: "setEnvelope", args: [3, next] });
  const hash = await wallet.writeContract({
    address: timelock,
    abi: tlAbi,
    functionName: "execute",
    args: [risk, 0n, data, zeroHash, pending.salt],
    account,
    chain,
  });
  const rec = await publicClient.waitForTransactionReceipt({ hash });
  const after = await publicClient.readContract({ address: risk, abi: riskAbi, functionName: "envelope", args: [3] });
  console.log(
    JSON.stringify(
      {
        ok: rec.status === "success",
        executeTx: hash,
        maxPositionWad: formatUnits(after.maxPositionWad, 18),
        maxOpenInterestWad: formatUnits(after.maxOpenInterestWad, 18),
        initialMarginBps: Number(after.initialMarginBps),
      },
      null,
      2,
    ),
  );
}

async function scheduleSizeCaps() {
  await tryExecute100x();
  const cur = await publicClient.readContract({ address: risk, abi: riskAbi, functionName: "envelope", args: [3] });
  console.log(
    "envelope now IM",
    Number(cur.initialMarginBps),
    "maxPos",
    formatUnits(cur.maxPositionWad, 18),
    "maxOI",
    formatUnits(cur.maxOpenInterestWad, 18),
  );

  // Huge base-unit caps: even at $1e-9/token, $100k notional is 1e14 base units.
  const next = {
    ...cur,
    maxOpenInterestWad: parseUnits("1000000000000000000", 18), // 1e18
    maxSkewWad: parseUnits("500000000000000000", 18), // 5e17
    maxPositionWad: parseUnits("100000000000000000", 18), // 1e17
  };
  const data = encodeFunctionData({ abi: riskAbi, functionName: "setEnvelope", args: [3, next] });
  const delay = await publicClient.readContract({ address: timelock, abi: tlAbi, functionName: "getMinDelay" });
  const salt = `0x${(BigInt(Date.now()) + 991n).toString(16).padStart(64, "0")}`;
  const opId = await publicClient.readContract({
    address: timelock,
    abi: tlAbi,
    functionName: "hashOperation",
    args: [risk, 0n, data, zeroHash, salt],
  });
  const hash = await wallet.writeContract({
    address: timelock,
    abi: tlAbi,
    functionName: "schedule",
    args: [risk, 0n, data, zeroHash, salt, delay],
    account,
    chain,
  });
  const rec = await publicClient.waitForTransactionReceipt({ hash });
  const readyAt = Math.floor(Date.now() / 1000) + Number(delay);
  const out = {
    op: "setEnvelope experimental huge base size caps for low-priced RH tokens",
    opId,
    salt,
    delay: Number(delay),
    readyAt,
    scheduleTx: hash,
    maxPositionWad: formatUnits(next.maxPositionWad, 18),
    maxOpenInterestWad: formatUnits(next.maxOpenInterestWad, 18),
    maxSkewWad: formatUnits(next.maxSkewWad, 18),
    initialMarginBps: Number(next.initialMarginBps),
    payload: data,
    execute: "node scripts/schedule-size-caps.mjs --execute-only",
  };
  fs.writeFileSync(pendingPath, JSON.stringify(out, null, 2));
  console.log(JSON.stringify({ scheduled: rec.status === "success", ...out, payload: undefined }, null, 2));
}

if (executeOnly) {
  await executeSizeCaps();
} else {
  await scheduleSizeCaps();
}
