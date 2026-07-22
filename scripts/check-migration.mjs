import fs from "node:fs";
import path from "node:path";

const sql001 = fs.readFileSync("database/migrations/001_initial.sql", "utf8");
const required = [
  "chains","tokens","users","wallets","markets","market_parameters","market_state_history",
  "oracle_sources","oracle_prices","liquidity_vaults","liquidity_deposits","liquidity_withdrawals",
  "orders","trades","positions","position_events","collateral_balances","funding_rates","funding_payments",
  "liquidations","insurance_fund_events","protocol_fees","market_creator_rewards","keeper_jobs",
  "transactions","blocks","contract_events","notifications","governance_proposals","governance_votes",
  "risk_alerts","audit_logs",
];
const missing = required.filter((table) => !new RegExp(`create\\s+table\\s+${table}\\b`, "i").test(sql001));
if (missing.length) throw new Error(`Missing tables in 001: ${missing.join(", ")}`);
for (const invariant of ["canonical_event_ingestion_key", "confirmation_status", "PARTITION BY RANGE", "deleted_at"]) {
  if (!sql001.includes(invariant)) throw new Error(`Migration 001 lacks ${invariant}`);
}

const projPath = path.join("database", "migrations", "002_projections.sql");
if (!fs.existsSync(projPath)) throw new Error("Missing database/migrations/002_projections.sql");
const sql002 = fs.readFileSync(projPath, "utf8");
const projected = ["projected_markets", "projected_open_accounts", "projected_trades", "projection_cursors"];
const missingProj = projected.filter((table) => !new RegExp(`create\\s+table\\s+if\\s+not\\s+exists\\s+${table}\\b`, "i").test(sql002));
if (missingProj.length) throw new Error(`Missing projection tables in 002: ${missingProj.join(", ")}`);

console.log(`Migration 001: ${required.length} tables + reorg markers. Migration 002: ${projected.length} projection tables.`);
