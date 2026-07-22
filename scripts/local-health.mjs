import pg from "pg";
import IORedis from "ioredis";

const databaseUrl = process.env.DATABASE_URL ?? "postgresql://anyperp:anyperp@localhost:5433/anyperp";
const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6380";
const apiUrl = process.env.API_URL ?? "http://127.0.0.1:4000";
const frontendUrl = process.env.FRONTEND_URL ?? "http://localhost:3000";

const report = {};
const pool = new pg.Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 5_000 });
try {
  const result = await pool.query("select count(*)::int as table_count from information_schema.tables where table_schema='public'");
  report.postgres = { ok: true, tableCount: result.rows[0].table_count };
} catch (error) {
  report.postgres = { ok: false, error: error.message };
} finally {
  await pool.end();
}

const redis = new IORedis(redisUrl, { connectTimeout: 5_000, maxRetriesPerRequest: 1, retryStrategy: () => null });
try {
  report.redis = { ok: (await redis.ping()) === "PONG" };
} catch (error) {
  report.redis = { ok: false, error: error.message };
} finally {
  redis.disconnect();
}

for (const [name, url] of [["api", `${apiUrl}/health/ready`], ["frontend", frontendUrl]]) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
    report[name] = { ok: response.ok, status: response.status };
  } catch (error) {
    report[name] = { ok: false, error: error.message };
  }
}

report.ok = Object.values(report).every((value) => typeof value !== "object" || value.ok !== false);
console.log(JSON.stringify(report, null, 2));
if (!report.ok) process.exit(1);
