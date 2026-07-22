# Sequencer or RPC incident

1. Compare public Robinhood RPC, a paid provider, the sequencer feed, and Ethereum batch status.
2. Stop keepers from sending transactions when providers disagree on chain ID, parent hash, or head by more than the configured tolerance.
3. During a confirmed sequencer outage, block oracle-dependent increases, funding updates, liquidation, and settlement.
4. After recovery, wait through the Chainlink sequencer grace period before resuming price-dependent actions.
5. Rewind orphaned projections and replay raw events. Never mutate finalized records without retaining the orphaned copy.
