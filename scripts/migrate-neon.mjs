import fs from "node:fs";
import pg from "pg";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL required");
  process.exit(1);
}

const sql = fs.readFileSync("database/migrations/001_initial.sql", "utf8");
const pool = new pg.Pool({
  connectionString: url,
  ssl: url.includes("sslmode=require") || url.includes("neon.tech") ? { rejectUnauthorized: false } : undefined,
  connectionTimeoutMillis: 30_000,
});

try {
  const hello = await pool.query("select current_database() as db, current_user as u");
  console.log("connected", hello.rows[0]);
  const existing = await pool.query(
    "select count(*)::int as n from information_schema.tables where table_schema = 'public'",
  );
  console.log("public_tables_before", existing.rows[0].n);
  if (existing.rows[0].n > 0) {
    console.log("schema already has tables; skipping full migrate (idempotent skip)");
  } else {
    await pool.query(sql);
    console.log("migration 001_initial applied");
  }
  const after = await pool.query(
    "select count(*)::int as n from information_schema.tables where table_schema = 'public'",
  );
  console.log("public_tables_after", after.rows[0].n);
} catch (error) {
  console.error("migrate failed:", error.message);
  process.exit(1);
} finally {
  await pool.end();
}
