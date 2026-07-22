/**
 * Apply schema_migrations tracking + 002_projections when 001 already exists (Neon).
 * Uses DATABASE_URL from .env. SSL relaxed for Neon pooler.
 */
import "dotenv/config";
import fs from "node:fs";
import pg from "pg";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL required");
  process.exit(1);
}

const pool = new pg.Pool({
  connectionString: databaseUrl,
  ssl: { rejectUnauthorized: false },
  application_name: "anyperp-migrate-neon",
});

await pool.query(`
  create table if not exists schema_migrations (
    filename text primary key,
    applied_at timestamptz not null default now()
  )
`);

// 001 is already on Neon (type confirmation_status exists).
await pool.query(
  `insert into schema_migrations(filename) values ($1) on conflict do nothing`,
  ["001_initial.sql"],
);
console.log("001_initial.sql marked applied (existing Neon schema)");

const has002 = await pool.query(
  `select 1 from schema_migrations where filename = $1`,
  ["002_projections.sql"],
);

if (has002.rowCount) {
  console.log("002_projections.sql already applied");
} else {
  const sql = fs.readFileSync("database/migrations/002_projections.sql", "utf8");
  await pool.query(sql);
  await pool.query(
    `insert into schema_migrations(filename) values ($1) on conflict do nothing`,
    ["002_projections.sql"],
  );
  console.log("002_projections.sql applied");
}

const tables = await pool.query(`
  select table_name from information_schema.tables
  where table_schema = 'public'
    and (table_name like 'projected%' or table_name = 'projection_cursors')
  order by 1
`);
console.log(
  "projection tables:",
  tables.rows.map((r) => r.table_name).join(", ") || "none",
);

await pool.end();
console.log("neon migrate complete");
