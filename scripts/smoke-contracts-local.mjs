import ganache from "ganache";

const server = ganache.server({
  chain: { chainId: 31337, hardfork: "shanghai", allowUnlimitedContractSize: false },
  wallet: { deterministic: true },
  miner: { blockGasLimit: 120_000_000 },
  logging: { quiet: true },
});

await new Promise((resolve, reject) => {
  server.listen(8545, "127.0.0.1", (error) => error ? reject(error) : resolve());
});

try {
  process.env.EVM_VERSION = "shanghai";
  await import(`./compile-contracts.mjs?run=${Date.now()}`);
  await import(`./smoke-contract-lifecycle.mjs?run=${Date.now()}`);
  if (process.exitCode && process.exitCode !== 0) throw new Error("Contract lifecycle smoke reported failures");
  // Second disposable suite: proves insolvency surfaces as deferred claims / bad debt (anti-LARP).
  await import(`./smoke-adversarial-solvency.mjs?run=${Date.now()}`);
  if (process.exitCode && process.exitCode !== 0) throw new Error("Adversarial solvency smoke reported failures");
} finally {
  await server.close();
}
