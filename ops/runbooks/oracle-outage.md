# Oracle outage

1. Verify sequencer status independently from two RPC providers.
2. Record affected route, adapter, last valid timestamp, confidence, deviation, market exposure, and block hash.
3. If validation fails, confirm that risk-increasing calls revert. Use guardian reduce-only only when a valid reduction price remains; otherwise pause.
4. Do not override price data or lower validation thresholds during the incident.
5. Resume through timelocked governance after the source is fresh for the configured grace period and a second source agrees.
6. If recovery is not credible, governance begins settlement using the documented dispute window.
