# Security Policy

## Status

AnyPerp is an **unaudited testnet research prototype**. It is **not** safe for real funds.

Do not deploy with mainnet capital. Do not reuse keys that have ever been shared, committed, or used on a compromised machine.

## Supported versions

| Version | Supported |
|---------|-----------|
| `0.1.x-testnet` (default branch) | Security fixes for the open-source tree only |
| Production / mainnet deployments | Not supported until independent audit + explicit release |

## Reporting a vulnerability

Please report security issues **privately**. Do not open a public GitHub issue for exploitable bugs.

1. Email: **security@anyperp.fun** (or open a private security advisory on this GitHub org if email is unavailable).
2. Include: affected component, reproduction steps, impact, and any proof-of-concept **without** mainnet exploitation.
3. Allow reasonable time for triage before public disclosure.

## Scope (in)

- Smart contracts under `contracts/src`
- Off-chain services under `services/`
- Frontend trading surfaces under `app/`
- Database migrations under `database/migrations`
- Deployment / keeper scripts that can move funds or privileges

## Scope (out)

- Third-party chains, RPCs, wallets, or bridges
- Social engineering against individual users
- Denial-of-service against public infrastructure you do not own
- Issues that only affect local mock/anvil setups with no realistic production path

## Secrets & keys

- Never commit `.env`, private keys, mnemonics, database URLs, or API tokens.
- Use `.env.example` / `.env.required.example` as templates only.
- Rotate any key that may have been exposed in chat, logs, CI, or a public fork.

## Safe local setup

```bash
cp .env.example .env
# fill only local / testnet values; use fresh keys with test ETH only
```
