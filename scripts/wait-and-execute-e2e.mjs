/**
 * Waits until pending-e2e-config ops are ready, then runs execute-e2e-config.mjs.
 */
import fs from "node:fs";
import { spawn } from "node:child_process";

const pending = JSON.parse(fs.readFileSync("deployments/pending-e2e-config.json", "utf8"));
const readyAt = Math.max(...pending.operations.map((op) => Number(op.readyAt)));
const now = Math.floor(Date.now() / 1000);
const waitSec = Math.max(0, readyAt - now + 45);
console.log(`Waiting ${waitSec}s until readyAt=${readyAt} (+45s buffer)...`);
await new Promise((r) => setTimeout(r, waitSec * 1000));
console.log("Executing E2E config...");
const child = spawn(process.execPath, ["scripts/execute-e2e-config.mjs"], {
  stdio: "inherit",
  env: process.env,
});
child.on("exit", (code) => {
  console.log(`execute-e2e-config exited ${code}`);
  process.exit(code ?? 1);
});
