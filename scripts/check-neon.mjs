import pg from "pg";
const url = process.env.DATABASE_URL;
const pool = new pg.Pool({
  connectionString: url,
  ssl: { rejectUnauthorized: false },
});
const r = await pool.query(
  "select count(*)::int as n from pg_tables where schemaname = 'public'",
);
const names = await pool.query(
  "select tablename from pg_tables where schemaname = 'public' order by 1 limit 15",
);
console.log("tables", r.rows[0].n);
console.log(names.rows.map((x) => x.tablename).join(", "));
await pool.end();
