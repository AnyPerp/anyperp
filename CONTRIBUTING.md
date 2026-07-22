# Contributing

Thanks for interest in AnyPerp. This is an **unaudited testnet prototype**.

## Before you open a PR

1. Use a fork and a feature branch.
2. Do **not** commit secrets, keys, `.env`, host credentials, or personal data.
3. Keep changes focused; avoid unrelated refactors.
4. Run what you can locally:

```bash
pnpm contracts:compile
pnpm test:unit
pnpm lint
pnpm build
```

5. Security-sensitive findings → follow [SECURITY.md](./SECURITY.md) (private report), not a public issue.

## Scope we welcome

- Bug fixes with clear reproduction
- Tests that catch real protocol or service failures
- Docs in code comments / README clarifications
- Dependency and CI hygiene (no silent major upgrades)

## Scope we usually decline

- Mainnet “go-live” changes without safety gates
- Hardcoded keys or third-party credentials
- Large marketing / video / internal product dumps
- Drive-by rewrites of the risk model without simulation evidence

## Code of collaboration

Be precise, civil, and technical. Assume other contributors may run this against real testnets.
