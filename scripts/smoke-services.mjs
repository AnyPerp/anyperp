import fs from "node:fs";
import path from "node:path";

const api = process.env.SMOKE_API_URL ?? "http://127.0.0.1:4000";
const frontend = process.env.SMOKE_FRONTEND_URL ?? "http://localhost:3000";
const results = [];
const failures = [];

async function check(name, action) {
  try {
    const detail = await action();
    results.push({ name, status: "pass", detail });
    console.log(`PASS ${name}`);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    failures.push({ name, status: "fail", detail });
    console.log(`FAIL ${name} — ${detail}`);
  }
}

async function request(url, options = {}, expected = 200) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(8_000) });
  const text = await response.text();
  if (response.status !== expected) throw new Error(`expected ${expected}, received ${response.status}: ${text.slice(0, 240)}`);
  return { status: response.status, type: response.headers.get("content-type"), body: text.slice(0, 500) };
}

for (const [name, url] of [
  ["frontend landing", frontend],
  ["frontend docs entry", `${frontend}/?surface=docs`],
  ["frontend app entry", `${frontend}/?surface=app`],
  ["responsive SVG asset", `${frontend}/anyperp-hero.svg`],
  ["API liveness", `${api}/health/live`],
  ["API readiness", `${api}/health/ready`],
  ["API ops status", `${api}/v1/ops/status`],
  ["API metrics", `${api}/metrics`],
  ["chains query", `${api}/v1/chains`],
  ["tokens query", `${api}/v1/tokens?limit=5`],
  ["markets query", `${api}/v1/markets?limit=5`],
  ["projections markets", `${api}/v1/projections/markets?limit=5`],
  ["projections open accounts", `${api}/v1/projections/open-accounts?limit=5`],
  ["projections trades", `${api}/v1/projections/trades?limit=5`],
  ["unknown token eligibility", `${api}/v1/tokens/0x0000000000000000000000000000000000000001/eligibility`],
  ["portfolio query", `${api}/v1/accounts/0x0000000000000000000000000000000000000001/portfolio`],
  ["orders query", `${api}/v1/accounts/0x0000000000000000000000000000000000000001/orders`],
  ["transactions query", `${api}/v1/accounts/0x0000000000000000000000000000000000000001/transactions`],
]) await check(name, () => request(url));

const risk = {
  initialMarginBps: "1000", maintenanceMarginBps: "500", maxOpenInterestWad: "1000000000000000000000",
  maxSkewWad: "10000000000000000000", maxPositionWad: "100000000000000000000", maxUtilizationBps: "9000",
  maxPriceImpactBps: "100", tradingFeeBps: "10", liquidationPenaltyBps: "500", minSeedLiquidityWad: "100000000000000000000",
  minInsuranceWad: "10000000000000000000", minOracleLiquidityWad: "100000000000000000000", minOracleHistory: "86400",
  maxOracleConfidenceBps: "100", maxOracleDeviationBps: "500", oracleMaxAge: "3600", minOracleSources: 2,
  minCreatorBondWad: "1000000000000000000000", baseSpreadBps: "10", longPayoutStressBps: "90000",
  shortPayoutStressBps: "10000", fundingVelocityWad: "1000000000000", maxFundingRatePerSecondWad: "1000000000000",
  maxFundingAccrualSeconds: "3600",
};
const prepareBody = {
  factory: "0x1111111111111111111111111111111111111111",
  params: {
    baseToken: "0x0000000000000000000000000000000000000001",
    collateralToken: "0x0000000000000000000000000000000000000002",
    tier: 3,
    risk,
    oracleRouteId: `0x${"11".repeat(32)}`,
    creatorBond: "1000000",
    userSalt: `0x${"22".repeat(32)}`,
  },
};
await check("market calldata preparation", () => request(`${api}/v1/markets/prepare`, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(prepareBody),
}));

await check("order calldata preparation", () => request(`${api}/v1/orders/prepare`, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
    kind: "market", market: "0x0000000000000000000000000000000000000003", sizeDeltaWad: "1000000000000000000",
    acceptablePriceWad: "100000000000000000", deadline: Math.floor(Date.now() / 1000) + 300,
  }),
}));
await check("liquidation calldata preparation", () => request(`${api}/v1/liquidations/0x0000000000000000000000000000000000000001/prepare`, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
    engine: "0x0000000000000000000000000000000000000004", market: "0x0000000000000000000000000000000000000003",
    maxCloseNotionalWad: "100000000000000000000",
  }),
}));
await check("invalid order rejected as client error", () => request(`${api}/v1/orders/prepare`, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}),
}, 400));
await check("expired order rejected", () => request(`${api}/v1/orders/prepare`, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
    kind: "market", market: "0x0000000000000000000000000000000000000003", sizeDeltaWad: "1",
    acceptablePriceWad: "1", deadline: 1,
  }),
}, 400));

await check("WebSocket ready event", () => new Promise((resolve, reject) => {
  const socket = new WebSocket(api.replace(/^http/, "ws") + "/ws");
  const timer = setTimeout(() => { socket.close(); reject(new Error("timeout waiting for system.ready")); }, 5_000);
  socket.onmessage = (event) => {
    const message = JSON.parse(String(event.data));
    if (message.topic !== "system.ready" || message.chainId !== 46630) return;
    clearTimeout(timer);
    socket.close();
    resolve(message);
  };
  socket.onerror = () => { clearTimeout(timer); reject(new Error("WebSocket connection failed")); };
}));

const report = { status: failures.length ? "fail" : "pass", results, failures, generatedAt: new Date().toISOString() };
fs.mkdirSync("build", { recursive: true });
fs.writeFileSync(path.join("build", "smoke-services.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log(`SERVICE SMOKE ${report.status.toUpperCase()}: ${results.length} passed, ${failures.length} failed`);
if (failures.length) process.exitCode = 1;
