<p align="center">
  <img src="public/github/github-og-light.png" alt="AnyPerp — Any token. A perp. Today." width="100%" />
</p>

<p align="center">
  <a href="https://anyperp.fun">Website</a> ·
  <a href="https://anyperp.fun/?surface=app">App</a> ·
  <a href="https://anyperp.fun/?surface=docs">Docs</a> ·
  <a href="https://x.com/tradeanyperp">X</a> ·
  <a href="https://github.com/AnyPerp">Org</a>
</p>

<p align="center">
  <img alt="status" src="https://img.shields.io/badge/status-testnet%20prototype-2d6a4f?style=flat-square" />
  <img alt="audit" src="https://img.shields.io/badge/audit-unaudited-6c757d?style=flat-square" />
  <img alt="license" src="https://img.shields.io/badge/license-MIT-0b7285?style=flat-square" />
  <img alt="chain" src="https://img.shields.io/badge/chain-RHC%20testnet%2046630-1b4332?style=flat-square" />
</p>

# AnyPerp

Unaudited testnet prototype for permissionless, isolated perpetual markets on Robinhood Chain.

**Site:** [anyperp.fun](https://anyperp.fun)  
**Tagline:** *Any token. A perp. Today.*

> **Not affiliated with Robinhood.** Do **not** use with real funds. This software is provided as-is under the MIT License with no warranty.

## What this repo is

Open-source engineering surface for the AnyPerp testnet stack:

| Path | Contents |
|------|----------|
| `contracts/src` | Solidity factory, isolated markets/vaults, oracle, funding, liquidation, governance, mocks |
| `contracts/test` | Foundry-style / protocol math tests |
| `simulations` | Python decimal reference model and unit tests |
| `database/migrations` | PostgreSQL schema (canonical + projection tables) |
| `services` | Fastify API, reorg-aware indexer, BullMQ keepers |
| `packages/sdk` | Chain helpers, ABIs, fixed-point utilities |
| `app` | Trading / creation / liquidity / portfolio UI |
| `scripts` | Compile, migrate, verify, gated testnet deploy |
| `configs` | `testnet.json` / `mainnet.json` / `anvil.json` network profiles |
| `deployments` | Public testnet address manifests (no secrets) |
| `ops` | Local stack notes and incident runbooks |
| `public` | Static brand assets |
| `tests` | Frontend / render checks |

Internal product docs, marketing plans, admin tooling, host credentials, and media production assets are **not** published in this repository.

## Security status

Compilation and included tests are engineering checks, **not** an audit. Real-funds use is blocked until real oracles, economic safety proofs, independent audits, legal review, and operational readiness.

See [SECURITY.md](./SECURITY.md) for reporting guidance.

## Requirements

- Node.js **22+**
- [pnpm](https://pnpm.io) `11.13.0` (via Corepack)
- Python **3.12+** (simulations)
- Optional: Docker (Postgres/Redis), Foundry

## Quick start

```bash
# 1) Config (never commit real keys)
cp .env.example .env

# 2) Install
corepack enable
corepack pnpm install --frozen-lockfile

# 3) Compile contracts + unit tests
pnpm contracts:compile
pnpm test:unit
python -m pytest simulations/tests

# 4) Local infra
docker compose up -d postgres redis
# apply database/migrations/*.sql (or pnpm db:migrate with DATABASE_URL set)

# 5) Run processes (separate terminals)
pnpm api:dev
pnpm indexer:dev
pnpm keepers:dev
pnpm dev
```

## Environment

| File | Purpose |
|------|---------|
| `.env.example` | Full local/testnet template (empty secrets) |
| `.env.required.example` | Minimum owner-supplied deploy roles |
| `configs/testnet.json` | Chain `46630` profile |
| `configs/mainnet.json` | Placeholder; deploy gates block reckless mainnet |

Required secrets (local only):

- `DEPLOYER_PRIVATE_KEY` — fresh testnet key
- `KEEPER_PRIVATE_KEY` — separate low-balance keeper
- `DATABASE_URL` / `REDIS_URL` — local or your own managed services

Never reuse keys that have been shared in chat or committed anywhere.

## Launch pipeline (testnet → mainnet)

```bash
pnpm launch:check                          # readiness checklist
pnpm launch --env testnet --write-host-env # host env template
pnpm launch --env testnet --deploy         # deploy (needs keys)
pnpm launch --env mainnet --require-gates  # blocked until mainnet gates pass
```

Feature flags (`NEXT_PUBLIC_PUBLIC_FAUCET`, mock oracle, mintable collateral) are **on** for testnet and **must be off** for mainnet.

## Public surfaces

One deployable frontend with three surfaces:

- `anyperp.fun` — public landing
- docs surface — `?surface=docs`
- app surface — `?surface=app`

Set `NEXT_PUBLIC_SITE_URL`, `NEXT_PUBLIC_DOCS_URL`, and `NEXT_PUBLIC_APP_URL` for your host.

## Testnet deployments

Public address manifests live under `deployments/` (for example `46630-latest.json`).  
A successful manifest should pass:

```bash
node scripts/verify-deployment.mjs deployments/46630-latest.json
```

## CI

GitHub Actions workflow (`.github/workflows/ci.yml`) runs install, contract compile, unit tests, Python tests, lint, build, and smoke checks on `main` and pull requests.

## License

[MIT](./LICENSE) — Copyright (c) 2026 AnyPerp contributors.
