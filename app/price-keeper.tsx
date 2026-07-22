"use client";

import { useEffect, useRef } from "react";
import { isAddress, type Address } from "viem";
import { fetchRobinhoodDex } from "./rh-catalog";
import { adaptersInSync } from "./oracle-sync";

type Props = {
  enabled: boolean;
  account?: Address;
  baseToken?: string;
  sourceCa?: string;
  onPrice?: (px: number) => void;
  onStatus?: (msg: string) => void;
  /** Fired after a successful on-chain oracle push so UI can re-read index / PnL */
  onOraclePushed?: (price: number) => void;
  /** Manual force sync (wallet) — optional callback parent can trigger */
  requestWalletSync?: boolean;
  onWalletSyncDone?: () => void;
  intervalMs?: number;
  /** Hosted API base ("" = same-origin). When set, auto-push uses server key (no wallet spam). */
  apiBase?: string;
  apiEnabled?: boolean;
};

async function pushViaApi(
  apiBase: string,
  baseToken: string,
  sourceCa: string,
  priceUsd: number,
  liquidityUsd: number,
): Promise<{ ok: boolean; price?: number; error?: string }> {
  try {
    const res = await fetch(`${apiBase}/v1/oracle/push`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseToken, sourceCa, priceUsd, liquidityUsd }),
      cache: "no-store",
    });
    const body = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      price?: number;
      error?: string;
      message?: string;
    };
    if (!res.ok) {
      return { ok: false, error: body.message || body.error || `API ${res.status}` };
    }
    return { ok: true, price: body.price ?? priceUsd };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Keeps mainnet Dex price on the UI and pushes it into on-chain mock oracles
 * so settlement index / PnL track the chart — not a stuck launch price.
 *
 * Prefer server push (`POST /v1/oracle/push`) so users do not sign every tick.
 * Wallet sync only when parent requests once or as last-resort before a trade.
 */
export function DexPriceKeeper({
  enabled,
  account,
  baseToken,
  sourceCa,
  onPrice,
  onStatus,
  onOraclePushed,
  requestWalletSync,
  onWalletSyncDone,
  intervalMs = 10_000,
  apiBase = "",
  apiEnabled = true,
}: Props) {
  const busy = useRef(false);
  const lastPushAt = useRef(0);
  const lastPushPrice = useRef(0);

  // Passive poll + auto server oracle push when drift > ~0.4%
  useEffect(() => {
    if (!enabled || !sourceCa || !isAddress(sourceCa)) return;
    let cancelled = false;

    async function tick() {
      if (cancelled || busy.current) return;
      try {
        const dex = await fetchRobinhoodDex(sourceCa!);
        if (!dex || !(dex.priceUsd > 0)) {
          onStatus?.("Dex price unavailable");
          return;
        }
        onPrice?.(dex.priceUsd);

        let chainNote = "settlement sync…";
        let onChainAvg = 0;
        if (baseToken && isAddress(baseToken)) {
          const sync = await adaptersInSync(baseToken as Address);
          if (!sync.ok) {
            chainNote = "feeds diverged — pushing live Dex";
          } else {
            const mid = sync.prices.filter((p) => p > 0);
            if (mid.length) {
              onChainAvg = mid.reduce((a, b) => a + b, 0) / mid.length;
              const drift = Math.abs(onChainAvg - dex.priceUsd) / dex.priceUsd;
              chainNote =
                drift > 0.004
                  ? `mark drift ${(drift * 100).toFixed(1)}% — syncing settlement`
                  : "on-chain mark ≈ mainnet";
            }
          }
        }

        const drift =
          onChainAvg > 0 ? Math.abs(onChainAvg - dex.priceUsd) / dex.priceUsd : 1;
        const now = Date.now();
        const cool = now - lastPushAt.current < 8_000;
        const priceMoved =
          lastPushPrice.current <= 0 ||
          Math.abs(dex.priceUsd - lastPushPrice.current) / dex.priceUsd > 0.003;

        if (
          apiEnabled &&
          baseToken &&
          isAddress(baseToken) &&
          !cool &&
          (drift > 0.004 || priceMoved) &&
          !busy.current
        ) {
          busy.current = true;
          try {
            const pushed = await pushViaApi(
              apiBase,
              baseToken,
              sourceCa!,
              dex.priceUsd,
              Math.max(1_000_000, dex.liquidityUsd || 0),
            );
            if (pushed.ok) {
              lastPushAt.current = Date.now();
              lastPushPrice.current = pushed.price ?? dex.priceUsd;
              chainNote = "settlement updated from mainnet Dex";
              onOraclePushed?.(pushed.price ?? dex.priceUsd);
            } else if (pushed.error?.includes("unconfigured") || pushed.error?.includes("503")) {
              chainNote = "server oracle offline — use Sync once or trade will wallet-sync";
            } else {
              chainNote = `push: ${(pushed.error || "failed").slice(0, 80)}`;
            }
          } finally {
            busy.current = false;
          }
        }

        if (!cancelled) {
          onStatus?.(
            `Mainnet $${dex.priceUsd < 0.01 ? dex.priceUsd.toPrecision(4) : dex.priceUsd.toLocaleString(undefined, { maximumFractionDigits: 6 })} · ${chainNote}`,
          );
        }
      } catch {
        /* ignore poll errors */
      }
    }

    void tick();
    const id = window.setInterval(() => void tick(), intervalMs);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [
    enabled,
    sourceCa,
    baseToken,
    intervalMs,
    onPrice,
    onStatus,
    onOraclePushed,
    apiBase,
    apiEnabled,
  ]);

  // Optional one-shot wallet heal (user clicked Sync)
  useEffect(() => {
    if (!requestWalletSync || !account || !baseToken || !sourceCa) return;
    if (!isAddress(baseToken) || !isAddress(sourceCa)) return;
    if (busy.current) return;
    let cancelled = false;
    busy.current = true;
    void (async () => {
      try {
        onStatus?.("Syncing settlement price…");
        const dex = await fetchRobinhoodDex(sourceCa);
        if (!dex?.priceUsd) throw new Error("No Dex price");

        // Prefer server (no wallet) when available
        if (apiEnabled) {
          const pushed = await pushViaApi(
            apiBase,
            baseToken,
            sourceCa,
            dex.priceUsd,
            Math.max(1_000_000, dex.liquidityUsd || 0),
          );
          if (pushed.ok) {
            lastPushAt.current = Date.now();
            lastPushPrice.current = pushed.price ?? dex.priceUsd;
            if (!cancelled) {
              onStatus?.("Settlement synced to mainnet Dex (server)");
              onOraclePushed?.(pushed.price ?? dex.priceUsd);
            }
            return;
          }
        }

        const { pushIdenticalWithInjectedWallet } = await import("./oracle-sync");
        await pushIdenticalWithInjectedWallet(
          account,
          baseToken as Address,
          dex.priceUsd,
          Math.max(1_000_000, dex.liquidityUsd || 0),
        );
        lastPushAt.current = Date.now();
        lastPushPrice.current = dex.priceUsd;
        if (!cancelled) {
          onStatus?.("Settlement synced once via wallet");
          onOraclePushed?.(dex.priceUsd);
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (!cancelled) {
          if (/User rejected|denied|4001/i.test(msg)) onStatus?.("Sync cancelled");
          else onStatus?.(`Sync: ${msg.slice(0, 100)}`);
        }
      } finally {
        busy.current = false;
        onWalletSyncDone?.();
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    requestWalletSync,
    account,
    baseToken,
    sourceCa,
    onStatus,
    onWalletSyncDone,
    onOraclePushed,
    apiBase,
    apiEnabled,
  ]);

  return null;
}
