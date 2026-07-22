-- Lightweight testnet projections (no heavy token/wallet FK graph).
-- Authoritative state remains on-chain; these tables help keepers/API discover accounts.

BEGIN;

CREATE TABLE IF NOT EXISTS projected_markets (
  chain_id bigint NOT NULL,
  market_address text NOT NULL CHECK (market_address ~ '^0x[0-9a-fA-F]{40}$'),
  market_id_bytes32 text CHECK (market_id_bytes32 IS NULL OR market_id_bytes32 ~ '^0x[0-9a-fA-F]{64}$'),
  creator_address text CHECK (creator_address IS NULL OR creator_address ~ '^0x[0-9a-fA-F]{40}$'),
  first_seen_block bigint NOT NULL CHECK (first_seen_block >= 0),
  last_event_block bigint NOT NULL CHECK (last_event_block >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chain_id, market_address)
);

CREATE INDEX IF NOT EXISTS projected_markets_last_event_idx
  ON projected_markets (chain_id, last_event_block DESC);

CREATE TABLE IF NOT EXISTS projected_open_accounts (
  chain_id bigint NOT NULL,
  market_address text NOT NULL CHECK (market_address ~ '^0x[0-9a-fA-F]{40}$'),
  account_address text NOT NULL CHECK (account_address ~ '^0x[0-9a-fA-F]{40}$'),
  last_size_base_wad numeric(78,0) NOT NULL DEFAULT 0,
  last_trade_block bigint NOT NULL DEFAULT 0 CHECK (last_trade_block >= 0),
  last_trade_tx text,
  open boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chain_id, market_address, account_address)
);

CREATE INDEX IF NOT EXISTS projected_open_accounts_open_idx
  ON projected_open_accounts (chain_id, market_address)
  WHERE open = true;

CREATE TABLE IF NOT EXISTS projected_trades (
  chain_id bigint NOT NULL,
  market_address text NOT NULL CHECK (market_address ~ '^0x[0-9a-fA-F]{40}$'),
  account_address text NOT NULL CHECK (account_address ~ '^0x[0-9a-fA-F]{40}$'),
  transaction_hash text NOT NULL CHECK (transaction_hash ~ '^0x[0-9a-fA-F]{64}$'),
  log_index integer NOT NULL CHECK (log_index >= 0),
  block_number bigint NOT NULL CHECK (block_number >= 0),
  block_hash text NOT NULL,
  size_delta_wad numeric(78,0) NOT NULL,
  new_size_wad numeric(78,0) NOT NULL,
  execution_price_wad numeric(78,0) NOT NULL,
  realized_pnl_wad numeric(78,0) NOT NULL,
  fee_wad numeric(78,0) NOT NULL,
  canonical boolean NOT NULL DEFAULT true,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chain_id, transaction_hash, log_index)
);

CREATE INDEX IF NOT EXISTS projected_trades_market_block_idx
  ON projected_trades (chain_id, market_address, block_number DESC)
  WHERE canonical = true;

CREATE TABLE IF NOT EXISTS projection_cursors (
  chain_id bigint PRIMARY KEY,
  last_projected_block bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMIT;
