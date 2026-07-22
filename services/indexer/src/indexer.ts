import "dotenv/config";
import pg from "pg";
import {
  createPublicClient,
  fallback,
  getAddress,
  http,
  isAddress,
  type Address,
  type Block,
  type Log,
} from "viem";
import { resolveAppChain } from "../../../packages/sdk/src/index.js";
import { MARKET_CREATED_TOPIC0, decodeProtocolLog } from "./decode.js";
import { ensureProjectionTables, orphanProjectionsAbove, projectLogs } from "./project.js";

const appChain = resolveAppChain();
const chainId = Number(process.env.CHAIN_ID ?? appChain.id);
const rpcUrls = (process.env.RPC_HTTP_URLS ?? process.env.RPC_HTTP_URL ?? appChain.rpcUrls.default.http[0] ?? "https://rpc.testnet.chain.robinhood.com")
  .split(",").map((value) => value.trim()).filter(Boolean);
const configuredStart = BigInt(process.env.START_BLOCK ?? 0);

/** Seed addresses from env (factory/registry/oracle). Child markets are discovered from MarketCreated. */
const seedAddresses = (process.env.INDEXED_CONTRACT_ADDRESSES ?? [
  process.env.MARKET_FACTORY_ADDRESS,
  process.env.MARKET_REGISTRY_ADDRESS,
  process.env.ORACLE_ROUTER_ADDRESS,
].filter(Boolean).join(","))
  .split(",").map((value) => value.trim()).filter((value): value is Address => isAddress(value));
if (seedAddresses.length === 0) throw new Error("INDEXED_CONTRACT_ADDRESSES must contain at least one protocol address");

const factoryAddress = process.env.MARKET_FACTORY_ADDRESS && isAddress(process.env.MARKET_FACTORY_ADDRESS)
  ? getAddress(process.env.MARKET_FACTORY_ADDRESS)
  : null;

const tracked = new Set<string>(seedAddresses.map((a) => a.toLowerCase()));
function trackedAddresses(): Address[] {
  return [...tracked].filter((value): value is Address => isAddress(value)).map((a) => getAddress(a));
}

function discoverMarketsFromLogs(logs: Log[]) {
  for (const log of logs) {
    const decoded = decodeProtocolLog(log);
    if (!decoded || decoded.kind !== "MarketCreated") continue;
    if (factoryAddress && log.address.toLowerCase() !== factoryAddress.toLowerCase()) continue;
    if (!tracked.has(decoded.market.toLowerCase())) {
      tracked.add(decoded.market.toLowerCase());
      console.log(JSON.stringify({
        service: "indexer",
        event: "discovered_market",
        market: decoded.market,
        block: log.blockNumber?.toString() ?? null,
      }));
    }
  }
}

const db = new pg.Pool({ connectionString: process.env.DATABASE_URL, application_name: "anyperp-indexer" });
const client = createPublicClient({
  chain: appChain,
  transport: fallback(rpcUrls.map((url) => http(url, { retryCount: 2, timeout: 10_000 }))),
});

let projectionsEnabled = false;

async function loadDiscoveredMarketsFromDb() {
  try {
    if (factoryAddress) {
      const rows = await db.query<{ topics: string }>(
        `select topics from contract_events
         where chain_id=$1 and canonical=true and lower(contract_address)=lower($2)
           and lower(topic0)=lower($3)
         order by block_number desc limit 5000`,
        [chainId, factoryAddress, MARKET_CREATED_TOPIC0],
      );
      for (const row of rows.rows) {
        let topics: string[] = [];
        try {
          topics = JSON.parse(row.topics) as string[];
        } catch {
          continue;
        }
        if (topics.length < 3) continue;
        const marketTopic = topics[2];
        if (!marketTopic || marketTopic.length !== 66) continue;
        const market = getAddress(`0x${marketTopic.slice(26)}`);
        tracked.add(market.toLowerCase());
      }
    }
  } catch (error) {
    console.error(JSON.stringify({
      service: "indexer",
      warning: "could_not_reload_discovered_markets",
      error: error instanceof Error ? error.message : String(error),
    }));
  }

  if (projectionsEnabled) {
    try {
      const projected = await db.query<{ market_address: string }>(
        "select market_address from projected_markets where chain_id=$1",
        [chainId],
      );
      for (const row of projected.rows) tracked.add(row.market_address.toLowerCase());
    } catch {
      // ignore
    }
  }
}

async function findCursor(): Promise<bigint> {
  const result = await db.query<{ height: string | null }>(
    "select max(block_number)::text height from blocks where chain_id=$1 and canonical=true",
    [chainId],
  );
  if (result.rows[0]?.height !== null && result.rows[0]?.height !== undefined) {
    return BigInt(result.rows[0].height) + 1n;
  }
  return configuredStart > 0n ? configuredStart : await client.getBlockNumber();
}

async function rewindToCommonAncestor(nextBlock: Block<bigint, true>): Promise<bigint | null> {
  if (nextBlock.number === null || nextBlock.number === 0n) return null;
  const previousHeight = nextBlock.number - 1n;
  const previous = await db.query<{ block_hash: string }>(
    "select block_hash from blocks where chain_id=$1 and block_number=$2 and canonical=true",
    [chainId, previousHeight],
  );
  if (!previous.rows[0] || previous.rows[0].block_hash.toLowerCase() === nextBlock.parentHash.toLowerCase()) return null;

  let ancestor = previousHeight;
  while (ancestor >= 0n) {
    const [databaseBlock, rpcBlock] = await Promise.all([
      db.query<{ block_hash: string }>(
        "select block_hash from blocks where chain_id=$1 and block_number=$2 and canonical=true",
        [chainId, ancestor.toString()],
      ),
      client.getBlock({ blockNumber: ancestor }),
    ]);
    if (databaseBlock.rows[0] && rpcBlock.hash
      && databaseBlock.rows[0].block_hash.toLowerCase() === rpcBlock.hash.toLowerCase()) break;
    if (ancestor === 0n) break;
    ancestor -= 1n;
  }

  const connection = await db.connect();
  try {
    await connection.query("begin");
    await connection.query(
      "update contract_events set canonical=false, confirmation='orphaned' where chain_id=$1 and block_number>$2 and canonical=true",
      [chainId, ancestor.toString()],
    );
    await connection.query(
      "update blocks set canonical=false, confirmation='orphaned' where chain_id=$1 and block_number>$2 and canonical=true",
      [chainId, ancestor.toString()],
    );
    if (projectionsEnabled) {
      await orphanProjectionsAbove(connection, chainId, ancestor);
    }
    await connection.query(
      `insert into risk_alerts(severity,alert_type,details,first_observed_at,last_observed_at)
       values ('critical','chain_reorg',$1,now(),now())`,
      [JSON.stringify({ ancestor: ancestor.toString(), observedAt: nextBlock.number.toString() })],
    );
    await connection.query("commit");
  } catch (error) {
    await connection.query("rollback");
    throw error;
  } finally {
    connection.release();
  }
  return ancestor + 1n;
}

async function ingestBlock(block: Block<bigint, true>, logs: Log[]) {
  if (block.number === null || block.hash === null) throw new Error("pending block returned for mined height");
  discoverMarketsFromLogs(logs);
  const connection = await db.connect();
  try {
    await connection.query("begin");
    await connection.query(
      `insert into blocks(chain_id,block_number,block_hash,parent_hash,block_timestamp)
       values($1,$2,$3,$4,to_timestamp($5)) on conflict do nothing`,
      [chainId, block.number.toString(), block.hash, block.parentHash, block.timestamp.toString()],
    );
    for (const log of logs) {
      const decoded = decodeProtocolLog(log);
      await connection.query(
        `insert into contract_events(chain_id,block_number,block_hash,transaction_hash,log_index,contract_address,topic0,topics,data,event_name,decoded_args)
         values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) on conflict do nothing`,
        [
          chainId,
          block.number.toString(),
          block.hash,
          log.transactionHash,
          Number(log.logIndex),
          log.address,
          log.topics[0] ?? null,
          JSON.stringify(log.topics),
          log.data,
          decoded?.kind ?? null,
          decoded
            ? JSON.stringify(decoded, (_k, v) => (typeof v === "bigint" ? v.toString() : v))
            : null,
        ],
      );
    }
    if (projectionsEnabled) {
      await projectLogs(connection, chainId, block.number, block.hash, block.timestamp, logs);
    }
    await connection.query("commit");
  } catch (error) {
    await connection.query("rollback");
    throw error;
  } finally {
    connection.release();
  }
}

projectionsEnabled = await ensureProjectionTables(db);
if (!projectionsEnabled) {
  console.warn(JSON.stringify({
    service: "indexer",
    warning: "projected_* tables missing — run database/migrations/002_projections.sql",
  }));
}

await loadDiscoveredMarketsFromDb();
let cursor = await findCursor();
let failures = 0;

console.log(JSON.stringify({
  service: "indexer",
  chainId,
  seedAddresses: seedAddresses.length,
  trackedAddresses: tracked.size,
  cursor: cursor.toString(),
  projectionsEnabled,
  discovery: "MarketCreated → track market; TradeExecuted → projected_open_accounts",
}));

for (;;) {
  try {
    const head = await client.getBlockNumber();
    while (cursor <= head) {
      const block = await client.getBlock({ blockNumber: cursor, includeTransactions: true });
      const rewind = await rewindToCommonAncestor(block);
      if (rewind !== null) {
        cursor = rewind;
        continue;
      }
      const logs = await client.getLogs({
        address: trackedAddresses(),
        fromBlock: cursor,
        toBlock: cursor,
      });
      await ingestBlock(block, logs);
      cursor += 1n;
    }
    failures = 0;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  } catch (error) {
    failures += 1;
    const delay = Math.min(30_000, 500 * (2 ** Math.min(failures, 6)));
    console.error(JSON.stringify({ service: "indexer", failures, delay, error: error instanceof Error ? error.message : String(error) }));
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
}
