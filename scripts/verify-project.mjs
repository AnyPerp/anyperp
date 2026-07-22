import fs from "node:fs";
import path from "node:path";

const failures = [];
const checks = [];
function check(name, condition, detail = "") {
  checks.push({ name, passed: Boolean(condition), detail });
  if (!condition) failures.push(`${name}${detail ? `: ${detail}` : ""}`);
}

const specPath = path.join("docs", "ANYPERP_PROTOCOL_SPEC.md");
const spec = fs.readFileSync(specPath, "utf8");
for (let i = 1; i <= 32; i += 1) check(`spec section ${i}`, new RegExp(`^# ${i}\\.`, "m").test(spec));
const mermaidCount = (spec.match(/```mermaid/g) ?? []).length;
check("required Mermaid diagrams", mermaidCount >= 12, `found ${mermaidCount}, expected at least 12`);
check("access dates", (spec.match(/accessed 2026-07-15/gi) ?? []).length >= 15);
check("fact taxonomy", ["Verified fact", "Reasonable assumption", "Proposed decision", "Open question", "Prototype validation"].every((label) => spec.includes(label)));
check("mainnet disclaimer", /no mainnet|mainnet.*blank|testnet-only/i.test(spec));

const requiredContracts = ["MarketFactory","MarketRegistry","Market","PositionManager","MarginManager","CollateralVault","LiquidityVault","OracleRouter","FundingEngine","RiskManager","LiquidationEngine","MarketInsuranceFund","FeeManager","KeeperRegistry","GovernanceTimelock","EmergencyGuardian","TriggerOrderManager","ProtocolBackstop"];
for (const name of requiredContracts) check(`contract artifact ${name}`, fs.existsSync(path.join("contracts", "out", `${name}.json`)));
const marketArtifact = JSON.parse(fs.readFileSync(path.join("contracts", "out", "Market.json"), "utf8"));
const marketFunctions = new Set(marketArtifact.abi.filter((item) => item.type === "function").map((item) => item.name));
for (const fn of ["depositMargin","withdrawMargin","executeTrade","updateFunding","liquidateFromEngine","beginSettlement","finalizeSettlement","claimSettlement"]) check(`Market.${fn}`, marketFunctions.has(fn));

const sql = fs.readFileSync(path.join("database", "migrations", "001_initial.sql"), "utf8");
for (const table of ["chains","tokens","markets","oracle_prices","orders","trades","positions","liquidations","blocks","contract_events","risk_alerts","audit_logs"]) check(`SQL ${table}`, new RegExp(`CREATE TABLE ${table}\\b`, "i").test(sql));
check("reorg identity", sql.includes("canonical_event_ingestion_key") && sql.includes("confirmation_status"));

for (const file of ["app/page.tsx","services/api/src/server.ts","services/indexer/src/indexer.ts","services/keepers/src/worker.ts","simulations/anyperp/model.py","docker-compose.yml",".github/workflows/ci.yml"]) check(`file ${file}`, fs.existsSync(file));

const report = {
  generatedAt: new Date().toISOString(),
  status: failures.length ? "failed" : "passed",
  checksPassed: checks.filter((item) => item.passed).length,
  checksFailed: failures.length,
  checks,
  blockersNotClaimedAsPassed: [
    "browser-wallet lifecycle against a fresh Robinhood testnet deployment",
    "real Chainlink and DEX TWAP adapter configuration",
    "production-grade settlement TWAP, collateral depeg accounting, and complete ADL",
    "decoded indexer projections, finality promotion, and automated keeper scanners",
    "Foundry stateful fuzz/invariants and Slither",
    "external audits and formal review",
    "economic calibration and legal approval",
  ],
};
fs.writeFileSync(path.join("docs", "VERIFICATION_REPORT.json"), `${JSON.stringify(report, null, 2)}\n`);
if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log(`Verification passed ${report.checksPassed} structural and interface checks; ${report.blockersNotClaimedAsPassed.length} external blockers remain explicit.`);
