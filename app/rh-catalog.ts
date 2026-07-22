/**
 * Community catalog for Robinhood mainnet tokens mirrored onto RHC testnet.
 * Source CA is encoded in mirror ERC20 name as `m:0x…` so keepers can re-link DexScreener.
 */
import type { Address } from "viem";
import { isAddress } from "viem";

export type CommunityMarket = {
  symbol: string;
  label?: string;
  market: string;
  marketId?: string;
  baseToken: string;
  /** Robinhood mainnet (or DexScreener) token CA used for live price */
  sourceCa: string;
  routeId?: string;
  liquidityVault?: string;
  chartSymbol?: string | null;
  pyth?: string | null;
  dexPrice: true;
  source: "dexscreener-robinhood";
  active?: boolean;
  createdAt?: string;
  creator?: string;
  dexUrl?: string;
};

const STORAGE_KEY = "anyperp.communityMarkets.v1";

export function loadCommunityMarkets(): CommunityMarket[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as CommunityMarket[];
    return Array.isArray(parsed) ? parsed.filter((m) => m.market && isAddress(m.market)) : [];
  } catch {
    return [];
  }
}

export function saveCommunityMarket(row: CommunityMarket) {
  if (typeof window === "undefined") return;
  const prev = loadCommunityMarkets();
  const key = marketCaKey(row);
  // One row per market address AND per source CA / base (1 CA → 1 market in catalog)
  const next = [
    row,
    ...prev.filter((m) => {
      if (m.market.toLowerCase() === row.market.toLowerCase()) return false;
      if (key && marketCaKey(m) === key) return false;
      return true;
    }),
  ].slice(0, 100);
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  try {
    window.dispatchEvent(new CustomEvent("anyperp-community-markets", { detail: next }));
  } catch {
    /* ignore */
  }
}

/** Canonical CA key: mainnet sourceCa preferred, else baseToken, else market. */
export function marketCaKey(m: {
  market?: string;
  sourceCa?: string | null;
  baseToken?: string | null;
}): string {
  const source = m.sourceCa?.toLowerCase();
  if (source && isAddress(source)) return `src:${source}`;
  const base = m.baseToken?.toLowerCase();
  if (base && isAddress(base)) return `base:${base}`;
  return `mkt:${(m.market ?? "").toLowerCase()}`;
}

type Dedupeable = {
  market: string;
  symbol?: string;
  sourceCa?: string | null;
  baseToken?: string | null;
  highCaps?: boolean;
  createdAt?: string;
  source?: string;
};

/**
 * Collapse multiple market addresses for the same underlying CA into one row.
 * Prefers highCaps / platform listed / newer createdAt.
 */
export function dedupeMarketsByCa<T extends Dedupeable>(list: T[]): T[] {
  const rank = (m: Dedupeable) => {
    let score = 0;
    if (m.highCaps) score += 100;
    if (m.source === "platform-demo" || m.source === "pyth-hermes" || m.source === "dexscreener-robinhood") score += 10;
    if (m.createdAt) {
      const t = Date.parse(m.createdAt);
      if (Number.isFinite(t)) score += Math.min(5, t / 1e13);
    }
    return score;
  };
  const map = new Map<string, T>();
  for (const m of list) {
    if (!m.market) continue;
    const key = marketCaKey(m);
    const prev = map.get(key);
    if (!prev || rank(m) >= rank(prev)) map.set(key, m);
  }
  return [...map.values()];
}

/** Find existing market for a mainnet source CA or base token (1 CA = 1 market). */
export function findMarketByCa(
  ca: string,
  platform: Array<{ market: string; sourceCa?: string | null; baseToken?: string | null }> = [],
): { market: string; sourceCa?: string | null; baseToken?: string | null; symbol?: string } | undefined {
  if (!ca || !isAddress(ca)) return undefined;
  const needle = ca.toLowerCase();
  const all = dedupeMarketsByCa([
    ...platform,
    ...loadCommunityMarkets(),
  ] as Dedupeable[]);
  return all.find((m) => {
    if (m.sourceCa?.toLowerCase() === needle) return true;
    if (m.baseToken?.toLowerCase() === needle) return true;
    return false;
  });
}

export function findCommunity(market?: string): CommunityMarket | undefined {
  if (!market || !isAddress(market)) return undefined;
  return loadCommunityMarkets().find((m) => m.market.toLowerCase() === market.toLowerCase());
}

/** Encode mainnet source CA into mirror token name for off-chain discovery */
export function mirrorTokenName(sourceCa: string, symbol: string): string {
  return `m:${sourceCa.toLowerCase()}`;
}

export function parseSourceCaFromMirrorName(name: string): string | null {
  const m = /^m:(0x[a-fA-F0-9]{40})$/i.exec(name.trim());
  return m ? m[1] : null;
}

export type DexPriceWindows = {
  m5?: number | null;
  h1?: number | null;
  h6?: number | null;
  h24?: number | null;
};

export type DexRhQuote = {
  priceUsd: number;
  symbol: string;
  name: string;
  liquidityUsd: number;
  marketCap: number | null;
  fdv?: number | null;
  volume24h: number | null;
  url?: string;
  pairAddress?: string;
  priceChange24h?: number | null;
  priceChange?: DexPriceWindows;
  chainId?: string;
};

function parsePair(p: Record<string, unknown>): DexRhQuote | null {
  if (p.priceUsd == null) return null;
  const base = (p.baseToken ?? {}) as Record<string, string>;
  const volume = (p.volume ?? {}) as Record<string, number>;
  const liquidity = (p.liquidity ?? {}) as Record<string, number>;
  const ch = (p.priceChange ?? {}) as Record<string, number>;
  return {
    priceUsd: Number(p.priceUsd),
    symbol: String(base.symbol || "TOKEN").slice(0, 12),
    name: String(base.name || base.symbol || "Token").slice(0, 32),
    liquidityUsd: Number(liquidity.usd || 0),
    marketCap: p.marketCap != null ? Number(p.marketCap) : null,
    fdv: p.fdv != null ? Number(p.fdv) : null,
    volume24h: volume.h24 != null ? Number(volume.h24) : null,
    url: p.url != null ? String(p.url) : undefined,
    pairAddress: p.pairAddress != null ? String(p.pairAddress) : undefined,
    priceChange24h: ch.h24 != null ? Number(ch.h24) : null,
    priceChange: {
      m5: ch.m5 != null ? Number(ch.m5) : null,
      h1: ch.h1 != null ? Number(ch.h1) : null,
      h6: ch.h6 != null ? Number(ch.h6) : null,
      h24: ch.h24 != null ? Number(ch.h24) : null,
    },
    chainId: p.chainId != null ? String(p.chainId) : undefined,
  };
}

export async function fetchRobinhoodDex(ca: string): Promise<DexRhQuote | null> {
  if (!isAddress(ca)) return null;
  // Prefer robinhood chain pairs
  try {
    const res = await fetch(`https://api.dexscreener.com/token-pairs/v1/robinhood/${ca}`, {
      signal: AbortSignal.timeout(12_000),
    });
    if (res.ok) {
      const pairs = (await res.json()) as Array<Record<string, unknown>>;
      // Highest liquidity pair first (closest to GMGN primary chart)
      const sorted = Array.isArray(pairs)
        ? [...pairs].sort((a, b) => {
            const la = Number(((a.liquidity ?? {}) as { usd?: number }).usd || 0);
            const lb = Number(((b.liquidity ?? {}) as { usd?: number }).usd || 0);
            return lb - la;
          })
        : [];
      const p = sorted[0];
      if (p) {
        const q = parsePair(p);
        if (q) return q;
      }
    }
  } catch {
    /* fall through */
  }
  // Fallback: search API
  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${ca}`, {
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { pairs?: Array<Record<string, unknown>> };
    const pairs = body.pairs ?? [];
    const rh = pairs
      .filter((p) => String(p.chainId).toLowerCase() === "robinhood")
      .sort((a, b) => {
        const la = Number(((a.liquidity ?? {}) as { usd?: number }).usd || 0);
        const lb = Number(((b.liquidity ?? {}) as { usd?: number }).usd || 0);
        return lb - la;
      });
    const pick = rh[0] ?? pairs[0];
    if (!pick) return null;
    return parsePair(pick);
  } catch {
    return null;
  }
}

/**
 * Rebuild OHLC closer to GMGN/DexScreener using multi-window % anchors (m5/h1/h6/h24).
 * Not tick-perfect history (no public RH candle API), but tracks real moves + live mark.
 * unitScale: 1 = token price USD; or marketCap/price for MC chart (GMGN default).
 */
export function syntheticMainnetCandles(
  mark: number,
  change24hPct: number | null | undefined,
  intervalSec: number,
  count = 96,
  windows?: DexPriceWindows | null,
  unitScale = 1,
): { time: number; open: number; high: number; low: number; close: number }[] {
  if (!(mark > 0)) return [];
  const scale = unitScale > 0 ? unitScale : 1;
  const now = Math.floor(Date.now() / 1000);
  const live = mark * scale;

  // Anchor prices at past horizons from Dex % changes
  const pct = (v: number | null | undefined) =>
    v != null && Number.isFinite(v) ? v / 100 : null;
  const w = windows ?? { h24: change24hPct };
  const anchors: { ageSec: number; price: number }[] = [{ ageSec: 0, price: live }];
  const add = (ageSec: number, p: number | null) => {
    if (p == null) return;
    const past = live / (1 + p);
    if (past > 0) anchors.push({ ageSec, price: past });
  };
  add(5 * 60, pct(w.m5));
  add(60 * 60, pct(w.h1));
  add(6 * 60 * 60, pct(w.h6));
  add(24 * 60 * 60, pct(w.h24 ?? change24hPct));
  anchors.sort((a, b) => b.ageSec - a.ageSec); // oldest first

  function priceAtAge(ageSec: number): number {
    if (anchors.length === 1) return anchors[0].price;
    // interpolate between surrounding anchors
    for (let i = 0; i < anchors.length - 1; i++) {
      const a = anchors[i];
      const b = anchors[i + 1];
      if (ageSec <= a.ageSec && ageSec >= b.ageSec) {
        const t = (a.ageSec - ageSec) / Math.max(1, a.ageSec - b.ageSec);
        return a.price + (b.price - a.price) * t;
      }
    }
    if (ageSec >= anchors[0].ageSec) return anchors[0].price;
    return anchors[anchors.length - 1].price;
  }

  const out: { time: number; open: number; high: number; low: number; close: number }[] = [];
  let prevClose = priceAtAge(count * intervalSec);
  for (let i = 0; i < count; i++) {
    const ageEnd = (count - 1 - i) * intervalSec;
    const ageStart = ageEnd + intervalSec;
    const open = prevClose;
    let close = priceAtAge(ageEnd);
    // micro volatility between anchors (keeps candle bodies realistic, not flat)
    const mid = priceAtAge(ageEnd + intervalSec / 2);
    const noiseAmp = Math.abs(close - open) * 0.35 + live * 0.0015;
    const wiggle = Math.sin(i * 1.7) * noiseAmp * 0.4;
    close = Math.max(live * 1e-9, close + wiggle * 0.15);
    const high = Math.max(open, close, mid) + noiseAmp * 0.25;
    const low = Math.min(open, close, mid) - noiseAmp * 0.25;
    out.push({
      time: now - ageEnd,
      open,
      high: Math.max(high, open, close),
      low: Math.max(live * 1e-12, Math.min(low, open, close)),
      close,
    });
    prevClose = close;
  }
  // Snap last candle to live mark (price or MC)
  const last = out[out.length - 1];
  last.close = live;
  last.high = Math.max(last.high, live);
  last.low = Math.min(last.low, live);
  return out;
}

export function allTradeableMarkets<T extends { market: string; symbol: string; sourceCa?: string | null; baseToken?: string | null; highCaps?: boolean; source?: string }>(
  platform: T[],
): (T | CommunityMarket)[] {
  const community = loadCommunityMarkets();
  const seen = new Set(platform.map((m) => m.market.toLowerCase()));
  const extra = community.filter((m) => !seen.has(m.market.toLowerCase()));
  // Platform first, then community — then collapse by source CA / base token
  return dedupeMarketsByCa([...platform, ...extra]);
}

/** Merge chain-discovered launches into local catalog (instant multi-browser discovery). */
export function mergeDiscovered(rows: CommunityMarket[]) {
  if (typeof window === "undefined" || !rows.length) return;
  const prev = loadCommunityMarkets();
  const map = new Map(prev.map((m) => [m.market.toLowerCase(), m]));
  for (const r of rows) {
    if (!r.market) continue;
    map.set(r.market.toLowerCase(), { ...map.get(r.market.toLowerCase()), ...r });
  }
  const next = [...map.values()].slice(0, 100);
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  try {
    window.dispatchEvent(new CustomEvent("anyperp-community-markets", { detail: next }));
  } catch {
    /* ignore */
  }
}
