#!/usr/bin/env node
/**
 * Unified AnyPerp launch entrypoint.
 *
 *   pnpm launch --env testnet
 *   pnpm launch --env testnet --check-only
 *   pnpm launch --env testnet --write-host-env
 *   pnpm launch --env mainnet --require-gates   # refuses until mainnet.json + flags ready
 *
 * Same pipeline for testnet and mainnet: config → gates → (optional) deploy → host env.
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import "dotenv/config";
import {
  applyConfigToEnv,
  assertLaunchGates,
  buildHostEnvSnippet,
  loadNetworkConfig,
  resolveEnvName,
  writeLatestPointers,
} from "./lib/network-config.mjs";

function parseArgs(argv) {
  const out = {
    env: undefined,
    requireGates: false,
    checkOnly: false,
    writeHostEnv: false,
    deploy: false,
    skipCompile: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--env" || a === "-e") out.env = argv[++i];
    else if (a === "--require-gates") out.requireGates = true;
    else if (a === "--check-only") out.checkOnly = true;
    else if (a === "--write-host-env") out.writeHostEnv = true;
    else if (a === "--deploy") out.deploy = true;
    else if (a === "--skip-compile") out.skipCompile = true;
    else if (a === "--help" || a === "-h") out.help = true;
  }
  return out;
}

function runNode(script, extraEnv = {}) {
  const result = spawnSync(process.execPath, [script], {
    stdio: "inherit",
    env: { ...process.env, ...extraEnv },
    cwd: process.cwd(),
  });
  if (result.status !== 0) {
    throw new Error(`${script} exited with code ${result.status ?? "unknown"}`);
  }
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log(`Usage: node scripts/launch.mjs [options]
  --env testnet|mainnet|anvil
  --require-gates     Enforce mainnet safety gates
  --check-only        Only run readiness check
  --write-host-env    Write deployments/HOST_ENV.<chainId>.generated.example
  --deploy            Run governance (if needed) + protocol deploy for this env
`);
  process.exit(0);
}

const envName = resolveEnvName(args.env);
const { config, configPath } = loadNetworkConfig(envName);
const requireGates = args.requireGates || envName === "mainnet";

console.log(`\n══ AnyPerp launch ══`);
console.log(`env:    ${envName}`);
console.log(`config: ${configPath}`);
console.log(`chain:  ${config.chain.name} (${config.chain.id})`);
console.log(`gates:  ${requireGates ? "ON" : "off"}`);
console.log("");

applyConfigToEnv(config);

try {
  assertLaunchGates(config, { requireGates });
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  console.error("\nMainnet is intentionally blocked until configs/mainnet.json is complete.");
  console.error("Testnet: pnpm launch --env testnet");
  process.exit(1);
}

if (args.checkOnly || !args.deploy) {
  runNode("scripts/check-launch-ready.mjs", {
    ANYPERP_ENV: envName,
    ...(requireGates ? {} : {}),
  });
}

const chainId = Number(config.chain.id);
const hostEnv = buildHostEnvSnippet(config);
if (args.writeHostEnv || args.deploy) {
  const { hostPath } = writeLatestPointers(chainId, null, hostEnv);
  console.log(`Host env template: ${hostPath}`);
}

if (args.checkOnly) {
  console.log("\nCheck-only complete. Add --deploy to run chain deploys.");
  process.exit(0);
}

if (!args.deploy) {
  console.log(`
Pipeline ready for ${envName}.

Commands:
  pnpm launch --env ${envName} --check-only
  pnpm launch --env ${envName} --write-host-env
  pnpm launch --env ${envName} --deploy          # needs DEPLOYER_PRIVATE_KEY + roles

Mainnet later (same entrypoint):
  # 1) Fill configs/mainnet.json
  # 2) MAINNET_READY=true AUDIT_ATTESTATION=... 
  # 3) pnpm launch --env mainnet --require-gates --deploy
`);
  process.exit(0);
}

// ── Deploy path ──────────────────────────────────────────────
if (envName === "mainnet" && Number(config.chain.id) === 0) {
  console.error("Cannot deploy: mainnet chain id is placeholder.");
  process.exit(1);
}

if (!process.env.DEPLOYER_PRIVATE_KEY?.startsWith("0x")) {
  console.error("DEPLOYER_PRIVATE_KEY required for --deploy");
  process.exit(1);
}

// Force deploy scripts to see this env's chain
process.env.CHAIN_ID = String(config.chain.id);
process.env.RPC_HTTP_URL = config.chain.rpcHttp;
process.env.DEPLOY_MOCK_COLLATERAL = config.features.deployMockCollateral ? "true" : "false";
process.env.ANYPERP_ENV = envName;

if (envName === "mainnet" && config.features.deployMockCollateral) {
  console.error("Refusing mainnet deploy with deployMockCollateral=true");
  process.exit(1);
}

console.log("\n==> Deploy path (same scripts, env-gated)");
if (envName === "anvil" || envName === "testnet") {
  // Reuse existing bootstrap which handles governance + protocol + .env write
  runNode("scripts/bootstrap-testnet-deploy.mjs", {
    CHAIN_ID: String(config.chain.id),
    RPC_HTTP_URL: config.chain.rpcHttp,
    DEPLOY_MOCK_COLLATERAL: process.env.DEPLOY_MOCK_COLLATERAL,
    ANYPERP_ENV: envName,
  });
} else {
  console.error("Mainnet deploy path is gated and not auto-run until chain id + collateral adapters are configured.");
  console.error("When ready: set addresses in configs/mainnet.json, then extend scripts/deploy-protocol for mainnet allowlist.");
  process.exit(2);
}

// Refresh host env after deploy (read .env if updated)
const refreshed = buildHostEnvSnippet(config);
const deploymentsDir = "deployments";
const protocolFiles = fs.existsSync(deploymentsDir)
  ? fs.readdirSync(deploymentsDir)
      .filter((f) => f.startsWith(`${chainId}-`) && f.endsWith(".json") && !f.includes("verification") && !f.includes("governance") && !f.includes("latest"))
      .sort()
  : [];
const latestManifest = protocolFiles.at(-1);
if (latestManifest) {
  const full = path.join(deploymentsDir, latestManifest);
  writeLatestPointers(chainId, full, refreshed);
  console.log(`Latest pointer: deployments/${chainId}-latest.json ← ${latestManifest}`);
}

console.log("\nLaunch deploy finished. Next:");
console.log("  1) Run E2E / schedule-e2e if new oracle+market needed");
console.log("  2) Copy deployments/HOST_ENV.<chainId>.generated.example → Vercel");
console.log("  3) Host API + keepers + indexer");
console.log("  4) pnpm smoke:all");
console.log("");
