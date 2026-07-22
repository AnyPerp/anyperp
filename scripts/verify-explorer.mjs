import fs from "node:fs";
import path from "node:path";

const manifestPath = process.argv[2];
const onlyName = process.argv[3];
if (!manifestPath) throw new Error("Usage: node scripts/verify-explorer.mjs <manifest.json> [ContractName]");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
if (manifest.chainId !== 46630) throw new Error("Explorer verification is restricted to Robinhood Chain testnet.");

const root = process.cwd();
const sources = {};
const importPattern = /import\s+(?:[^"']+from\s+)?["']([^"']+)["'];/g;

function addSource(sourceName, diskPath) {
  if (sources[sourceName]) return;
  const content = fs.readFileSync(diskPath, "utf8");
  sources[sourceName] = { content };
  for (const match of content.matchAll(importPattern)) {
    const request = match[1];
    const importedName = request.startsWith("@")
      ? request
      : path.posix.normalize(path.posix.join(path.posix.dirname(sourceName), request));
    const importedPath = importedName.startsWith("@")
      ? path.join(root, "node_modules", ...importedName.split("/"))
      : path.join(root, ...importedName.split("/"));
    addSource(importedName, importedPath);
  }
}

for (const file of fs.readdirSync(path.join(root, "contracts", "src"), { recursive: true, withFileTypes: true })) {
  if (!file.isFile() || !file.name.endsWith(".sol")) continue;
  const diskPath = path.join(file.parentPath, file.name);
  const sourceName = path.relative(root, diskPath).replaceAll("\\", "/");
  addSource(sourceName, diskPath);
}

const standardInput = {
  language: "Solidity",
  sources,
  settings: {
    optimizer: { enabled: true, runs: 10_000 },
    viaIR: true,
    outputSelection: { "*": { "*": ["abi", "evm.bytecode.object", "evm.deployedBytecode.object"] } },
  },
};

const endpoint = "https://explorer.testnet.chain.robinhood.com/api/v2/smart-contracts";
const results = [];
for (const [name, deployment] of Object.entries(manifest.contracts)) {
  if (onlyName && name !== onlyName) continue;
  const artifactName = name === "MockCollateral" ? "MockERC20" : name;
  const artifact = JSON.parse(fs.readFileSync(path.join(root, "contracts", "out", `${artifactName}.json`), "utf8"));
  const form = new FormData();
  form.append("compiler_version", "v0.8.30+commit.73712a01");
  form.append("contract_name", `${artifact.sourceName}:${artifactName}`);
  form.append("files[0]", new Blob([JSON.stringify(standardInput)], { type: "application/json" }), "standard-input.json");
  form.append("autodetect_constructor_args", "true");
  form.append("license_type", "mit");
  const response = await fetch(`${endpoint}/${deployment.address}/verification/via/standard-input`, { method: "POST", body: form });
  const body = await response.text();
  results.push({ name, address: deployment.address, accepted: response.ok, status: response.status, response: body.slice(0, 500) });
  if (!response.ok) break;
}
console.log(JSON.stringify(results, null, 2));
if (results.some((result) => !result.accepted)) process.exit(1);
