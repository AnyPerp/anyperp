# Host the full testnet stack (required for public beta)

Frontend on Vercel alone is **not** a full product. You also need:

| Process | Command | Needs |
|---------|---------|--------|
| API | `pnpm api:dev` (or `tsx services/api/src/server.ts`) | `DATABASE_URL`, `CORS_ORIGINS`, protocol addresses |
| Indexer | `pnpm indexer:dev` | `DATABASE_URL`, `INDEXED_CONTRACT_ADDRESSES` / factory |
| Keepers | `pnpm keepers:dev` | `REDIS_URL`, `KEEPER_PRIVATE_KEY`, registry, liq engine |
| Oracle push (mock) | `pnpm oracle:push:loop` | Mock adapter addresses, pusher key |
| Postgres | Neon or Docker | Apply `001_initial.sql` + `002_projections.sql` |
| Redis | Upstash / Docker | BullMQ queue |

## One-time DB

```bash
# Local
docker compose up -d postgres redis
export DATABASE_URL=postgresql://anyperp:anyperp@localhost:5432/anyperp
node scripts/migrate-all.mjs

# Neon
# set DATABASE_URL in .env then:
node scripts/migrate-all.mjs
```

If `001_initial.sql` was already applied manually (Neon day-0) and `migrate-all` errors on re-create:

```sql
create table if not exists schema_migrations (
  filename text primary key,
  applied_at timestamptz not null default now()
);
insert into schema_migrations(filename) values ('001_initial.sql') on conflict do nothing;
```

Then re-run `node scripts/migrate-all.mjs` so only `002_projections.sql` applies.

## Env checklist (server)

Copy from `deployments/HOST_ENV.example` plus:

```bash
DATABASE_URL=...
REDIS_URL=redis://...
MARKET_FACTORY_ADDRESS=0xd1e154498a382074cf66f3274244d55b80b1a52d
MARKET_REGISTRY_ADDRESS=0xbdd1ab0bf5ea2846e05d80771958332f328e6da3
ORACLE_ROUTER_ADDRESS=0xd9e74c0ebdfbb9538b63fe5d7e4456456ef4a13b
LIQUIDATION_ENGINE_ADDRESS=0x381c70f1eead30094543e544fab0bae3d412f212
TRIGGER_ORDER_MANAGER_ADDRESS=0x6ca42a07fb4bf7ff5125a971a188a47670ed4b45
INDEXED_CONTRACT_ADDRESSES=<factory>,<registry>,<oracle>,...
KEEPER_PRIVATE_KEY=0x...   # NOT deployer
CORS_ORIGINS=https://anyperp.fun,https://www.anyperp.fun,http://localhost:3000
HOST=0.0.0.0
PORT=4000
```

Frontend host:

```bash
NEXT_PUBLIC_API_URL=https://api.your-host.example
NEXT_PUBLIC_WS_URL=wss://api.your-host.example/ws
```

## Health checks

```bash
curl -s https://api.your-host.example/health/live
curl -s https://api.your-host.example/health/ready
curl -s https://api.your-host.example/v1/ops/status
curl -s https://api.your-host.example/v1/projections/markets
```

`/v1/ops/status` should show `projections.available: true` after migration 002 + indexer catch-up.

## Process supervision

Use Railway / Fly / systemd / pm2 — one service each for api, indexer, keepers, oracle-push.  
Do not run keepers with the deployer key. Fund keeper with test ETH only.

## Railway (optional)

Repo has `railway.toml` + `Dockerfile` for the **frontend** image by default.  
API/indexer/keepers should be **separate** services with the same image/repo but different start commands:

- API: `pnpm api:dev` or `tsx services/api/src/server.ts`
- Indexer: `pnpm indexer:dev`
- Keepers: `pnpm keepers:dev`

Attach Neon Postgres + Redis plugins; inject env vars above.

## Honesty

- Unaudited testnet  
- Mock apUSD / mock oracle when flags on  
- Projections lag reorgs; chain is authoritative  
