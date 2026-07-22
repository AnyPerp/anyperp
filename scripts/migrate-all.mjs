/**
 * Apply database/migrations/*.sql in order against DATABASE_URL.
 * Safe for Neon / local Postgres. Skips empty files. Stops on first error.
 *
 * Usage: node scripts/migrate-all.mjs
 *        DATABASE_URL=... node scripts/migrate-all.mjs
 */
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import pg from "pg";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const dir = path.join("database", "migrations");
const files = fs.readdirSync(dir)
  .filter((name) => name.endsWith(".sql"))
  .sort();

const pool = new pg.Pool({ connectionString: databaseUrl, application_name: "anyperp-migrate" });

await pool.query(`
  create table if not exists schema_migrations (
    filename text primary key,
    applied_at timestamptz not null default now()
  )
`);

for (const file of files) {
  const already = await pool.query("select 1 from schema_migrations where filename=$1", [file]);
  if (already.rowCount) {
    console.log(`skip ${file} (already applied)`);
    continue;
  }
  const sql = fs.readFileSync(path.join(dir, file), "utf8");
  const client = await pool.connect();
  try {
    // 001/002 may contain their own BEGIN/COMMIT; run as a single script.
    await client.query(sql);
    await client.query("insert into schema_migrations(filename) values ($1) on conflict do nothing", [file]);
    console.log(`applied ${file}`);
  } catch (error) {
    console.error(`failed ${file}:`, error instanceof Error ? error.message : error);
    process.exitCode = 1;
    client.release();
    await pool.end();
    process.exit(1);
  }
  client.release();
}

await pool.end();
console.log("migrations complete");
