#!/usr/bin/env node
/**
 * Execute pending setEnvelope (100x experimental) after timelock delay.
 *   node scripts/execute-envelope-100x.mjs
 */
import fs from "node:fs";
import "dotenv/config";
import { createPublicClient, createWalletClient, defineChain, http, encodeFunctionData, zeroHash } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const pending = JSON.parse(fs.readFileSync("deployments/envelope-100x-pending.json", "utf8"));
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

const riskAbi = [
  {
    type: "function",
    name: "envelope",
    stateMutability: "view",
    inputs: [{ type: "uint8" }],
    outputs: [
      {
        type: "tuple",
        components: [
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
        ],
      },
    ],
  },
  {
    type: "function",
    name: "setEnvelope",
    stateMutability: "nonpayable",
    inputs: [
      { type: "uint8" },
      {
        type: "tuple",
        components: [
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
        ],
      },
    ],
    outputs: [],
  },
];

const tlAbi = [
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
    name: "isOperationReady",
    stateMutability: "view",
    inputs: [{ type: "bytes32" }],
    outputs: [{ type: "bool" }],
  },
];

const now = Math.floor(Date.now() / 1000);
if (now < pending.readyAt) {
  console.error(`Not ready until ${new Date(pending.readyAt * 1000).toISOString()} (in ${pending.readyAt - now}s)`);
  process.exit(1);
}

const cur = await publicClient.readContract({ address: risk, abi: riskAbi, functionName: "envelope", args: [3] });
const next = { ...cur, initialMarginBps: 100n, maintenanceMarginBps: 50n };
const data = encodeFunctionData({ abi: riskAbi, functionName: "setEnvelope", args: [3, next] });

const ready = await publicClient.readContract({
  address: timelock,
  abi: tlAbi,
  functionName: "isOperationReady",
  args: [pending.opId],
});
if (!ready) {
  console.error("Timelock says op not ready yet", pending.opId);
  process.exit(1);
}

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
      initialMarginBps: Number(after.initialMarginBps),
      maxLeverage: 10_000 / Number(after.initialMarginBps),
    },
    null,
    2,
  ),
);
