/**
 * Apply decoded logs into lightweight projected_* tables.
 * Call inside the same DB transaction as raw event insert when possible.
 */
import type pg from "pg";
import type { Log } from "viem";
import {
  decodeProtocolLog,
  isOpenFromSize,
  type DecodedProtocolEvent,
} from "./decode.js";

type Queryable = Pick<pg.PoolClient, "query">;

export async function ensureProjectionTables(db: Queryable): Promise<boolean> {
  try {
    await db.query("select 1 from projected_open_accounts limit 0");
    return true;
  } catch {
    return false;
  }
}

export async function projectLogs(
  db: Queryable,
  chainId: number,
  blockNumber: bigint,
  blockHash: string,
  blockTimestamp: bigint,
  logs: Log[],
): Promise<{ markets: number; trades: number; accounts: number }> {
  let markets = 0;
  let trades = 0;
  let accounts = 0;
  const occurredAt = new Date(Number(blockTimestamp) * 1000).toISOString();

  for (const log of logs) {
    const decoded = decodeProtocolLog(log);
    if (!decoded) continue;
    const applied = await applyDecoded(db, chainId, blockNumber, blockHash, occurredAt, log, decoded);
    markets += applied.markets;
    trades += applied.trades;
    accounts += applied.accounts;
  }

  await db.query(
    `insert into projection_cursors(chain_id, last_projected_block, updated_at)
     values ($1, $2, now())
     on conflict (chain_id) do update set
       last_projected_block = greatest(projection_cursors.last_projected_block, excluded.last_projected_block),
       updated_at = now()`,
    [chainId, blockNumber.toString()],
  );

  return { markets, trades, accounts };
}

async function applyDecoded(
  db: Queryable,
  chainId: number,
  blockNumber: bigint,
  blockHash: string,
  occurredAt: string,
  log: Log,
  decoded: DecodedProtocolEvent,
): Promise<{ markets: number; trades: number; accounts: number }> {
  const marketAddress = log.address;

  if (decoded.kind === "MarketCreated") {
    await db.query(
      `insert into projected_markets(
         chain_id, market_address, market_id_bytes32, creator_address,
         first_seen_block, last_event_block, updated_at
       ) values ($1,$2,$3,$4,$5,$5,now())
       on conflict (chain_id, market_address) do update set
         market_id_bytes32 = coalesce(excluded.market_id_bytes32, projected_markets.market_id_bytes32),
         creator_address = coalesce(excluded.creator_address, projected_markets.creator_address),
         last_event_block = greatest(projected_markets.last_event_block, excluded.last_event_block),
         updated_at = now()`,
      [
        chainId,
        decoded.market.toLowerCase(),
        decoded.marketId,
        decoded.creator.toLowerCase(),
        blockNumber.toString(),
      ],
    );
    return { markets: 1, trades: 0, accounts: 0 };
  }

  // Ensure market row exists for trade/margin markets discovered via logs only
  await db.query(
    `insert into projected_markets(chain_id, market_address, first_seen_block, last_event_block, updated_at)
     values ($1,$2,$3,$3,now())
     on conflict (chain_id, market_address) do update set
       last_event_block = greatest(projected_markets.last_event_block, excluded.last_event_block),
       updated_at = now()`,
    [chainId, marketAddress.toLowerCase(), blockNumber.toString()],
  );

  if (decoded.kind === "TradeExecuted") {
    const open = isOpenFromSize(decoded.newSizeBaseWad);
    await db.query(
      `insert into projected_trades(
         chain_id, market_address, account_address, transaction_hash, log_index,
         block_number, block_hash, size_delta_wad, new_size_wad, execution_price_wad,
         realized_pnl_wad, fee_wad, canonical, occurred_at
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,true,$13)
       on conflict (chain_id, transaction_hash, log_index) do update set
         canonical = true,
         block_number = excluded.block_number,
         block_hash = excluded.block_hash,
         new_size_wad = excluded.new_size_wad,
         size_delta_wad = excluded.size_delta_wad,
         execution_price_wad = excluded.execution_price_wad,
         realized_pnl_wad = excluded.realized_pnl_wad,
         fee_wad = excluded.fee_wad,
         occurred_at = excluded.occurred_at`,
      [
        chainId,
        marketAddress.toLowerCase(),
        decoded.account.toLowerCase(),
        log.transactionHash,
        Number(log.logIndex),
        blockNumber.toString(),
        blockHash,
        decoded.sizeDeltaBaseWad.toString(),
        decoded.newSizeBaseWad.toString(),
        decoded.executionPriceWad.toString(),
        decoded.realizedPnlWad.toString(),
        decoded.feeWad.toString(),
        occurredAt,
      ],
    );

    await db.query(
      `insert into projected_open_accounts(
         chain_id, market_address, account_address, last_size_base_wad,
         last_trade_block, last_trade_tx, open, updated_at
       ) values ($1,$2,$3,$4,$5,$6,$7,now())
       on conflict (chain_id, market_address, account_address) do update set
         last_size_base_wad = case
           when excluded.last_trade_block >= projected_open_accounts.last_trade_block
             then excluded.last_size_base_wad
           else projected_open_accounts.last_size_base_wad
         end,
         last_trade_block = greatest(projected_open_accounts.last_trade_block, excluded.last_trade_block),
         last_trade_tx = case
           when excluded.last_trade_block >= projected_open_accounts.last_trade_block
             then excluded.last_trade_tx
           else projected_open_accounts.last_trade_tx
         end,
         open = case
           when excluded.last_trade_block >= projected_open_accounts.last_trade_block
             then excluded.open
           else projected_open_accounts.open
         end,
         updated_at = now()`,
      [
        chainId,
        marketAddress.toLowerCase(),
        decoded.account.toLowerCase(),
        decoded.newSizeBaseWad.toString(),
        blockNumber.toString(),
        log.transactionHash,
        open,
      ],
    );
    return { markets: 0, trades: 1, accounts: 1 };
  }

  if (decoded.kind === "MarginDeposited") {
    // Deposit does not open a position by itself, but marks account active for probes.
    await db.query(
      `insert into projected_open_accounts(
         chain_id, market_address, account_address, last_size_base_wad,
         last_trade_block, last_trade_tx, open, updated_at
       ) values ($1,$2,$3,0,$4,$5,false,now())
       on conflict (chain_id, market_address, account_address) do update set
         last_trade_block = greatest(projected_open_accounts.last_trade_block, excluded.last_trade_block),
         updated_at = now()`,
      [
        chainId,
        marketAddress.toLowerCase(),
        decoded.account.toLowerCase(),
        blockNumber.toString(),
        log.transactionHash,
      ],
    );
    return { markets: 0, trades: 0, accounts: 1 };
  }

  return { markets: 0, trades: 0, accounts: 0 };
}

/** Mark projected trades orphaned for blocks above ancestor; recompute open flags. */
export async function orphanProjectionsAbove(
  db: Queryable,
  chainId: number,
  ancestorBlock: bigint,
): Promise<void> {
  await db.query(
    `update projected_trades set canonical = false
     where chain_id = $1 and block_number > $2 and canonical = true`,
    [chainId, ancestorBlock.toString()],
  );

  // Recompute open status from latest canonical trade per account
  await db.query(
    `update projected_open_accounts poa set
       last_size_base_wad = coalesce(latest.new_size_wad, 0),
       last_trade_block = coalesce(latest.block_number, 0),
       last_trade_tx = latest.transaction_hash,
       open = coalesce(latest.new_size_wad, 0) <> 0,
       updated_at = now()
     from (
       select distinct on (market_address, account_address)
         market_address, account_address, new_size_wad, block_number, transaction_hash
       from projected_trades
       where chain_id = $1 and canonical = true
       order by market_address, account_address, block_number desc, log_index desc
     ) latest
     where poa.chain_id = $1
       and lower(poa.market_address) = lower(latest.market_address)
       and lower(poa.account_address) = lower(latest.account_address)`,
    [chainId],
  );

  // Accounts whose only trades were orphaned → close
  await db.query(
    `update projected_open_accounts poa set
       open = false,
       last_size_base_wad = 0,
       updated_at = now()
     where poa.chain_id = $1
       and not exists (
         select 1 from projected_trades pt
         where pt.chain_id = poa.chain_id
           and lower(pt.market_address) = lower(poa.market_address)
           and lower(pt.account_address) = lower(poa.account_address)
           and pt.canonical = true
       )
       and poa.open = true`,
    [chainId],
  );

  await db.query(
    `insert into projection_cursors(chain_id, last_projected_block, updated_at)
     values ($1, $2, now())
     on conflict (chain_id) do update set last_projected_block = $2, updated_at = now()`,
    [chainId, ancestorBlock.toString()],
  );
}
