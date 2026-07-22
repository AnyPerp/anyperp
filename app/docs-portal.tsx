"use client";

import { useMemo, useState } from "react";

type DocsPortalProps = {
  onHome(): void;
  onLaunch(): void;
};

type DocSection = {
  id: string;
  group: string;
  title: string;
  summary: string;
  content: React.ReactNode;
};

const FACTORY = process.env.NEXT_PUBLIC_MARKET_FACTORY_ADDRESS ?? "Not configured";
const REGISTRY = process.env.NEXT_PUBLIC_MARKET_REGISTRY_ADDRESS ?? "Not configured";
const ORACLE_ROUTER = process.env.NEXT_PUBLIC_ORACLE_ROUTER_ADDRESS ?? "Not configured";
const COLLATERAL = process.env.NEXT_PUBLIC_COLLATERAL_ADDRESS ?? "Not configured";
const EXPLORER = "https://explorer.testnet.chain.robinhood.com/address/";
/** Static PDF served from public/docs (read in-browser + download). */
export const WHITEPAPER_PATH = "/docs/AnyPerp-Whitepaper-v0.1.pdf";
const WHITEPAPER_TITLE = "AnyPerp Technical Whitepaper v0.1.0-testnet";

function AddressRow({ label, address, note }: { label: string; address: string; note: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    await navigator.clipboard?.writeText(address);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  }
  return <div className="docs-address-row">
    <div><strong>{label}</strong><span>{note}</span></div>
    <code>{address}</code>
    {address.startsWith("0x") ? <><button onClick={copy}>{copied ? "Copied" : "Copy"}</button><a href={`${EXPLORER}${address}`} target="_blank" rel="noreferrer">Explorer</a></> : <span>Fresh deployment required</span>}
  </div>;
}

const sections: DocSection[] = [
  {
    id: "overview", group: "Start here", title: "AnyPerp in 60 seconds", summary: "What it is, who it's for, and why every market still has brakes.",
    content: <>
      <p>AnyPerp lets anyone open a perp market for a supported token on Robinhood Chain. A perp means you can long or short without holding the token. Every market keeps its own liquidity and risk - no shared bloodbath.</p>
      <p>Creating a market is easy. Going live is earned. Contracts check price feeds, LP capital, insurance, and risk caps. Fail any of those? It stays a draft. Nobody can open a position.</p>
      <div className="docs-callout docs-callout-blue"><strong>Anyone can create. Not every market can trade.</strong><p>Rules live in the contracts. No frontend button or creator badge can skip them.</p></div>
      <h3>Built for</h3>
      <div className="docs-card-grid"><article><b>Traders</b><p>Long or short before a big exchange bothers to list the coin.</p></article><article><b>Token teams</b><p>Help seed a perp without getting a free pass on safety.</p></article><article><b>LPs</b><p>Back one market at a time and always know where capital sits.</p></article></div>
      <h3>Where we are</h3>
      <p>Local lifecycle tests pass. A fresh Robinhood Chain testnet deploy is still required. The old deployer key was disclosed - do not fund or trust that deploy. Production collateral, live feeds, final risk, and mainnet addresses are not set.</p>
      <p>Prefer the long form? Read the <a href="#whitepaper">technical whitepaper</a> on this site, or <a href={WHITEPAPER_PATH} download="AnyPerp-Whitepaper-v0.1.pdf">download the PDF</a>.</p>
    </>
  },
  {
    id: "whitepaper", group: "Start here", title: "Whitepaper", summary: "Read the full technical whitepaper in the browser, or download the PDF.",
    content: <>
      <p>
        The <strong>{WHITEPAPER_TITLE}</strong> covers product thesis, isolated market design, oracles,
        risk tiers, liquidation and funding, contract topology, off-chain stack, and go/no-go gates.
        Unaudited testnet document — not investment advice and not a safety certificate.
      </p>
      <div className="docs-whitepaper-actions">
        <a className="docs-wp-btn docs-wp-btn-primary" href={WHITEPAPER_PATH} target="_blank" rel="noreferrer">
          Open whitepaper
        </a>
        <a className="docs-wp-btn" href={WHITEPAPER_PATH} download="AnyPerp-Whitepaper-v0.1.pdf">
          Download PDF
        </a>
        <a className="docs-wp-btn docs-wp-btn-ghost" href="#overview">
          Back to overview
        </a>
      </div>
      <div className="docs-whitepaper-meta">
        <span>Format · PDF</span>
        <span>Version · 0.1.0-testnet</span>
        <span>Path · <code>{WHITEPAPER_PATH}</code></span>
      </div>
      <div className="docs-whitepaper-frame-wrap">
        <iframe
          className="docs-whitepaper-frame"
          title={WHITEPAPER_TITLE}
          src={`${WHITEPAPER_PATH}#view=FitH`}
          loading="lazy"
        />
      </div>
      <p className="docs-whitepaper-fallback">
        If the preview does not load in your browser, use{" "}
        <a href={WHITEPAPER_PATH} target="_blank" rel="noreferrer">Open whitepaper</a>
        {" "}or{" "}
        <a href={WHITEPAPER_PATH} download="AnyPerp-Whitepaper-v0.1.pdf">Download PDF</a>.
      </p>
    </>
  },
  {
    id: "mental-model", group: "Start here", title: "From token to live market", summary: "Five steps from a contract address to open long/short trading.",
    content: <>
      <ol className="docs-steps"><li><span>1</span><div><strong>Pick the token</strong><p>Token, collateral, price route, risk tier, and a creator bond.</p></div></li><li><span>2</span><div><strong>Prove the price</strong><p>Feeds must be fresh, agree, and sit on real depth and history.</p></div></li><li><span>3</span><div><strong>Fund this market</strong><p>LP seed + insurance for this vault only - never mixed elsewhere.</p></div></li><li><span>4</span><div><strong>Trade inside the rails</strong><p>Longs and shorts open under leverage, OI, size, and skew caps.</p></div></li><li><span>5</span><div><strong>Contain the mess</strong><p>Reduce-only, pause, or settle - without draining another market.</p></div></li></ol>
    </>
  },
  {
    id: "crypto-terms", group: "Start here", title: "Words, plain English", summary: "App jargon, without the finance-degree filter.",
    content: <>
      <dl className="docs-definition"><div><dt>Perp</dt><dd>A futures contract with no expiry. Tracks the token price forever (or until the market dies).</dd></div><div><dt>Long</dt><dd>You win when price goes up.</dd></div><div><dt>Short</dt><dd>You win when price goes down.</dd></div><div><dt>Leverage</dt><dd>Trade bigger than your margin. More juice, closer liquidation.</dd></div><div><dt>Margin</dt><dd>The collateral behind your position. Bleed enough and you get liquidated.</dd></div><div><dt>Oracle / price feed</dt><dd>Outside price data the contracts trust - not "last trade in this app."</dd></div><div><dt>LP vault</dt><dd>The pool taking the other side. LPs earn fees; they lose when traders win.</dd></div><div><dt>Open interest</dt><dd>Total size of open longs and shorts in a market.</dd></div><div><dt>Funding</dt><dd>Payments between longs and shorts that pull the perp toward spot.</dd></div><div><dt>Liquidation</dt><dd>Forced cut when margin can't cover the risk anymore.</dd></div><div><dt>Reduce-only</dt><dd>You can close or shrink - you can't add new risk.</dd></div><div><dt>Market skew</dt><dd>How lopsided longs vs shorts are right now.</dd></div></dl>
    </>
  },
  {
    id: "market-lifecycle", group: "Core concepts", title: "Market lifecycle", summary: "The states that decide what creators, traders, LPs, keepers, and guardians can do.",
    content: <>
      <div className="docs-state-flow"><span>Draft</span><i>'</i><span>Validation</span><i>'</i><span>Bootstrapping</span><i>'</i><span className="state-active">Active</span></div>
      <dl className="docs-definition"><div><dt>Draft</dt><dd>Config can be set up. No trading, funding, or liquidations yet.</dd></div><div><dt>Pending validation</dt><dd>Token behavior, oracle route, and tier envelope get checked.</dd></div><div><dt>Bootstrapping</dt><dd>Bond, LP seed, and insurance minimums must land.</dd></div><div><dt>Active</dt><dd>Open and close trades within all caps. This is the fun state.</dd></div><div><dt>Reduce-only</dt><dd>Only move toward flat. New open interest is rejected.</dd></div><div><dt>Paused</dt><dd>Trading stops. Withdrawals and settlement follow strict rules.</dd></div><div><dt>Settling / Closed</dt><dd>A time-weighted valid oracle closes positions after a dispute delay; claims unlock.</dd></div></dl>
      <div className="docs-callout docs-callout-amber"><strong>State lives on-chain.</strong><p>The app reads contract state and confirmation tier. It never pretends a market is live from an API-only row.</p></div>
    </>
  },
  {
    id: "pricing", group: "Core concepts", title: "How your fill is priced", summary: "Where the number comes from - and why it can differ from spot.",
    content: <>
      <p>We start from a checked spot index. Your fill then moves a little with size, vault usage, and whether you're making the long/short skew worse. The LP vault takes the other side of trader PnL.</p>
      <div className="docs-formula"><span>Execution price</span><code>P_exec = P_index x (1 + baseSpread + integratedSkewImpact + utilizationFee + confidenceFee + tierFee)</code></div>
      <div className="docs-formula"><span>Unrealized PnL</span><code>long: size x (P_mark - P_entry) &nbsp; | &nbsp; short: |size| x (P_entry - P_mark)</code></div>
      <h3>Four prices, not one</h3>
      <dl className="docs-definition"><div><dt>Oracle price</dt><dd>One registered source, with freshness and confidence metadata.</dd></div><div><dt>Index price</dt><dd>The validated blend of sources that pass the rules.</dd></div><div><dt>Execution price</dt><dd>What you actually get for a given size after impact and fees.</dd></div><div><dt>Mark (this MVP)</dt><dd>The current valid index for PnL and liquidation. A separate premium/TWAP mark is still a pre-prod requirement.</dd></div></dl>
      <h3>Example: token prints $0.10</h3>
      <p>We don't hardcode $0.10. We don't copy the last perp print either. Registered sources watch the pools. If two independent reads land at $0.0998 and $0.1002, the router checks age, confidence, depth, history, independence, and deviation - then builds the index. A small long may fill a tick above; a short a tick below. Your max-price limit is the last line of defense.</p>
      <div className="docs-callout docs-callout-red"><strong>$0.10 on a puddle is not a market.</strong><p>If the only print is a shallow pool the creator controls, the market stays inactive. Funding can't fix a bad index - it only shuffles value between longs and shorts after a real index exists.</p></div>
      <p>No valid index? Risk-increasing fills, liquidations, and normal reductions revert. Operators pause or move to bounded settlement. A "safe-reduction oracle mode" is not in this MVP.</p>
    </>
  },
  {
    id: "oracle", group: "Core concepts", title: "Earning a live market", summary: "A token address isn't enough. You need a price the protocol can defend.",
    content: <>
      <p>A route tells the contracts where prices come from and how strict the checks are. This MVP can use Chainlink-style feeds and Uniswap-style TWAPs once the real feed, deploy, and pool are verified. Mock prices are local/testnet only.</p>
      <pre className="docs-code"><code>{`valid(source) =
  source.registered
  && age <= tier.maxAge
  && confidence / price <= tier.maxConfidenceRatio
  && decimals are normalized without overflow

valid(index) =
  validSourceCount >= tier.minSources
  && maxPairwiseDeviation <= tier.maxDeviation
  && spotLiquidity >= tier.minSpotLiquidity
  && history >= tier.minHistory
  && sequencerIsUp && gracePeriodElapsed`}</code></pre>
      <h3>Admission checklist</h3>
      <div className="docs-decision"><div><b>1</b><span>Is the base a normal token (transfers + decimals we support)?</span></div><div><b>2</b><span>Does a registered price route clear the tier?</span></div><div><b>3</b><span>Do requested caps stay inside the tier envelope?</span></div><div><b>4</b><span>Are bond, LP seed, and insurance minimums funded?</span></div></div>
      <div className="docs-callout docs-callout-red"><strong>No defensible price → no live market.</strong><p>DEX-only pricing is not a free pass. Thin pools, short history, fee-on-transfer, rebasing, and callback-capable assets stay blocked or tightly limited.</p></div>
    </>
  },
  {
    id: "risk", group: "Risk", title: "Why isolation matters", summary: "Permissionless creation only works if one bad market can't drain the rest.",
    content: <>
      <p>Each market owns its margin, LP vault, insurance, OI, skew, and bad debt. If one market loses, it cannot auto-raid another market's capital.</p>
      <div className="docs-tier-table"><div className="tier-head"><span>Tier</span><span>Typical evidence</span><span>Launch posture</span></div><div><b className="tier-blue">Blue-chip</b><span>Deep spot, mature multi-source pricing</span><span>Highest eligible caps</span></div><div><b className="tier-teal">Established</b><span>Durable liquidity + reliable history</span><span>Conservative caps</span></div><div><b className="tier-violet">Emerging</b><span>Thinner depth or shorter history</span><span>Low leverage and OI</span></div><div><b className="tier-coral">Experimental</b><span>Bare-minimum admissible evidence</span><span>Very low caps or draft-only</span></div></div>
      <div className="docs-callout docs-callout-amber"><strong>Numbers ≠ safety claims.</strong><p>Leverage, margin, OI, skew, impact, and confidence limits are simulation inputs. Production needs governance approval and economic validation.</p></div>
    </>
  },
  {
    id: "funding-liquidations", group: "Risk", title: "Funding, liquidations, losses", summary: "How the perp stays near spot - and what happens when margin runs out.",
    content: <>
      <h3>Funding</h3><p>A running funding index moves value between longs and shorts. Premium + skew push the market toward the valid index. Funding freezes if the sequencer or oracle is invalid - no back-charging stale time later.</p>
      <div className="docs-formula"><span>Funding payment</span><code>positionSize x (cumulativeFundingNow - entryFundingIndex)</code></div>
      <h3>Liquidation</h3><p>Eligible when equity slips under maintenance margin. Keepers try to close only enough to restore a safety buffer; full wipe is for severe or uneconomic cases.</p>
      <ol className="docs-waterfall"><li><span>01</span>Remaining position margin</li><li><span>02</span>Market insurance reserve</li><li><span>03</span>Capped protocol backstop grant</li><li><span>04</span>Auto-deleveraging</li><li><span>05</span>Socialized loss - disclosed last resort only</li></ol>
    </>
  },
  {
    id: "liquidity", group: "Economics", title: "LP vaults", summary: "Where liquidity comes from, how LPs earn, and how they can lose.",
    content: <>
      <p>Every live market has its own ERC-4626-style share vault with hardened first-deposit math. LPs take trading fees, funding imbalance, and counterparty PnL - and eat losses when traders win or liquidations go poorly.</p>
      <h3>In and out</h3><ul className="docs-list"><li>Deposits mint shares with conservative rounding + virtual shares/assets.</li><li>Withdrawals are request → execute, not one-click instant.</li><li>Exits that would break utilization or solvency get rejected.</li><li>Queued claims stay visible and can wait in high-risk states.</li></ul>
      <h3>Creator skin in the game</h3><p>Creators post a slashable bond and seed capital. A cut of real trading fees can flow back after insurance and protocol take. No gov/emissions token in the MVP. Wash volume is discouraged via fees, bond risk, no self-referral, and rewards on net revenue - not raw volume.</p>
    </>
  },
  {
    id: "contracts", group: "Developers", title: "Testnet deployment", summary: "Addresses show up only after a verified fresh deploy.",
    content: <>
      <div className="docs-network-card"><div><span>Network</span><strong>Robinhood Chain Testnet</strong></div><div><span>Chain ID</span><strong>46630</strong></div><div><span>Gas token</span><strong>ETH</strong></div><div><span>Release</span><strong>0.1.0-testnet</strong></div></div>
      <AddressRow label="MarketFactory" address={FACTORY} note="Spins up versioned candidate markets" />
      <AddressRow label="MarketRegistry" address={REGISTRY} note="Canonical market + state registry" />
      <AddressRow label="OracleRouter" address={ORACLE_ROUTER} note="Source aggregation and validation" />
      <AddressRow label="Collateral" address={COLLATERAL} note="Must be allowlisted and checked independently" />
      <div className="docs-callout docs-callout-red"><strong>Verified source ≠ audit.</strong><p>Explorer match means source matches bytecode. It does not mean the economics are safe or ready for real money.</p></div>
    </>
  },
  {
    id: "api", group: "Developers", title: "API & real-time data", summary: "Reads, prepared txs, and confirmation-aware WebSocket events.",
    content: <>
      <p>The backend never sees your private key. Mutation endpoints prepare or simulate calldata; your wallet signs and broadcasts.</p>
      <pre className="docs-code"><code>{`GET  /v1/tokens/:address/eligibility
GET  /v1/markets/:marketId
GET  /v1/markets/:marketId/oracle
GET  /v1/markets/:marketId/risk
POST /v1/markets/prepare
POST /v1/orders/prepare
GET  /v1/accounts/:address/portfolio
GET  /v1/transactions/:hash`}</code></pre>
      <p>Every live payload carries <code>chainId</code>, block number/hash, confirmation tier, event ID, timestamp, and schema version. Tx states: awaiting signature, submitted, soft-confirmed, L1-posted, finalized, replaced, reverted, orphaned.</p>
      <pre className="docs-code"><code>{`{
  "topic": "market.oracle",
  "schemaVersion": 1,
  "chainId": 46630,
  "confirmation": "soft_confirmed",
  "blockNumber": "0x...",
  "marketId": "0x...",
  "valid": false,
  "reason": "SOURCE_STALE"
}`}</code></pre>
    </>
  },
  {
    id: "trust", group: "Protocol", title: "Who can touch what", summary: "Governance, guardians, keepers, RPCs, and the hosted app - what they can and can't do.",
    content: <>
      <dl className="docs-definition"><div><dt>Governance timelock</dt><dd>Registers adapters, tier envelopes, fees, and implementations - after a delay.</dd></div><div><dt>Emergency guardian</dt><dd>Can pause, force reduce-only, or start bounded settlement. Cannot seize funds, raise leverage, pick a random settlement price, or unpause alone.</dd></div><div><dt>Keepers</dt><dd>Permissionless funding, triggers, withdrawals, liquidations - contracts still validate every call.</dd></div><div><dt>Sequencer &amp; RPCs</dt><dd>Affect ordering and what the app can see. Indexer tracks soft confirm → L1 post → finalize → orphan.</dd></div><div><dt>Hosted frontend</dt><dd>Can gate UI for safety or jurisdiction. Cannot make an invalid contract call valid.</dd></div></dl>
      <p>We remove operator power only after monitoring, incident response, and economic controls prove out. Testnet admin is not "trustless" - and we don't pretend it is.</p>
    </>
  },
  {
    id: "limits", group: "Protocol", title: "What's not in testnet", summary: "Left out on purpose until the risk story is real.",
    content: <>
      <div className="docs-card-grid docs-exclusion-grid"><article><b>No cross-margin</b><p>Margin stays isolated per trader and market.</p></article><article><b>No shared free-for-all pool</b><p>One market can't eat another LP vault.</p></article><article><b>No exotic collateral</b><p>Rebasing, fee-on-transfer, callbacks, weird tokens - out.</p></article><article><b>No anonymous price push</b><p>Live markets need registered, defensible routes.</p></article><article><b>No RWA perps</b><p>Hours, corporate actions, and legal rails need their own design.</p></article><article><b>No mainnet</b><p>Prod needs audit, simulation, oracle proof, and governance sign-off.</p></article></div>
    </>
  },
  {
    id: "sources", group: "Reference", title: "Source material", summary: "Primary docs behind our chain and integration assumptions.",
    content: <>
      <p>Last reviewed 2026-07-15. Addresses, feed coverage, pool depth, heartbeats, and live testnet behavior still need deploy-time validation even when a doc claims support.</p>
      <div className="docs-links">
        <a href={WHITEPAPER_PATH} target="_blank" rel="noreferrer"><b>AnyPerp whitepaper (PDF)</b><span>Read online or download — protocol, risk, architecture</span></a>
        <a href="https://docs.robinhood.com/chain/" target="_blank" rel="noreferrer"><b>Robinhood Chain docs</b><span>Network, wallets, RPC, bridging, AA</span></a>
        <a href="https://docs.chain.link/" target="_blank" rel="noreferrer"><b>Chainlink docs</b><span>Feeds, metadata, sequencer uptime, safety</span></a>
        <a href="https://developers.uniswap.org/docs" target="_blank" rel="noreferrer"><b>Uniswap developer docs</b><span>Pools, oracle observations, integration</span></a>
        <a href="https://explorer.testnet.chain.robinhood.com" target="_blank" rel="noreferrer"><b>Robinhood testnet explorer</b><span>Bytecode, verified source, txs, events</span></a>
        <a href="https://github.com/AnyPerp/anyperp" target="_blank" rel="noreferrer"><b>GitHub monorepo</b><span>Contracts, services, app, deployments</span></a>
      </div>
    </>
  },
];

export function DocsPortal({ onHome, onLaunch }: DocsPortalProps) {
  const [query, setQuery] = useState("");
  const visible = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return sections;
    return sections.filter((section) => `${section.title} ${section.summary} ${section.group}`.toLowerCase().includes(normalized));
  }, [query]);
  const groups = [...new Set(sections.map((section) => section.group))];

  return <div className="docs-surface">
    <div className="docs-banner"><strong>Testnet docs</strong><span>Unaudited. Everything here still needs live validation.</span></div>
    <div className="docs-layout">
      <aside className="docs-sidebar">
        <label className="docs-search"><span>Search docs</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Oracle, funding, API..." /></label>
        <nav aria-label="Documentation sections">{groups.map((group) => <div key={group}><p>{group}</p>{sections.filter((section) => section.group === group).map((section) => <a key={section.id} href={`#${section.id}`}>{section.title}</a>)}</div>)}</nav>
        <div className="docs-sidebar-actions">
          <a href="#whitepaper">Whitepaper</a>
          <a href={WHITEPAPER_PATH} download="AnyPerp-Whitepaper-v0.1.pdf">Download PDF</a>
          <button type="button" onClick={onHome}>Back home</button>
          <button type="button" onClick={onLaunch}>Open the app</button>
        </div>
      </aside>
      <article className="docs-article">
        <header className="docs-hero"><p className="landing-eyebrow">AnyPerp docs · anyperp.fun</p><h1>Know the rules. Then trade them.</h1><p>Start simple. Go deeper when you need price feeds, risk rails, LP vaults, contracts, the whitepaper, or the API.</p><div><span>VERSION 0.1.0</span><span>TESTNET</span><span>WHITEPAPER</span><span>anyperp.fun</span></div></header>
        {visible.length ? visible.map((section) => <section className="docs-section" id={section.id} key={section.id}><div className="docs-section-head"><p>{section.group}</p><h2>{section.title}</h2><span>{section.summary}</span></div><div className="docs-body">{section.content}</div></section>) : <div className="docs-no-results"><strong>Nothing matches "{query}"</strong><p>Try oracle, risk, funding, contracts, or API.</p></div>}
      </article>
      <aside className="docs-rail">
        <div><p>ON THIS PAGE</p>{visible.slice(0, 8).map((section) => <a href={`#${section.id}`} key={section.id}>{section.title}</a>)}</div>
        <div className="docs-status"><span className="status-dot" /><div><strong>Testnet deployed</strong><small>Chain 46630 · factory live</small></div></div>
        <div className="docs-rail-card docs-rail-whitepaper">
          <span>Whitepaper</span>
          <strong>Technical PDF<br />v0.1.0-testnet</strong>
          <small>Read on-site or download.</small>
          <div className="docs-rail-wp-actions">
            <a href="#whitepaper">Read here</a>
            <a href={WHITEPAPER_PATH} download="AnyPerp-Whitepaper-v0.1.pdf">Download</a>
          </div>
        </div>
        <div className="docs-rail-card"><span>Architecture</span><strong>Oracle-priced<br />isolated vaults</strong><small>Not a CLOB. Not a vAMM.</small></div>
      </aside>
    </div>
  </div>;
}
