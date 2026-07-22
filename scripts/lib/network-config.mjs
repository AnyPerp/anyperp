import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineChain } from "viem";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * @param {string} [envName]
 * @returns {{ env: string, configPath: string, config: object }}
 */
export function resolveEnvName(envName) {
  const raw = (envName ?? process.env.ANYPERP_ENV ?? process.env.NETWORK_MODE ?? "testnet")
    .toString()
    .trim()
    .toLowerCase();
  if (raw === "prod" || raw === "production") return "mainnet";
  if (raw === "local" || raw === "dev") return "anvil";
  if (!["testnet", "mainnet", "anvil"].includes(raw)) {
    throw new Error(`Unknown env "${raw}". Use testnet | mainnet | anvil.`);
  }
  return raw;
}

/**
 * @param {string} [envName]
 */
export function loadNetworkConfig(envName) {
  const env = resolveEnvName(envName);
  const configPath = path.join(root, "configs", `${env}.json`);
  if (!fs.existsSync(configPath)) throw new Error(`Missing network config: ${configPath}`);
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  if (config.env !== env) throw new Error(`Config env mismatch: file says ${config.env}, loaded as ${env}`);
  return { env, configPath, config, root };
}

/**
 * @param {object} chain
 */
export function defineNetworkChain(chain) {
  if (!chain?.id || !chain.rpcHttp) {
    throw new Error("Chain config incomplete: need id + rpcHttp");
  }
  return defineChain({
    id: Number(chain.id),
    name: chain.name,
    nativeCurrency: chain.nativeCurrency ?? { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: {
      default: {
        http: [chain.rpcHttp],
        ...(chain.rpcWs ? { webSocket: [chain.rpcWs] } : {}),
      },
    },
    blockExplorers: chain.explorer
      ? { default: { name: `${chain.shortName ?? chain.name} Explorer`, url: chain.explorer } }
      : undefined,
    testnet: Boolean(chain.testnet),
  });
}

/**
 * Mainnet safety gates. Throws if launch must not proceed.
 * @param {object} config
 * @param {{ requireGates?: boolean, envVars?: NodeJS.ProcessEnv }} [opts]
 */
export function assertLaunchGates(config, opts = {}) {
  const requireGates = opts.requireGates ?? config.env === "mainnet";
  const env = opts.envVars ?? process.env;
  const errors = [];

  if (!requireGates) return { ok: true, errors: [] };

  if (config.env === "mainnet") {
    if (!config.chain?.id || Number(config.chain.id) === 0) {
      errors.push("configs/mainnet.json chain.id is still placeholder (0). Fill real mainnet chain id.");
    }
    if (!config.chain?.rpcHttp) {
      errors.push("configs/mainnet.json chain.rpcHttp is empty.");
    }
    if (!Array.isArray(config.deploy?.allowedChainIds) || config.deploy.allowedChainIds.length === 0) {
      errors.push("configs/mainnet.json deploy.allowedChainIds is empty — add mainnet chain id.");
    }
    if (config.gates?.requireMainnetReadyFlag && env.MAINNET_READY !== "true") {
      errors.push("MAINNET_READY=true is required for mainnet launch.");
    }
    if (config.gates?.requireAuditAttestation && !env.AUDIT_ATTESTATION) {
      errors.push("AUDIT_ATTESTATION (report hash/URL) is required for mainnet launch.");
    }
    if (config.gates?.blockMockOnMainnet) {
      if (env.ALLOW_MOCK_ORACLE === "true" || env.NEXT_PUBLIC_ALLOW_MOCK_ORACLE === "true") {
        errors.push("Mock oracle flags must be false/absent on mainnet.");
      }
      if (env.DEPLOY_MOCK_COLLATERAL === "true") {
        errors.push("DEPLOY_MOCK_COLLATERAL must not be true on mainnet.");
      }
    }
    if (config.gates?.blockMintableCollateral) {
      if (env.ALLOW_MINTABLE_COLLATERAL === "true" || env.NEXT_PUBLIC_ALLOW_MINTABLE_COLLATERAL === "true") {
        errors.push("Mintable collateral flags must be false/absent on mainnet.");
      }
      if (env.NEXT_PUBLIC_PUBLIC_FAUCET === "true") {
        errors.push("Public faucet must be disabled on mainnet.");
      }
    }
  }

  if (errors.length) {
    const msg = ["Mainnet/launch gates failed:", ...errors.map((e) => `  - ${e}`)].join("\n");
    throw new Error(msg);
  }
  return { ok: true, errors: [] };
}

/**
 * Apply config defaults onto process.env without overwriting existing values
 * unless force=true.
 * @param {object} config
 * @param {{ force?: boolean }} [opts]
 */
export function applyConfigToEnv(config, opts = {}) {
  const force = Boolean(opts.force);
  const set = (key, value) => {
    if (value === undefined || value === null || value === "") return;
    if (!force && process.env[key]) return;
    process.env[key] = String(value);
  };

  set("ANYPERP_ENV", config.env);
  set("NETWORK_MODE", config.env);
  set("CHAIN_ID", config.chain.id);
  set("RPC_HTTP_URL", config.chain.rpcHttp);
  set("RPC_HTTP_URLS", config.chain.rpcHttp);
  if (config.chain.rpcWs) set("RPC_WS_URLS", config.chain.rpcWs);

  set("NEXT_PUBLIC_CHAIN_ID", config.chain.id);
  set("NEXT_PUBLIC_RPC_URL", config.chain.rpcHttp);
  set("NEXT_PUBLIC_NETWORK_MODE", config.env);
  set("NEXT_PUBLIC_CHAIN_NAME", config.chain.shortName ?? config.chain.name);
  if (config.chain.explorer) set("NEXT_PUBLIC_EXPLORER_URL", config.chain.explorer);
  if (config.chain.faucet) set("NEXT_PUBLIC_FAUCET_URL", config.chain.faucet);

  set("NEXT_PUBLIC_ALLOW_MOCK_ORACLE", config.features.allowMockOracle ? "true" : "false");
  set("NEXT_PUBLIC_ALLOW_MINTABLE_COLLATERAL", config.features.allowMintableCollateral ? "true" : "false");
  set("NEXT_PUBLIC_PUBLIC_FAUCET", config.features.publicFaucet ? "true" : "false");
  set("ALLOW_MOCK_ORACLE", config.features.allowMockOracle ? "true" : "false");
  set("ALLOW_MINTABLE_COLLATERAL", config.features.allowMintableCollateral ? "true" : "false");
  set("DEPLOY_MOCK_COLLATERAL", config.features.deployMockCollateral ? "true" : "false");

  if (config.site?.url) {
    set("NEXT_PUBLIC_SITE_URL", config.site.url);
    set("NEXT_PUBLIC_DOCS_URL", `${config.site.url}${config.site.docsPath ?? "/?surface=docs"}`);
    set("NEXT_PUBLIC_APP_URL", `${config.site.url}${config.site.appPath ?? "/?surface=app"}`);
  }

  if (config.features.minTimelockDelaySeconds != null) {
    set("GOVERNANCE_TIMELOCK_DELAY_SECONDS", config.features.minTimelockDelaySeconds);
  }
}

/**
 * @param {object} config
 * @param {Record<string, string>} addresses
 */
export function buildHostEnvSnippet(config, addresses = {}) {
  const lines = [
    `# AnyPerp host env — generated for ${config.env} (chain ${config.chain.id})`,
    `# Pipeline: same code as mainnet; only this env + configs/${config.env}.json change.`,
    "",
    `ANYPERP_ENV=${config.env}`,
    `NETWORK_MODE=${config.env}`,
    `CHAIN_ID=${config.chain.id}`,
    `RPC_HTTP_URL=${config.chain.rpcHttp}`,
    `RPC_HTTP_URLS=${config.chain.rpcHttp}`,
    config.chain.rpcWs ? `RPC_WS_URLS=${config.chain.rpcWs}` : null,
    "",
    `NEXT_PUBLIC_NETWORK_MODE=${config.env}`,
    `NEXT_PUBLIC_CHAIN_ID=${config.chain.id}`,
    `NEXT_PUBLIC_CHAIN_NAME=${config.chain.shortName ?? config.chain.name}`,
    `NEXT_PUBLIC_RPC_URL=${config.chain.rpcHttp}`,
    config.chain.explorer ? `NEXT_PUBLIC_EXPLORER_URL=${config.chain.explorer}` : null,
    config.chain.faucet ? `NEXT_PUBLIC_FAUCET_URL=${config.chain.faucet}` : null,
    `NEXT_PUBLIC_ALLOW_MOCK_ORACLE=${config.features.allowMockOracle ? "true" : "false"}`,
    `NEXT_PUBLIC_ALLOW_MINTABLE_COLLATERAL=${config.features.allowMintableCollateral ? "true" : "false"}`,
    `NEXT_PUBLIC_PUBLIC_FAUCET=${config.features.publicFaucet ? "true" : "false"}`,
    `NEXT_PUBLIC_SITE_URL=${config.site?.url ?? ""}`,
    `NEXT_PUBLIC_DOCS_URL=${config.site?.url ?? ""}${config.site?.docsPath ?? "/?surface=docs"}`,
    `NEXT_PUBLIC_APP_URL=${config.site?.url ?? ""}${config.site?.appPath ?? "/?surface=app"}`,
    "",
  ].filter((line) => line !== null);

  const keys = [
    "NEXT_PUBLIC_MARKET_FACTORY_ADDRESS",
    "NEXT_PUBLIC_MARKET_REGISTRY_ADDRESS",
    "NEXT_PUBLIC_ORACLE_ROUTER_ADDRESS",
    "NEXT_PUBLIC_LIQUIDATION_ENGINE_ADDRESS",
    "NEXT_PUBLIC_TRIGGER_ORDER_MANAGER_ADDRESS",
    "NEXT_PUBLIC_COLLATERAL_ADDRESS",
    "NEXT_PUBLIC_MARKET_LENS_ADDRESS",
    "NEXT_PUBLIC_DEMO_MARKET_ADDRESS",
    "NEXT_PUBLIC_DEMO_MARKET_ID",
    "NEXT_PUBLIC_DEMO_BASE_TOKEN",
    "NEXT_PUBLIC_DEMO_ORACLE_ROUTE_ID",
    "NEXT_PUBLIC_DEMO_LIQUIDITY_VAULT",
    "NEXT_PUBLIC_DEMO_INSURANCE_FUND",
    "MARKET_FACTORY_ADDRESS",
    "MARKET_REGISTRY_ADDRESS",
    "ORACLE_ROUTER_ADDRESS",
    "LIQUIDATION_ENGINE_ADDRESS",
    "TRIGGER_ORDER_MANAGER_ADDRESS",
    "PROTOCOL_BACKSTOP_ADDRESS",
    "INDEXED_CONTRACT_ADDRESSES",
  ];

  for (const key of keys) {
    const value = addresses[key] ?? process.env[key] ?? "";
    if (value) lines.push(`${key}=${value}`);
  }

  lines.push("");
  lines.push("# Server-only (never NEXT_PUBLIC_):");
  lines.push("# DATABASE_URL=...");
  lines.push("# REDIS_URL=...");
  lines.push("# KEEPER_PRIVATE_KEY=...");
  if (config.env === "mainnet") {
    lines.push("# MAINNET_READY=true");
    lines.push("# AUDIT_ATTESTATION=...");
  }
  lines.push("");
  return lines.join("\n");
}

/**
 * Write deployments/<chainId>-latest.json pointer + host env example.
 */
export function writeLatestPointers(chainId, manifestPath, hostEnvText) {
  const deploymentsDir = path.join(root, "deployments");
  fs.mkdirSync(deploymentsDir, { recursive: true });
  const latestPath = path.join(deploymentsDir, `${chainId}-latest.json`);
  if (manifestPath && fs.existsSync(manifestPath)) {
    fs.copyFileSync(manifestPath, latestPath);
  }
  const hostPath = path.join(deploymentsDir, `HOST_ENV.${chainId}.generated.example`);
  fs.writeFileSync(hostPath, hostEnvText);
  return { latestPath, hostPath };
}

export function listReadinessChecklist(config) {
  const f = config.features;
  return [
    { id: "config", label: `Network config loaded (${config.env}, chain ${config.chain.id})`, ok: Boolean(config.chain?.id) },
    { id: "rpc", label: "RPC URL set", ok: Boolean(config.chain?.rpcHttp) },
    { id: "mock_oracle_policy", label: f.allowMockOracle ? "Mock oracle allowed (testnet OK)" : "Mock oracle blocked", ok: true },
    { id: "faucet_policy", label: f.publicFaucet ? "Public faucet enabled (testnet OK)" : "Public faucet disabled", ok: true },
    { id: "mint_policy", label: f.allowMintableCollateral ? "Mintable collateral allowed (testnet OK)" : "Mintable collateral blocked", ok: true },
    {
      id: "mainnet_placeholder",
      label: config.env === "mainnet" ? "Mainnet chain id real (not 0)" : "N/A (not mainnet)",
      ok: config.env !== "mainnet" || Number(config.chain.id) !== 0,
    },
  ];
}
