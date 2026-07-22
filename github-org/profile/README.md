<!--
  GitHub Organization profile README
  Repo: AnyPerp/.github  →  profile/README.md
  Renders on https://github.com/AnyPerp
-->

<div align="center">

<img src="https://raw.githubusercontent.com/AnyPerp/anyperp/main/public/logo/anyperp-logo.svg" alt="AnyPerp" width="72" height="72" />

# AnyPerp

**Any token. A perp. Today.**

Permissionless, isolated perpetual markets on Robinhood Chain.

[Website](https://anyperp.fun) · [App](https://anyperp.fun/?surface=app) · [Docs surface](https://anyperp.fun/?surface=docs) · [Main repository](https://github.com/AnyPerp/anyperp) · [X](https://x.com/tradeanyperp)

<br />

![status](https://img.shields.io/badge/status-testnet%20prototype-2d6a4f?style=flat-square)
![audit](https://img.shields.io/badge/audit-unaudited-6c757d?style=flat-square)
![license](https://img.shields.io/badge/license-MIT-0b7285?style=flat-square)
![chain](https://img.shields.io/badge/chain-Robinhood%20testnet%2046630-1b4332?style=flat-square)
![funds](https://img.shields.io/badge/real%20funds-not%20supported-ae2012?style=flat-square)

</div>

---

## What is AnyPerp?

AnyPerp is a **factory for isolated, oracle-priced perpetual markets**. A creator points at an existing ERC-20 on Robinhood Chain, picks a registered oracle route and risk tier, posts a bond, seeds market-local LP and insurance capital, and activates trading only when mechanical checks pass.

| | |
|---|---|
| **Product** | Isolated peer-to-pool perps (one market = one risk container) |
| **Network** | Robinhood Chain testnet `46630` (EVM / Arbitrum-style L2) |
| **Collateral** | Supported USD-style collateral only in the MVP (no coin margin) |
| **Affiliation** | **Not** a Robinhood product; not endorsed by Robinhood Markets, Inc. |
| **Safety** | Unaudited engineering prototype — **do not use real funds** |

Open factory ≠ open liability. Anyone may deploy a candidate; the contracts activate only after oracle quality, capital buffers, and tier envelopes clear.

---

## Why AnyPerp exists

Listing a perp is expensive: oracles, insurance, liquidations, and monitoring do not appear the moment a spot token does.

- **Traders** need a transparent way to long/short early tokens without opaque OTC.
- **Creators / projects** need a neutral path to seed isolated liquidity — not a discretionary listing desk.
- **LPs** should underwrite **one named market**, not an unrestricted shared portfolio of long-tail risk.

Shared mega-vaults and creator-controlled prices fail that brief. Isolation and mechanical admission are the point.

---

## Core capabilities

| Capability | Description |
|---|---|
| **Permissionless create** | Any account can deploy a market candidate with bond + salt (CREATE2). |
| **Mechanical activation** | Validate → seed LP/insurance → activate only if oracle + capital + tier pass in-tx. |
| **Isolated vaults** | Per market: collateral vault, LP vault, insurance fund — no cross-market debit. |
| **Oracle-priced execution** | Index from registered adapters; fill at index ± bounded skew impact. |
| **Risk tiers** | Blue-chip → experimental envelopes; creators may tighten, never loosen. |
| **Funding** | Checkpointed, zero-sum long↔short accrual (not protocol revenue). |
| **Liquidations** | Permissionless partial/full close; penalty capped by remaining margin. |
| **Triggers** | On-chain limit/stop records with keeper execution fee. |
| **Governance** | Timelocked parameters; guardian can only pause / reduce-only. |
| **Off-chain stack** | Reorg-aware indexer, Fastify API, BullMQ keepers, wallet UI. |

---

## How it works

```text
Creator                     Protocol                         Traders / LPs / Keepers
   |                           |                                      |
   |-- createMarket + bond --->|  Market + 3 vaults (Pending)         |
   |-- validate -------------->|  OracleRouter + RiskManager          |
   |-- seed LP / insurance --->|  Bootstrapping                       |
   |-- activate -------------->|  Active (same-tx recheck)            |
   |                           |<-- deposit / trade / liquidate ------|
   |                           |<-- LP queue / funding / triggers -----|
```

1. **Create** — factory deploys immutable market instance + vaults; bond locked.
2. **Validate** — registered multi-source route, freshness, deviation, tier envelope.
3. **Seed** — isolated LP capital and insurance; exact token balance accounting.
4. **Activate** — revalidation in the same transaction; state → `Active`.
5. **Trade** — isolated margin; skew-aware execution; fees split per `FeeManager`.
6. **Contain** — bad debt stays inside that market’s insurance → capped backstop → ADL path.

---

## Architecture (high level)

| Layer | Contents |
|---|---|
| **Contracts** | `MarketFactory`, `Market`, vaults, `OracleRouter`, adapters, `RiskManager`, funding/fees/liquidation, timelock, guardian |
| **Simulations** | Python decimal reference model + stress tests |
| **Data** | PostgreSQL migrations; canonical + orphaned event model |
| **Services** | API · indexer · keepers (TypeScript / Fastify / BullMQ) |
| **App** | Landing · docs surface · trading / create / LP UI |
| **Ops** | Docker Compose, Railway/Vercel configs, incident runbooks |

```text
UI / Wallet ──RPC──► Robinhood Chain (AnyPerp contracts + oracles)
    │
    └── API / WS ◄── Indexer ◄── logs
                      Keepers ──► funding · liq · triggers · withdrawals
```

---

## Repository map

| Path | Role |
|---|---|
| [`anyperp`](https://github.com/AnyPerp/anyperp) | Main monorepo — contracts, services, app, scripts, configs |
| `contracts/src` | Solidity protocol modules |
| `services/*` | API, indexer, keepers |
| `simulations/` | Economic reference model |
| `deployments/` | Public testnet address manifests (no secrets) |
| `SECURITY.md` | Vulnerability reporting expectations |

---

## Build & verify (local)

```bash
git clone https://github.com/AnyPerp/anyperp.git
cd anyperp
cp .env.example .env          # never commit real keys
corepack enable
corepack pnpm install --frozen-lockfile
pnpm contracts:compile
pnpm test:unit
python -m pytest simulations/tests
pnpm build
```

See the [main README](https://github.com/AnyPerp/anyperp#readme) for full stack startup (Postgres, Redis, API, indexer, keepers, UI).

---

## Security status

| Gate | Status |
|---|---|
| Open-source engineering surface | Available |
| Independent smart-contract audit | Not completed |
| Economic / manipulation calibration | In progress (testnet) |
| Real-funds / mainnet | **Blocked** |
| Mock oracle / faucet flags | Testnet only — must be off for mainnet |

Report vulnerabilities privately per [`SECURITY.md`](https://github.com/AnyPerp/anyperp/blob/main/SECURITY.md). Do not open public issues for exploitable bugs.

---

## Explore

- **Website:** [anyperp.fun](https://anyperp.fun)
- **Source:** [github.com/AnyPerp/anyperp](https://github.com/AnyPerp/anyperp)
- **Social preview assets:** [`public/github/`](https://github.com/AnyPerp/anyperp/tree/main/public/github)
- **X:** [@tradeanyperp](https://x.com/tradeanyperp)

---

<div align="center">

**AnyPerp** is open source under the [MIT License](https://github.com/AnyPerp/anyperp/blob/main/LICENSE).

Not affiliated with Robinhood. Unaudited. Testnet research only.

</div>
