import { marketDataCache } from "./cache.js";

/** Well-known Crypto/* USD feed ids (Hermes hex, no 0x). */
export const PYTH_FEED_PRESETS: Record<string, { id: string; symbol: string; description: string }> = {
  BTC: {
    id: "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43",
    symbol: "BTC/USD",
    description: "Bitcoin",
  },
  ETH: {
    id: "ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace",
    symbol: "ETH/USD",
    description: "Ethereum",
  },
  SOL: {
    id: "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d",
    symbol: "SOL/USD",
    description: "Solana",
  },
  USDC: {
    id: "eaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a",
    symbol: "USDC/USD",
    description: "USD Coin",
  },
};

export type PythPrice = {
  id: string;
  symbol?: string;
  price: number;
  conf: number;
  expo: number;
  publishTime: number;
  publishTimeIso: string;
  rawPrice: string;
  rawConf: string;
  source: "hermes";
  stale: boolean;
};

function strip0x(id: string): string {
  return id.startsWith("0x") || id.startsWith("0X") ? id.slice(2).toLowerCase() : id.toLowerCase();
}

function applyExpo(priceStr: string, expo: number): number {
  const price = Number(priceStr);
  if (!Number.isFinite(price)) return NaN;
  return price * 10 ** expo;
}

/**
 * Resolve feed id from:
 * - hex feed id
 * - preset symbol (BTC, ETH, SOL)
 * - comma-separated env defaults
 */
export function resolveFeedIds(input: string | undefined, defaults: string[]): string[] {
  const raw = (input?.trim() ? input : defaults.join(",")).split(",").map((s) => s.trim()).filter(Boolean);
  const out: string[] = [];
  for (const part of raw) {
    const upper = part.toUpperCase();
    if (PYTH_FEED_PRESETS[upper]) {
      out.push(PYTH_FEED_PRESETS[upper].id);
      continue;
    }
    // Only accept 64-char hex as Hermes price id (user base58 keys are not feed ids)
    const hex = strip0x(part);
    if (/^[0-9a-f]{64}$/i.test(hex)) out.push(hex);
  }
  return [...new Set(out)];
}

export async function fetchHermesPrices(opts: {
  hermesUrl: string;
  apiKey?: string;
  ids: string[];
  maxAgeSeconds: number;
  ttlMs: number;
}): Promise<PythPrice[]> {
  const ids = opts.ids.map(strip0x).filter((id) => /^[0-9a-f]{64}$/i.test(id));
  if (!ids.length) return [];

  const cacheKey = `pyth:${ids.sort().join(",")}`;
  const cached = marketDataCache.get<PythPrice[]>(cacheKey);
  if (cached) return cached;

  const qs = ids.map((id) => `ids[]=${encodeURIComponent(id)}`).join("&");
  const url = `${opts.hermesUrl.replace(/\/$/, "")}/v2/updates/price/latest?${qs}&parsed=true`;

  const headers: Record<string, string> = {
    accept: "application/json",
    "user-agent": "AnyPerp/0.1",
  };
  // Optional key — public Hermes ignores unknown headers; paid gateways may require them.
  if (opts.apiKey) {
    headers.Authorization = `Bearer ${opts.apiKey}`;
    headers["X-API-Key"] = opts.apiKey;
  }

  const res = await fetch(url, { headers, signal: AbortSignal.timeout(12_000) });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Pyth Hermes ${res.status}: ${body.slice(0, 240)}`);
  }
  const data = (await res.json()) as {
    parsed?: Array<{
      id: string;
      price: { price: string; conf: string; expo: number; publish_time: number };
    }>;
  };

  const now = Math.floor(Date.now() / 1000);
  const symbolById = new Map(
    Object.values(PYTH_FEED_PRESETS).map((p) => [p.id.toLowerCase(), p.symbol] as const),
  );

  const prices: PythPrice[] = (data.parsed ?? []).map((row) => {
    const id = strip0x(row.id);
    const expo = row.price.expo;
    const price = applyExpo(row.price.price, expo);
    const conf = applyExpo(row.price.conf, expo);
    const publishTime = row.price.publish_time;
    return {
      id,
      symbol: symbolById.get(id),
      price,
      conf,
      expo,
      publishTime,
      publishTimeIso: new Date(publishTime * 1000).toISOString(),
      rawPrice: row.price.price,
      rawConf: row.price.conf,
      source: "hermes",
      stale: now - publishTime > opts.maxAgeSeconds,
    };
  });

  return marketDataCache.set(cacheKey, prices, opts.ttlMs);
}

export async function searchPriceFeeds(opts: {
  hermesUrl: string;
  apiKey?: string;
  query: string;
  ttlMs: number;
}): Promise<Array<{ id: string; symbol: string; description: string; assetType?: string }>> {
  const q = opts.query.trim();
  if (!q) return [];
  const cacheKey = `pyth:search:${q.toLowerCase()}`;
  const cached = marketDataCache.get<Array<{ id: string; symbol: string; description: string; assetType?: string }>>(cacheKey);
  if (cached) return cached;

  const url = `${opts.hermesUrl.replace(/\/$/, "")}/v2/price_feeds?query=${encodeURIComponent(q)}&asset_type=crypto`;
  const headers: Record<string, string> = { accept: "application/json", "user-agent": "AnyPerp/0.1" };
  if (opts.apiKey) {
    headers.Authorization = `Bearer ${opts.apiKey}`;
    headers["X-API-Key"] = opts.apiKey;
  }
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(12_000) });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Pyth feed search ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = (await res.json()) as Array<{
    id: string;
    attributes?: { display_symbol?: string; description?: string; asset_type?: string; symbol?: string };
  }>;
  const mapped = (Array.isArray(data) ? data : []).slice(0, 40).map((row) => ({
    id: strip0x(row.id),
    symbol: row.attributes?.display_symbol ?? row.attributes?.symbol ?? row.id.slice(0, 12),
    description: row.attributes?.description ?? "",
    assetType: row.attributes?.asset_type,
  }));
  return marketDataCache.set(cacheKey, mapped, opts.ttlMs);
}
