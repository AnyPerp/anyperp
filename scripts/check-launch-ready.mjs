#!/usr/bin/env node
/**
 * Readiness check for testnet (or mainnet with gates).
 * Usage:
 *   node scripts/check-launch-ready.mjs
 *   node scripts/check-launch-ready.mjs --env testnet
 *   node scripts/check-launch-ready.mjs --env mainnet --require-gates
 */
import fs from "node:fs";
import path from "node:path";
import "dotenv/config";
import { isAddress } from "viem";
import {
  applyConfigToEnv,
  assertLaunchGates,
  loadNetworkConfig,
  listReadinessChecklist,
  resolveEnvName,
} from "./lib/network-config.mjs";

function parseArgs(argv) {
  const out = { env: undefined, requireGates: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--env" || a === "-e") out.env = argv[++i];
    else if (a === "--require-gates") out.requireGates = true;
    else if (a === "--json") out.json = true;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const envName = resolveEnvName(args.env);
const { config, configPath } = loadNetworkConfig(envName);
applyConfigToEnv(config);

const checks = [];
const push = (id, label, ok, detail = "") => checks.push({ id, label, ok, detail });

for (const item of listReadinessChecklist(config)) {
  push(item.id, item.label, item.ok);
}

// Env / secrets (presence only — never print secrets)
const has = (k) => Boolean(process.env[k] && String(process.env[k]).trim());
push("deployer_key", "DEPLOYER_PRIVATE_KEY set (ops only)", has("DEPLOYER_PRIVATE_KEY") || envName === "mainnet" ? has("DEPLOYER_PRIVATE_KEY") : true,
  envName === "testnet" && !has("DEPLOYER_PRIVATE_KEY") ? "optional for read-only check" : "");

push("database", "DATABASE_URL set", has("DATABASE_URL"), has("DATABASE_URL") ? "present" : "needed for API/indexer");
push("rpc_env", "RPC_HTTP_URL or config rpc", Boolean(process.env.RPC_HTTP_URL || config.chain.rpcHttp));

const addrKeys = [
  "NEXT_PUBLIC_MARKET_FACTORY_ADDRESS",
  "NEXT_PUBLIC_MARKET_REGISTRY_ADDRESS",
  "NEXT_PUBLIC_ORACLE_ROUTER_ADDRESS",
  "NEXT_PUBLIC_LIQUIDATION_ENGINE_ADDRESS",
  "NEXT_PUBLIC_TRIGGER_ORDER_MANAGER_ADDRESS",
  "NEXT_PUBLIC_COLLATERAL_ADDRESS",
];
let addrOk = 0;
for (const key of addrKeys) {
  const v = process.env[key];
  if (v && isAddress(v)) addrOk++;
}
push(
  "protocol_addresses",
  `Protocol addresses configured (${addrOk}/${addrKeys.length})`,
  addrOk === addrKeys.length,
  addrOk < addrKeys.length ? "Run deploy or copy from deployments/<chainId>-latest.json" : "ready",
);

const demo = process.env.NEXT_PUBLIC_DEMO_MARKET_ADDRESS;
push(
  "demo_market",
  "Demo market address set",
  Boolean(demo && isAddress(demo)),
  demo && isAddress(demo) ? demo : "optional but recommended for public beta",
);

const latestPath = path.join("deployments", `${config.chain.id}-latest.json`);
const hasLatest = fs.existsSync(latestPath) || (config.chain.id === 46630 && fs.existsSync("deployments/ANYPERP-LATEST.md"));
push("deploy_manifest", `Deployment manifest (${config.chain.id}-latest.json)`, hasLatest || addrOk === addrKeys.length);

const liveDemo = path.join("deployments", "live-demo-market.json");
push("e2e_demo_file", "live-demo-market.json present", fs.existsSync(liveDemo), "E2E market record");

// Feature flag consistency
if (config.env === "testnet") {
  push(
    "testnet_flags",
    "Testnet flags allow mock/faucet",
    config.features.allowMockOracle && config.features.publicFaucet && config.features.allowMintableCollateral,
  );
}
if (config.env === "mainnet") {
  push(
    "mainnet_flags",
    "Mainnet flags block mock/faucet/mint",
    !config.features.allowMockOracle && !config.features.publicFaucet && !config.features.allowMintableCollateral,
  );
}

let gatesOk = true;
let gatesError = "";
try {
  assertLaunchGates(config, { requireGates: args.requireGates || config.env === "mainnet" });
  push("gates", "Launch gates", true, args.requireGates || config.env === "mainnet" ? "passed" : "skipped (testnet)");
} catch (err) {
  gatesOk = false;
  gatesError = err instanceof Error ? err.message : String(err);
  push("gates", "Launch gates", false, gatesError);
}

const failed = checks.filter((c) => !c.ok);
const criticalIds = new Set(["config", "rpc", "protocol_addresses", "gates", "mainnet_placeholder", "mainnet_flags"]);
const criticalFailed = failed.filter((c) => criticalIds.has(c.id));

const report = {
  env: envName,
  configPath,
  chainId: config.chain.id,
  readyForPublicTestnet: envName === "testnet" && criticalFailed.length === 0 && addrOk === addrKeys.length,
  readyForMainnetPipeline: envName === "mainnet" && gatesOk && Number(config.chain.id) !== 0,
  checks,
  nextSteps: [],
};

if (envName === "testnet") {
  if (addrOk < addrKeys.length) {
    report.nextSteps.push("pnpm launch --env testnet   # or set addresses from deployments/46630-latest.json");
  }
  if (!has("DATABASE_URL")) report.nextSteps.push("Set DATABASE_URL (Neon) for API/indexer");
  if (!demo || !isAddress(demo)) report.nextSteps.push("Wire DEMO_* from deployments/live-demo-market.json on host");
  report.nextSteps.push("Host API + indexer + keepers (not only Vercel static)");
  report.nextSteps.push("pnpm smoke:all && pnpm verify");
  report.nextSteps.push("Later: fill configs/mainnet.json → pnpm launch --env mainnet --require-gates");
} else if (envName === "mainnet") {
  report.nextSteps.push("Fill configs/mainnet.json chain id, RPC, explorer");
  report.nextSteps.push("Set MAINNET_READY=true and AUDIT_ATTESTATION=...");
  report.nextSteps.push("Use real collateral + oracle feeds; never mock mint");
  report.nextSteps.push("pnpm launch --env mainnet --require-gates");
}

if (args.json) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`\nAnyPerp launch readiness — ${envName} (chain ${config.chain.id})`);
  console.log(`Config: ${configPath}\n`);
  for (const c of checks) {
    const mark = c.ok ? "OK  " : "FAIL";
    console.log(`  [${mark}] ${c.label}${c.detail ? ` — ${c.detail}` : ""}`);
  }
  console.log("");
  if (envName === "testnet") {
    console.log(report.readyForPublicTestnet
      ? "RESULT: Protocol addresses look ready for public testnet beta."
      : "RESULT: Not fully ready — fix FAIL items above.");
  } else {
    console.log(gatesOk && Number(config.chain.id) !== 0
      ? "RESULT: Mainnet pipeline gates path is open (still need real deploy + audit ops)."
      : "RESULT: Mainnet blocked — expected until chain/oracles/audit filled.");
  }
  if (report.nextSteps.length) {
    console.log("\nNext:");
    for (const s of report.nextSteps) console.log(`  • ${s}`);
  }
  console.log("");
}

process.exit(criticalFailed.length ? 1 : 0);
