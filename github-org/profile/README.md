<!--
  GitHub Organization profile README
  Repo: AnyPerp/.github  â†’  profile/README.md
  Renders on https://github.com/AnyPerp
-->

<div align="center">

<img src="https://raw.githubusercontent.com/AnyPerp/anyperp/main/public/logo/anyperp-logo.svg" alt="AnyPerp" width="72" height="72" />

# AnyPerp

**Any token. A perp. Today.**

Permissionless, isolated perpetual markets on Robinhood Chain.

[Website](https://anyperp.fun) Â· [App](https://anyperp.fun/?surface=app) Â· [Docs surface](https://anyperp.fun/?surface=docs) Â· [Main repository](https://github.com/AnyPerp/anyperp) Â· [X](https://x.com/tradeanyperp)

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
| **Safety** | Unaudited engineering prototype â€” **do not use real funds** |

Open factory â‰  open liability. Anyone may deploy a candidate; the contracts activate only after oracle quality, capital buffers, and tier envelopes clear.

---

---

## Deployed contracts (Robinhood Chain testnet `46630`)

Public addresses from the live AnyPerp testnet suite. **Unaudited.** Verify bytecode on the explorer before integrating. Source of truth: [`deployments/46630-latest.json`](https://github.com/AnyPerp/anyperp/blob/main/deployments/46630-latest.json).

Explorer base: [explorer.testnet.chain.robinhood.com](https://explorer.testnet.chain.robinhood.com)

### Core protocol

| Contract | Role | Address |
|---|---|---|
| **apUSD** (MockCollateral) | Mintable test USD — margin & LP | [`0x8f3e02f6ae47ec0e5ff5dcd4dd1bfbd3c1fed2f0`](https://explorer.testnet.chain.robinhood.com/address/0x8f3e02f6ae47ec0e5ff5dcd4dd1bfbd3c1fed2f0) |
| **MarketFactory** | Deploys isolated markets | [`0xd1e154498a382074cf66f3274244d55b80b1a52d`](https://explorer.testnet.chain.robinhood.com/address/0xd1e154498a382074cf66f3274244d55b80b1a52d) |
| **MarketRegistry** | Canonical market directory | [`0xbdd1ab0bf5ea2846e05d80771958332f328e6da3`](https://explorer.testnet.chain.robinhood.com/address/0xbdd1ab0bf5ea2846e05d80771958332f328e6da3) |
| **LaunchHelper** | One-tx create (CA → live market) | [`0xaec57bd44a14302c9d157f1ba14c0b664f00209c`](https://explorer.testnet.chain.robinhood.com/address/0xaec57bd44a14302c9d157f1ba14c0b664f00209c) |
| **OracleRouter** | Price routes / adapters | [`0xd9e74c0ebdfbb9538b63fe5d7e4456456ef4a13b`](https://explorer.testnet.chain.robinhood.com/address/0xd9e74c0ebdfbb9538b63fe5d7e4456456ef4a13b) |
| **LiquidationEngine** | Liquidations | [`0x381c70f1eead30094543e544fab0bae3d412f212`](https://explorer.testnet.chain.robinhood.com/address/0x381c70f1eead30094543e544fab0bae3d412f212) |
| **TriggerOrderManager** | Triggers / TP-SL rails | [`0x6ca42a07fb4bf7ff5125a971a188a47670ed4b45`](https://explorer.testnet.chain.robinhood.com/address/0x6ca42a07fb4bf7ff5125a971a188a47670ed4b45) |
| **MarketLens** | Read helpers / views | [`0xbbb2b1585f6b5ea0fe0c2e587a6f8b386eb60c97`](https://explorer.testnet.chain.robinhood.com/address/0xbbb2b1585f6b5ea0fe0c2e587a6f8b386eb60c97) |
| **RiskManager** | Risk params / tiers | [`0x084e967a17b550075674c502de1a845583da3d05`](https://explorer.testnet.chain.robinhood.com/address/0x084e967a17b550075674c502de1a845583da3d05) |
| **ProtocolBackstop** | Capped backstop | [`0xf8c10cb2d201deae44b3849631f7d9e4696e25c5`](https://explorer.testnet.chain.robinhood.com/address/0xf8c10cb2d201deae44b3849631f7d9e4696e25c5) |

### Supporting modules

| Contract | Address |
|---|---|
| **FundingEngine** | [`0x165560af67525ac40f2139060735f1f0113a1403`](https://explorer.testnet.chain.robinhood.com/address/0x165560af67525ac40f2139060735f1f0113a1403) |
| **FeeManager** | [`0x430da704ae8ee82752ff9ed30f6eb0727b456682`](https://explorer.testnet.chain.robinhood.com/address/0x430da704ae8ee82752ff9ed30f6eb0727b456682) |
| **KeeperRegistry** | [`0xb650dc5b5dbc6da3984259ba924e22403039ed89`](https://explorer.testnet.chain.robinhood.com/address/0xb650dc5b5dbc6da3984259ba924e22403039ed89) |
| **EmergencyGuardian** | [`0xaadd1a1ab022389b47f0f945a0fa96c240c75fb1`](https://explorer.testnet.chain.robinhood.com/address/0xaadd1a1ab022389b47f0f945a0fa96c240c75fb1) |
| **MarketImplementation** | [`0x4f7c22822bbeedce686efb38ce3de42be07f7082`](https://explorer.testnet.chain.robinhood.com/address/0x4f7c22822bbeedce686efb38ce3de42be07f7082) |
| **VaultDeployer** | [`0x1cd24183dee6d7edea7cad910316bf7b7f9611b8`](https://explorer.testnet.chain.robinhood.com/address/0x1cd24183dee6d7edea7cad910316bf7b7f9611b8) |
| **MarketDeployer** | [`0x7b7a8beddf416e071b8c13db1c3d8648699d0246`](https://explorer.testnet.chain.robinhood.com/address/0x7b7a8beddf416e071b8c13db1c3d8648699d0246) |

### Roles

| Role | Address |
|---|---|
| **Governance (timelock)** | [`0xaf494c7ad0732d2a2a7b8d47757f4aa2b2908ace`](https://explorer.testnet.chain.robinhood.com/address/0xaf494c7ad0732d2a2a7b8d47757f4aa2b2908ace) |
| **Emergency council** | [`0xffEE7f1305c2D43f6512B33A17fD80e54b5830cD`](https://explorer.testnet.chain.robinhood.com/address/0xffEE7f1305c2D43f6512B33A17fD80e54b5830cD) |
| **Treasury** | [`0x286539fc7431076aA75D11351dEcC5C37C724Ff7`](https://explorer.testnet.chain.robinhood.com/address/0x286539fc7431076aA75D11351dEcC5C37C724Ff7) |
| **Deployer** (ops only) | [`0x3a147ed1980bbD468Bc4FA6102eB264CbC8E2556`](https://explorer.testnet.chain.robinhood.com/address/0x3a147ed1980bbD468Bc4FA6102eB264CbC8E2556) |

### Demo / listed markets

| Market | Address |
|---|---|
| **Demo market (BTC)** | [`0x2D2EE857198874e89Db2Cf29C3E1B47Bfb184cEa`](https://explorer.testnet.chain.robinhood.com/address/0x2D2EE857198874e89Db2Cf29C3E1B47Bfb184cEa) |
| Market ID | `0x0086bac6568bb3c77286c04f30a345f6cebca92a5619ec091faeda64e9079f82` |
| Base token (apBASE) | [`0xf07a6d0b9453941c68dffebf181d556def09a8bf`](https://explorer.testnet.chain.robinhood.com/address/0xf07a6d0b9453941c68dffebf181d556def09a8bf) |
| Liquidity vault | [`0xa6026956fA4c20C7C4A04da076fA0d38dac21407`](https://explorer.testnet.chain.robinhood.com/address/0xa6026956fA4c20C7C4A04da076fA0d38dac21407) |
| Insurance fund | [`0x391dFF40D80de2E3093DBDb3e022F1811F86b687`](https://explorer.testnet.chain.robinhood.com/address/0x391dFF40D80de2E3093DBDb3e022F1811F86b687) |
| Oracle route ID | `0x14deb0349513e213518bd0247addd8e42d964ef2a7e19388719fbcf52ecbed73` |
| **ETH market** | [`0x8792E44B9220a0Fa45Fa0c67D8B58cEB03C8bb57`](https://explorer.testnet.chain.robinhood.com/address/0x8792E44B9220a0Fa45Fa0c67D8B58cEB03C8bb57) |
| **SOL market** | [`0xa7660AE91D532fFAe8F1531623fAe815B889d7a9`](https://explorer.testnet.chain.robinhood.com/address/0xa7660AE91D532fFAe8F1531623fAe815B889d7a9) |
| **RATDOG market** | [`0x0152536235A3Be21481d66BA6CA51Ba26C054A08`](https://explorer.testnet.chain.robinhood.com/address/0x0152536235A3Be21481d66BA6CA51Ba26C054A08) |

Network helpers: [RPC](https://rpc.testnet.chain.robinhood.com) · [Faucet](https://faucet.testnet.chain.robinhood.com/) · chain ID **46630**

## Why AnyPerp exists

Listing a perp is expensive: oracles, insurance, liquidations, and monitoring do not appear the moment a spot token does.

- **Traders** need a transparent way to long/short early tokens without opaque OTC.
- **Creators / projects** need a neutral path to seed isolated liquidity â€” not a discretionary listing desk.
- **LPs** should underwrite **one named market**, not an unrestricted shared portfolio of long-tail risk.

Shared mega-vaults and creator-controlled prices fail that brief. Isolation and mechanical admission are the point.

---

## Core capabilities

| Capability | Description |
|---|---|
| **Permissionless create** | Any account can deploy a market candidate with bond + salt (CREATE2). |
| **Mechanical activation** | Validate â†’ seed LP/insurance â†’ activate only if oracle + capital + tier pass in-tx. |
| **Isolated vaults** | Per market: collateral vault, LP vault, insurance fund â€” no cross-market debit. |
| **Oracle-priced execution** | Index from registered adapters; fill at index Â± bounded skew impact. |
| **Risk tiers** | Blue-chip â†’ experimental envelopes; creators may tighten, never loosen. |
| **Funding** | Checkpointed, zero-sum longâ†”short accrual (not protocol revenue). |
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

1. **Create** â€” factory deploys immutable market instance + vaults; bond locked.
2. **Validate** â€” registered multi-source route, freshness, deviation, tier envelope.
3. **Seed** â€” isolated LP capital and insurance; exact token balance accounting.
4. **Activate** â€” revalidation in the same transaction; state â†’ `Active`.
5. **Trade** â€” isolated margin; skew-aware execution; fees split per `FeeManager`.
6. **Contain** â€” bad debt stays inside that marketâ€™s insurance â†’ capped backstop â†’ ADL path.

---

## Architecture (high level)

| Layer | Contents |
|---|---|
| **Contracts** | `MarketFactory`, `Market`, vaults, `OracleRouter`, adapters, `RiskManager`, funding/fees/liquidation, timelock, guardian |
| **Simulations** | Python decimal reference model + stress tests |
| **Data** | PostgreSQL migrations; canonical + orphaned event model |
| **Services** | API Â· indexer Â· keepers (TypeScript / Fastify / BullMQ) |
| **App** | Landing Â· docs surface Â· trading / create / LP UI |
| **Ops** | Docker Compose, Railway/Vercel configs, incident runbooks |

```text
UI / Wallet â”€â”€RPCâ”€â”€â–º Robinhood Chain (AnyPerp contracts + oracles)
    â”‚
    â””â”€â”€ API / WS â—„â”€â”€ Indexer â—„â”€â”€ logs
                      Keepers â”€â”€â–º funding Â· liq Â· triggers Â· withdrawals
```

---

## Repository map

| Path | Role |
|---|---|
| [`anyperp`](https://github.com/AnyPerp/anyperp) | Main monorepo â€” contracts, services, app, scripts, configs |
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
| Mock oracle / faucet flags | Testnet only â€” must be off for mainnet |

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

