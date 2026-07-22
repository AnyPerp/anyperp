import fs from "node:fs";
import path from "node:path";
import solc from "solc";

const root = process.cwd();
const sourceRoot = path.join(root, "contracts", "src");
const outDir = path.join(root, "contracts", "out");

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

const sources = {};
for (const file of walk(sourceRoot).filter((file) => file.endsWith(".sol"))) {
  const key = path.relative(root, file).replaceAll("\\", "/");
  sources[key] = { content: fs.readFileSync(file, "utf8") };
}

const input = {
  language: "Solidity",
  sources,
  settings: {
    // Low runs prioritizes runtime size so Market stays under EIP-170 for clones.
    optimizer: { enabled: true, runs: 200 },
    viaIR: true,
    evmVersion: process.env.EVM_VERSION ?? "cancun",
    outputSelection: { "*": { "*": ["abi", "evm.bytecode.object", "evm.deployedBytecode.object"] } },
  },
};

function findImports(importPath) {
  const candidates = [path.join(root, importPath), path.join(root, "node_modules", importPath)];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return { contents: fs.readFileSync(candidate, "utf8") };
  }
  return { error: `Import not found: ${importPath}` };
}

const output = JSON.parse(solc.compile(JSON.stringify(input), { import: findImports }));
const diagnostics = output.errors ?? [];
for (const diagnostic of diagnostics) {
  const stream = diagnostic.severity === "error" ? process.stderr : process.stdout;
  stream.write(`${diagnostic.formattedMessage}\n`);
}
if (diagnostics.some((diagnostic) => diagnostic.severity === "error")) process.exit(1);

fs.mkdirSync(outDir, { recursive: true });
for (const [source, contracts] of Object.entries(output.contracts ?? {})) {
  if (!source.startsWith("contracts/src/")) continue;
  for (const [name, artifact] of Object.entries(contracts)) {
    fs.writeFileSync(
      path.join(outDir, `${name}.json`),
      `${JSON.stringify({ contractName: name, sourceName: source, ...artifact }, null, 2)}\n`,
    );
  }
}
console.log(`Compiled ${Object.keys(sources).length} Solidity sources.`);
