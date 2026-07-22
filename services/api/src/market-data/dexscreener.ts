import { marketDataCache } from "./cache.js";

export type DexPairSummary = {
  chainId: string;
  dexId: string;
  pairAddress: string;
  url: string;
  baseToken: { address: string; name: string; symbol: string };
  quoteToken: { address: string; name: string; symbol: string };
  priceUsd: number | null;
  priceNative: string | null;
  volume24h: number | null;
  liquidityUsd: number | null;
  fdv: number | null;
  marketCap: number | null;
  priceChange24h: number | null;
  txns24h: { buys: number; sells: number } | null;
  pairCreatedAt: number | null;
};

export type DexTokenProfile = {
  url: string;
  chainId: string;
  tokenAddress: string;
  icon?: string;
  header?: string;
  description?: string;
  links?: Array<{ type?: string; label?: string; url: string }>;
  updatedAt?: string;
};

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function mapPair(raw: Record<string, unknown>): DexPairSummary {
  const base = (raw.baseToken ?? {}) as Record<string, string>;
  const quote = (raw.quoteToken ?? {}) as Record<string, string>;
  const volume = (raw.volume ?? {}) as Record<string, unknown>;
  const liquidity = (raw.liquidity ?? {}) as Record<string, unknown>;
  const priceChange = (raw.priceChange ?? {}) as Record<string, unknown>;
  const txns = (raw.txns ?? {}) as Record<string, Record<string, number>>;
  const h24 = txns.h24 ?? txns["24h"];
  return {
    chainId: String(raw.chainId ?? ""),
    dexId: String(raw.dexId ?? ""),
    pairAddress: String(raw.pairAddress ?? ""),
    url: String(raw.url ?? ""),
    baseToken: {
      address: base.address ?? "",
      name: base.name ?? "",
      symbol: base.symbol ?? "",
    },
    quoteToken: {
      address: quote.address ?? "",
      name: quote.name ?? "",
      symbol: quote.symbol ?? "",
    },
    priceUsd: num(raw.priceUsd),
    priceNative: raw.priceNative != null ? String(raw.priceNative) : null,
    volume24h: num(volume.h24),
    liquidityUsd: num(liquidity.usd),
    fdv: num(raw.fdv),
    marketCap: num(raw.marketCap),
    priceChange24h: num(priceChange.h24),
    txns24h: h24 ? { buys: Number(h24.buys ?? 0), sells: Number(h24.sells ?? 0) } : null,
    pairCreatedAt: num(raw.pairCreatedAt),
  };
}

async function dexFetch(baseUrl: string, path: string): Promise<unknown> {
  const url = `${baseUrl.replace(/\/$/, "")}${path}`;
  const res = await fetch(url, {
    headers: { accept: "application/json", "user-agent": "AnyPerp/0.1" },
    signal: AbortSignal.timeout(12_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`DexScreener ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

export async function fetchLatestTokenProfiles(baseUrl: string, ttlMs: number): Promise<DexTokenProfile[]> {
  const cacheKey = "dex:profiles:latest";
  const cached = marketDataCache.get<DexTokenProfile[]>(cacheKey);
  if (cached) return cached;
  const data = await dexFetch(baseUrl, "/token-profiles/latest/v1");
  const list = (Array.isArray(data) ? data : []).map((row) => {
    const r = row as Record<string, unknown>;
    return {
      url: String(r.url ?? ""),
      chainId: String(r.chainId ?? ""),
      tokenAddress: String(r.tokenAddress ?? ""),
      icon: r.icon ? String(r.icon) : undefined,
      header: r.header ? String(r.header) : undefined,
      description: r.description ? String(r.description) : undefined,
      links: Array.isArray(r.links) ? (r.links as DexTokenProfile["links"]) : undefined,
      updatedAt: r.updatedAt ? String(r.updatedAt) : undefined,
    } satisfies DexTokenProfile;
  });
  return marketDataCache.set(cacheKey, list, ttlMs);
}

export async function searchPairs(baseUrl: string, q: string, ttlMs: number): Promise<DexPairSummary[]> {
  const query = q.trim();
  if (!query) return [];
  const cacheKey = `dex:search:${query.toLowerCase()}`;
  const cached = marketDataCache.get<DexPairSummary[]>(cacheKey);
  if (cached) return cached;
  const data = (await dexFetch(baseUrl, `/latest/dex/search?q=${encodeURIComponent(query)}`)) as {
    pairs?: Record<string, unknown>[];
  };
  const pairs = (data.pairs ?? []).map(mapPair);
  return marketDataCache.set(cacheKey, pairs, ttlMs);
}

export async function tokenPairs(
  baseUrl: string,
  chainId: string,
  tokenAddress: string,
  ttlMs: number,
): Promise<DexPairSummary[]> {
  const chain = chainId.trim().toLowerCase();
  const token = tokenAddress.trim();
  const cacheKey = `dex:token:${chain}:${token.toLowerCase()}`;
  const cached = marketDataCache.get<DexPairSummary[]>(cacheKey);
  if (cached) return cached;
  const data = await dexFetch(baseUrl, `/token-pairs/v1/${encodeURIComponent(chain)}/${encodeURIComponent(token)}`);
  const pairs = (Array.isArray(data) ? data : []).map((row) => mapPair(row as Record<string, unknown>));
  // Prefer highest liquidity
  pairs.sort((a, b) => (b.liquidityUsd ?? 0) - (a.liquidityUsd ?? 0));
  return marketDataCache.set(cacheKey, pairs, ttlMs);
}

export async function tokensByAddresses(
  baseUrl: string,
  chainId: string,
  addresses: string[],
  ttlMs: number,
): Promise<DexPairSummary[]> {
  const chain = chainId.trim().toLowerCase();
  const list = addresses.map((a) => a.trim()).filter(Boolean).slice(0, 30);
  if (!list.length) return [];
  const cacheKey = `dex:tokens:${chain}:${list.map((a) => a.toLowerCase()).join(",")}`;
  const cached = marketDataCache.get<DexPairSummary[]>(cacheKey);
  if (cached) return cached;
  const data = await dexFetch(
    baseUrl,
    `/tokens/v1/${encodeURIComponent(chain)}/${list.map(encodeURIComponent).join(",")}`,
  );
  const pairs = (Array.isArray(data) ? data : []).map((row) => mapPair(row as Record<string, unknown>));
  return marketDataCache.set(cacheKey, pairs, ttlMs);
}

/** Best pair summary for a token (highest liquidity). */
export async function bestPairForToken(
  baseUrl: string,
  chainId: string,
  tokenAddress: string,
  ttlMs: number,
): Promise<DexPairSummary | null> {
  const pairs = await tokenPairs(baseUrl, chainId, tokenAddress, ttlMs);
  return pairs[0] ?? null;
}
