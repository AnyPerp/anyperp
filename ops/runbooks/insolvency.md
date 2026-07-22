# Insolvency or bad debt

1. Pause increases for the affected market only; do not touch unrelated vaults.
2. Reconcile collateral-vault, LP-vault, insurance, open-position, funding, and fee balances at a fixed block.
3. Re-run the accounting model using the on-chain oracle observations and transactions.
4. Apply the market insurance reserve first. A protocol backstop requires a public, capped timelock action.
5. If debt remains, calculate ADL candidates by profit and effective leverage. Socialized loss requires a separately disclosed governance decision.
6. Publish the reason hash, evidence, amounts, and postmortem. Do not describe the protocol as solvent until the invariant reconciliation passes.
