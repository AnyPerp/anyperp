BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE confirmation_status AS ENUM ('soft_confirmed','l1_posted','finalized','orphaned');
CREATE TYPE market_status AS ENUM ('draft','pending_validation','bootstrapping','active','reduce_only','paused','settling','closed','rejected');
CREATE TYPE risk_tier AS ENUM ('blue_chip','established','emerging','experimental');
CREATE TYPE order_status AS ENUM ('pending','open','triggered','filled','partially_filled','cancelled','expired','rejected','failed');
CREATE TYPE order_type AS ENUM ('market','limit','stop_loss','take_profit','liquidation');
CREATE TYPE position_side AS ENUM ('long','short','flat');
CREATE TYPE job_status AS ENUM ('queued','leased','succeeded','failed','dead_letter');
CREATE TYPE notification_status AS ENUM ('queued','sent','failed','read');
CREATE TYPE governance_status AS ENUM ('pending','active','succeeded','defeated','queued','executed','cancelled','expired');
CREATE TYPE alert_severity AS ENUM ('info','warning','critical');

CREATE TABLE chains (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  chain_id bigint NOT NULL UNIQUE CHECK (chain_id > 0),
  name text NOT NULL,
  rpc_http_url text NOT NULL,
  rpc_ws_url text,
  explorer_url text,
  native_symbol text NOT NULL,
  soft_confirmation_blocks integer NOT NULL DEFAULT 0 CHECK (soft_confirmation_blocks >= 0),
  finality_policy jsonb NOT NULL DEFAULT '{}'::jsonb,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE TABLE tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chain_id bigint NOT NULL REFERENCES chains(chain_id),
  address text NOT NULL CHECK (address ~ '^0x[0-9a-fA-F]{40}$'),
  name text,
  symbol text,
  decimals smallint NOT NULL CHECK (decimals BETWEEN 0 AND 18),
  token_type text NOT NULL DEFAULT 'erc20' CHECK (token_type IN ('erc20','wrapped_native','stablecoin','stock_token','unsupported')),
  metadata_status text NOT NULL DEFAULT 'unverified' CHECK (metadata_status IN ('unverified','verified','blocked')),
  behavior_flags jsonb NOT NULL DEFAULT '{}'::jsonb,
  first_seen_block bigint NOT NULL CHECK (first_seen_block >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  UNIQUE (chain_id, address)
);

CREATE INDEX tokens_chain_symbol_idx ON tokens(chain_id, symbol) WHERE deleted_at IS NULL;

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  locale text NOT NULL DEFAULT 'en',
  timezone text NOT NULL DEFAULT 'UTC',
  notification_preferences jsonb NOT NULL DEFAULT '{}'::jsonb,
  terms_version text,
  terms_accepted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE TABLE wallets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES users(id),
  chain_id bigint NOT NULL REFERENCES chains(chain_id),
  address text NOT NULL CHECK (address ~ '^0x[0-9a-fA-F]{40}$'),
  label text,
  is_primary boolean NOT NULL DEFAULT false,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  UNIQUE (chain_id, address)
);

CREATE TABLE markets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chain_id bigint NOT NULL REFERENCES chains(chain_id),
  market_key text NOT NULL CHECK (market_key ~ '^0x[0-9a-fA-F]{64}$'),
  contract_address text NOT NULL CHECK (contract_address ~ '^0x[0-9a-fA-F]{40}$'),
  base_token_id uuid NOT NULL REFERENCES tokens(id),
  collateral_token_id uuid NOT NULL REFERENCES tokens(id),
  creator_wallet_id uuid NOT NULL REFERENCES wallets(id),
  oracle_route_id text NOT NULL CHECK (oracle_route_id ~ '^0x[0-9a-fA-F]{64}$'),
  tier risk_tier NOT NULL,
  status market_status NOT NULL,
  creator_bond numeric(78,18) NOT NULL CHECK (creator_bond >= 0),
  created_block bigint NOT NULL CHECK (created_block >= 0),
  activated_at timestamptz,
  settlement_price numeric(78,18) CHECK (settlement_price > 0),
  settlement_started_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  UNIQUE (chain_id, market_key),
  UNIQUE (chain_id, contract_address),
  CHECK (base_token_id <> collateral_token_id)
);

CREATE INDEX markets_discovery_idx ON markets(chain_id, status, tier) WHERE deleted_at IS NULL;

CREATE TABLE market_parameters (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  market_id uuid NOT NULL REFERENCES markets(id),
  effective_block bigint NOT NULL CHECK (effective_block >= 0),
  initial_margin_bps integer NOT NULL CHECK (initial_margin_bps BETWEEN 1 AND 10000),
  maintenance_margin_bps integer NOT NULL CHECK (maintenance_margin_bps BETWEEN 1 AND 9999),
  max_open_interest numeric(78,18) NOT NULL CHECK (max_open_interest > 0),
  max_skew numeric(78,18) NOT NULL CHECK (max_skew > 0),
  max_position numeric(78,18) NOT NULL CHECK (max_position > 0),
  max_utilization_bps integer NOT NULL CHECK (max_utilization_bps BETWEEN 1 AND 9500),
  max_price_impact_bps integer NOT NULL CHECK (max_price_impact_bps BETWEEN 0 AND 2000),
  trading_fee_bps integer NOT NULL CHECK (trading_fee_bps BETWEEN 0 AND 200),
  liquidation_penalty_bps integer NOT NULL CHECK (liquidation_penalty_bps BETWEEN 0 AND 2000),
  oracle_max_age_seconds integer NOT NULL CHECK (oracle_max_age_seconds > 0),
  min_oracle_sources smallint NOT NULL CHECK (min_oracle_sources BETWEEN 1 AND 5),
  raw_parameters jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (market_id, effective_block),
  CHECK (initial_margin_bps > maintenance_margin_bps)
);

CREATE TABLE market_state_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  market_id uuid NOT NULL REFERENCES markets(id),
  previous_status market_status,
  next_status market_status NOT NULL,
  reason_hash text,
  actor_address text CHECK (actor_address IS NULL OR actor_address ~ '^0x[0-9a-fA-F]{40}$'),
  block_number bigint NOT NULL,
  transaction_hash text NOT NULL,
  log_index integer NOT NULL,
  confirmation confirmation_status NOT NULL DEFAULT 'soft_confirmed',
  occurred_at timestamptz NOT NULL,
  UNIQUE (market_id, transaction_hash, log_index)
);

CREATE TABLE oracle_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chain_id bigint NOT NULL REFERENCES chains(chain_id),
  token_id uuid NOT NULL REFERENCES tokens(id),
  adapter_address text NOT NULL CHECK (adapter_address ~ '^0x[0-9a-fA-F]{40}$'),
  source_type text NOT NULL CHECK (source_type IN ('chainlink_feed','chainlink_stream','dex_twap','test_mock')),
  source_address text NOT NULL CHECK (source_address ~ '^0x[0-9a-fA-F]{40}$'),
  heartbeat_seconds integer NOT NULL CHECK (heartbeat_seconds > 0),
  twap_window_seconds integer CHECK (twap_window_seconds IS NULL OR twap_window_seconds >= 300),
  enabled boolean NOT NULL DEFAULT true,
  configuration jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (chain_id, token_id, adapter_address, source_address)
);

CREATE TABLE oracle_prices (
  chain_id bigint NOT NULL REFERENCES chains(chain_id),
  source_id uuid NOT NULL REFERENCES oracle_sources(id),
  token_id uuid NOT NULL REFERENCES tokens(id),
  block_number bigint NOT NULL,
  block_hash text NOT NULL CHECK (block_hash ~ '^0x[0-9a-fA-F]{64}$'),
  price numeric(78,18) NOT NULL CHECK (price > 0),
  confidence_bps integer NOT NULL CHECK (confidence_bps BETWEEN 0 AND 10000),
  liquidity_value numeric(78,18) NOT NULL DEFAULT 0 CHECK (liquidity_value >= 0),
  source_timestamp timestamptz NOT NULL,
  observed_at timestamptz NOT NULL DEFAULT now(),
  confirmation confirmation_status NOT NULL DEFAULT 'soft_confirmed',
  PRIMARY KEY (chain_id, source_id, block_number, block_hash)
) PARTITION BY RANGE (block_number);

CREATE TABLE oracle_prices_default PARTITION OF oracle_prices DEFAULT;
CREATE INDEX oracle_prices_token_latest_idx ON oracle_prices(token_id, block_number DESC) WHERE confirmation <> 'orphaned';

CREATE TABLE liquidity_vaults (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  market_id uuid NOT NULL UNIQUE REFERENCES markets(id),
  contract_address text NOT NULL,
  share_token_address text NOT NULL,
  total_assets numeric(78,18) NOT NULL DEFAULT 0 CHECK (total_assets >= 0),
  total_shares numeric(78,18) NOT NULL DEFAULT 0 CHECK (total_shares >= 0),
  reserved_assets numeric(78,18) NOT NULL DEFAULT 0 CHECK (reserved_assets >= 0),
  withdrawal_delay_seconds integer NOT NULL CHECK (withdrawal_delay_seconds >= 0),
  updated_block bigint NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE liquidity_deposits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vault_id uuid NOT NULL REFERENCES liquidity_vaults(id),
  wallet_id uuid NOT NULL REFERENCES wallets(id),
  assets numeric(78,18) NOT NULL CHECK (assets > 0),
  shares numeric(78,18) NOT NULL CHECK (shares > 0),
  transaction_hash text NOT NULL,
  log_index integer NOT NULL,
  block_number bigint NOT NULL,
  occurred_at timestamptz NOT NULL,
  UNIQUE (vault_id, transaction_hash, log_index)
);

CREATE TABLE liquidity_withdrawals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vault_id uuid NOT NULL REFERENCES liquidity_vaults(id),
  wallet_id uuid NOT NULL REFERENCES wallets(id),
  onchain_request_id numeric(78,0) NOT NULL,
  shares numeric(78,18) NOT NULL CHECK (shares > 0),
  assets numeric(78,18) CHECK (assets >= 0),
  status text NOT NULL CHECK (status IN ('requested','executable','executed','cancelled','blocked')),
  executable_at timestamptz NOT NULL,
  requested_tx_hash text NOT NULL,
  executed_tx_hash text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (vault_id, onchain_request_id)
);

CREATE TABLE orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  market_id uuid NOT NULL REFERENCES markets(id),
  wallet_id uuid NOT NULL REFERENCES wallets(id),
  onchain_order_id numeric(78,0),
  client_order_id text,
  type order_type NOT NULL,
  status order_status NOT NULL,
  side position_side NOT NULL CHECK (side <> 'flat'),
  size_delta numeric(78,18) NOT NULL CHECK (size_delta <> 0),
  trigger_price numeric(78,18),
  acceptable_price numeric(78,18) NOT NULL CHECK (acceptable_price > 0),
  execution_fee numeric(78,18) NOT NULL DEFAULT 0 CHECK (execution_fee >= 0),
  expires_at timestamptz NOT NULL,
  submitted_tx_hash text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  UNIQUE NULLS NOT DISTINCT (market_id, wallet_id, onchain_order_id),
  UNIQUE NULLS NOT DISTINCT (market_id, wallet_id, client_order_id)
);

CREATE INDEX orders_open_idx ON orders(market_id, status, expires_at) WHERE deleted_at IS NULL;

CREATE TABLE trades (
  id uuid DEFAULT gen_random_uuid(),
  market_id uuid NOT NULL REFERENCES markets(id),
  wallet_id uuid NOT NULL REFERENCES wallets(id),
  order_id uuid REFERENCES orders(id),
  transaction_hash text NOT NULL,
  log_index integer NOT NULL,
  block_number bigint NOT NULL,
  block_hash text NOT NULL,
  size_delta numeric(78,18) NOT NULL CHECK (size_delta <> 0),
  execution_price numeric(78,18) NOT NULL CHECK (execution_price > 0),
  index_price numeric(78,18) NOT NULL CHECK (index_price > 0),
  fee numeric(78,18) NOT NULL CHECK (fee >= 0),
  realized_pnl numeric(78,18) NOT NULL,
  confirmation confirmation_status NOT NULL DEFAULT 'soft_confirmed',
  occurred_at timestamptz NOT NULL,
  PRIMARY KEY (id, block_number),
  UNIQUE (market_id, transaction_hash, log_index, block_number)
) PARTITION BY RANGE (block_number);

CREATE TABLE trades_default PARTITION OF trades DEFAULT;
CREATE INDEX trades_market_time_idx ON trades(market_id, occurred_at DESC) WHERE confirmation <> 'orphaned';

CREATE TABLE positions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  market_id uuid NOT NULL REFERENCES markets(id),
  wallet_id uuid NOT NULL REFERENCES wallets(id),
  side position_side NOT NULL,
  size_base numeric(78,18) NOT NULL,
  entry_price numeric(78,18) NOT NULL CHECK (entry_price >= 0),
  margin numeric(78,18) NOT NULL CHECK (margin >= 0),
  funding_checkpoint numeric(78,18) NOT NULL,
  realized_pnl numeric(78,18) NOT NULL DEFAULT 0,
  updated_block bigint NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (market_id, wallet_id),
  CHECK ((side = 'flat' AND size_base = 0 AND entry_price = 0) OR (side <> 'flat' AND size_base <> 0 AND entry_price > 0))
);

CREATE TABLE position_events (
  id uuid DEFAULT gen_random_uuid(),
  position_id uuid NOT NULL REFERENCES positions(id),
  event_type text NOT NULL CHECK (event_type IN ('margin_deposit','margin_withdrawal','increase','decrease','close','funding','liquidation','settlement')),
  size_delta numeric(78,18) NOT NULL DEFAULT 0,
  margin_delta numeric(78,18) NOT NULL DEFAULT 0,
  pnl_delta numeric(78,18) NOT NULL DEFAULT 0,
  transaction_hash text NOT NULL,
  log_index integer NOT NULL,
  block_number bigint NOT NULL,
  block_hash text NOT NULL,
  confirmation confirmation_status NOT NULL DEFAULT 'soft_confirmed',
  occurred_at timestamptz NOT NULL,
  PRIMARY KEY (id, block_number),
  UNIQUE (position_id, transaction_hash, log_index, block_number)
) PARTITION BY RANGE (block_number);
CREATE TABLE position_events_default PARTITION OF position_events DEFAULT;

CREATE TABLE collateral_balances (
  market_id uuid NOT NULL REFERENCES markets(id),
  wallet_id uuid NOT NULL REFERENCES wallets(id),
  deposited numeric(78,18) NOT NULL DEFAULT 0 CHECK (deposited >= 0),
  available numeric(78,18) NOT NULL DEFAULT 0,
  locked numeric(78,18) NOT NULL DEFAULT 0 CHECK (locked >= 0),
  updated_block bigint NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (market_id, wallet_id)
);

CREATE TABLE funding_rates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  market_id uuid NOT NULL REFERENCES markets(id),
  rate_per_second numeric(78,36) NOT NULL,
  cumulative_rate numeric(78,36) NOT NULL,
  long_open_interest numeric(78,18) NOT NULL CHECK (long_open_interest >= 0),
  short_open_interest numeric(78,18) NOT NULL CHECK (short_open_interest >= 0),
  elapsed_seconds integer NOT NULL CHECK (elapsed_seconds >= 0),
  block_number bigint NOT NULL,
  transaction_hash text NOT NULL,
  log_index integer NOT NULL,
  occurred_at timestamptz NOT NULL,
  UNIQUE (market_id, transaction_hash, log_index)
);

CREATE TABLE funding_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  market_id uuid NOT NULL REFERENCES markets(id),
  wallet_id uuid NOT NULL REFERENCES wallets(id),
  amount numeric(78,18) NOT NULL,
  cumulative_rate_before numeric(78,36) NOT NULL,
  cumulative_rate_after numeric(78,36) NOT NULL,
  transaction_hash text NOT NULL,
  log_index integer NOT NULL,
  block_number bigint NOT NULL,
  occurred_at timestamptz NOT NULL,
  UNIQUE (market_id, transaction_hash, log_index)
);

CREATE TABLE liquidations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  market_id uuid NOT NULL REFERENCES markets(id),
  account_wallet_id uuid NOT NULL REFERENCES wallets(id),
  liquidator_wallet_id uuid NOT NULL REFERENCES wallets(id),
  closed_notional numeric(78,18) NOT NULL CHECK (closed_notional > 0),
  execution_price numeric(78,18) NOT NULL CHECK (execution_price > 0),
  reward numeric(78,18) NOT NULL CHECK (reward >= 0),
  bad_debt numeric(78,18) NOT NULL CHECK (bad_debt >= 0),
  transaction_hash text NOT NULL,
  log_index integer NOT NULL,
  block_number bigint NOT NULL,
  occurred_at timestamptz NOT NULL,
  UNIQUE (market_id, transaction_hash, log_index)
);

CREATE TABLE insurance_fund_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  market_id uuid REFERENCES markets(id),
  event_type text NOT NULL CHECK (event_type IN ('deposit','fee_credit','bad_debt_cover','backstop_grant','withdrawal')),
  amount numeric(78,18) NOT NULL CHECK (amount >= 0),
  balance_after numeric(78,18) NOT NULL CHECK (balance_after >= 0),
  transaction_hash text NOT NULL,
  log_index integer NOT NULL,
  block_number bigint NOT NULL,
  occurred_at timestamptz NOT NULL,
  UNIQUE NULLS NOT DISTINCT (market_id, transaction_hash, log_index)
);

CREATE TABLE protocol_fees (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  market_id uuid NOT NULL REFERENCES markets(id),
  token_id uuid NOT NULL REFERENCES tokens(id),
  fee_type text NOT NULL CHECK (fee_type IN ('trading','liquidation','withdrawal','other')),
  gross_amount numeric(78,18) NOT NULL CHECK (gross_amount >= 0),
  protocol_amount numeric(78,18) NOT NULL CHECK (protocol_amount >= 0),
  insurance_amount numeric(78,18) NOT NULL CHECK (insurance_amount >= 0),
  lp_amount numeric(78,18) NOT NULL CHECK (lp_amount >= 0),
  creator_amount numeric(78,18) NOT NULL CHECK (creator_amount >= 0),
  transaction_hash text NOT NULL,
  log_index integer NOT NULL,
  occurred_at timestamptz NOT NULL,
  UNIQUE (market_id, transaction_hash, log_index),
  CHECK (protocol_amount + insurance_amount + lp_amount + creator_amount <= gross_amount)
);

CREATE TABLE market_creator_rewards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  market_id uuid NOT NULL REFERENCES markets(id),
  creator_wallet_id uuid NOT NULL REFERENCES wallets(id),
  amount numeric(78,18) NOT NULL CHECK (amount >= 0),
  transaction_hash text NOT NULL,
  log_index integer NOT NULL,
  occurred_at timestamptz NOT NULL,
  UNIQUE (market_id, transaction_hash, log_index)
);

CREATE TABLE keeper_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chain_id bigint NOT NULL REFERENCES chains(chain_id),
  market_id uuid REFERENCES markets(id),
  job_type text NOT NULL CHECK (job_type IN ('funding','liquidation','trigger_order','withdrawal','oracle_health','projection_rebuild')),
  dedupe_key text NOT NULL,
  status job_status NOT NULL DEFAULT 'queued',
  payload jsonb NOT NULL,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts integer NOT NULL DEFAULT 10 CHECK (max_attempts > 0),
  lease_owner text,
  leased_until timestamptz,
  run_after timestamptz NOT NULL DEFAULT now(),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (chain_id, dedupe_key)
);
CREATE INDEX keeper_jobs_ready_idx ON keeper_jobs(status, run_after) WHERE status IN ('queued','failed');

CREATE TABLE transactions (
  chain_id bigint NOT NULL REFERENCES chains(chain_id),
  hash text NOT NULL CHECK (hash ~ '^0x[0-9a-fA-F]{64}$'),
  block_number bigint,
  block_hash text,
  from_address text NOT NULL,
  to_address text,
  nonce numeric(78,0) NOT NULL,
  status smallint CHECK (status IN (0,1)),
  gas_used numeric(78,0),
  effective_gas_price numeric(78,0),
  confirmation confirmation_status NOT NULL DEFAULT 'soft_confirmed',
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chain_id, hash)
);

CREATE TABLE blocks (
  chain_id bigint NOT NULL REFERENCES chains(chain_id),
  block_number bigint NOT NULL,
  block_hash text NOT NULL CHECK (block_hash ~ '^0x[0-9a-fA-F]{64}$'),
  parent_hash text NOT NULL CHECK (parent_hash ~ '^0x[0-9a-fA-F]{64}$'),
  block_timestamp timestamptz NOT NULL,
  confirmation confirmation_status NOT NULL DEFAULT 'soft_confirmed',
  canonical boolean NOT NULL DEFAULT true,
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chain_id, block_number, block_hash)
) PARTITION BY RANGE (block_number);
CREATE TABLE blocks_default PARTITION OF blocks DEFAULT;
CREATE UNIQUE INDEX one_canonical_block_idx ON blocks(chain_id, block_number) WHERE canonical;

CREATE TABLE contract_events (
  chain_id bigint NOT NULL REFERENCES chains(chain_id),
  block_number bigint NOT NULL,
  block_hash text NOT NULL,
  transaction_hash text NOT NULL,
  log_index integer NOT NULL CHECK (log_index >= 0),
  contract_address text NOT NULL,
  topic0 text,
  topics jsonb NOT NULL,
  data text NOT NULL,
  event_name text,
  decoded_args jsonb,
  confirmation confirmation_status NOT NULL DEFAULT 'soft_confirmed',
  canonical boolean NOT NULL DEFAULT true,
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chain_id, block_number, block_hash, transaction_hash, log_index),
  FOREIGN KEY (chain_id, block_number, block_hash) REFERENCES blocks(chain_id, block_number, block_hash)
) PARTITION BY RANGE (block_number);
CREATE TABLE contract_events_default PARTITION OF contract_events DEFAULT;
-- PostgreSQL requires every unique index on a partitioned table to include the
-- partition key. Reorg handling marks the previous canonical row orphaned
-- before a transaction/log identity is replayed at a different block height.
CREATE UNIQUE INDEX canonical_event_ingestion_key ON contract_events(chain_id, block_number, transaction_hash, log_index) WHERE canonical;
CREATE INDEX contract_events_decode_idx ON contract_events(chain_id, contract_address, event_name, block_number DESC) WHERE canonical;

CREATE TABLE notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  market_id uuid REFERENCES markets(id),
  type text NOT NULL,
  status notification_status NOT NULL DEFAULT 'queued',
  channel text NOT NULL CHECK (channel IN ('in_app','email','web_push','webhook')),
  payload jsonb NOT NULL,
  dedupe_key text NOT NULL,
  scheduled_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  read_at timestamptz,
  failure_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, channel, dedupe_key)
);

CREATE TABLE governance_proposals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chain_id bigint NOT NULL REFERENCES chains(chain_id),
  proposal_id numeric(78,0) NOT NULL,
  proposer_wallet_id uuid NOT NULL REFERENCES wallets(id),
  title text NOT NULL,
  description_uri text,
  actions jsonb NOT NULL,
  status governance_status NOT NULL,
  vote_start timestamptz,
  vote_end timestamptz,
  eta timestamptz,
  transaction_hash text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (chain_id, proposal_id)
);

CREATE TABLE governance_votes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  proposal_id uuid NOT NULL REFERENCES governance_proposals(id),
  wallet_id uuid NOT NULL REFERENCES wallets(id),
  support smallint NOT NULL CHECK (support IN (0,1,2)),
  weight numeric(78,18) NOT NULL CHECK (weight >= 0),
  reason text,
  transaction_hash text NOT NULL,
  log_index integer NOT NULL,
  occurred_at timestamptz NOT NULL,
  UNIQUE (proposal_id, wallet_id)
);

CREATE TABLE risk_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  market_id uuid REFERENCES markets(id),
  severity alert_severity NOT NULL,
  alert_type text NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','acknowledged','resolved','false_positive')),
  observed_value numeric(78,18),
  threshold_value numeric(78,18),
  details jsonb NOT NULL,
  first_observed_at timestamptz NOT NULL,
  last_observed_at timestamptz NOT NULL,
  acknowledged_by uuid REFERENCES users(id),
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX risk_alerts_open_idx ON risk_alerts(severity, last_observed_at DESC) WHERE status = 'open';

CREATE TABLE audit_logs (
  id uuid DEFAULT gen_random_uuid(),
  actor_type text NOT NULL CHECK (actor_type IN ('user','wallet','service','governance','guardian')),
  actor_id text NOT NULL,
  action text NOT NULL,
  resource_type text NOT NULL,
  resource_id text NOT NULL,
  request_id text,
  ip_hash text,
  before_state jsonb,
  after_state jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);
CREATE TABLE audit_logs_default PARTITION OF audit_logs DEFAULT;
CREATE INDEX audit_logs_resource_idx ON audit_logs(resource_type, resource_id, created_at DESC);

INSERT INTO chains(chain_id, name, rpc_http_url, rpc_ws_url, explorer_url, native_symbol, finality_policy)
VALUES
  (46630, 'Robinhood Chain Testnet', 'https://rpc.testnet.chain.robinhood.com', 'wss://feed.testnet.chain.robinhood.com', 'https://explorer.testnet.chain.robinhood.com', 'ETH', '{"soft":"sequencer receipt","l1_posted":"batch observed on Ethereum","finalized":"L1 finalized"}'),
  (4663, 'Robinhood Chain', 'https://rpc.mainnet.chain.robinhood.com', 'wss://feed.mainnet.chain.robinhood.com', 'https://robinhoodchain.blockscout.com', 'ETH', '{"soft":"sequencer receipt","l1_posted":"batch observed on Ethereum","finalized":"L1 finalized"}');

COMMIT;
