/**
 * Pure helpers for keeper account/order discovery.
 * Kept free of I/O so unit tests can double-check merge/window logic.
 */

export function mergeAddresses(...lists: readonly (readonly string[])[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const list of lists) {
    for (const value of list) {
      const key = value.toLowerCase();
      if (!key.startsWith("0x") || key.length !== 42) continue;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(value);
    }
  }
  return out;
}

/** Inclusive scan window for recent trigger order IDs. */
export function recentOrderIdWindow(nextOrderId: bigint, maxLookback: bigint): { start: bigint; endExclusive: bigint } {
  if (nextOrderId <= 1n) return { start: 1n, endExclusive: 1n };
  const endExclusive = nextOrderId;
  const start = nextOrderId > maxLookback + 1n ? nextOrderId - maxLookback : 1n;
  return { start, endExclusive };
}

/** Inclusive scan window for withdrawal request IDs. */
export function recentRequestIdWindow(nextRequestId: bigint, maxLookback: bigint): { start: bigint; endExclusive: bigint } {
  if (nextRequestId <= 1n) return { start: 1n, endExclusive: 1n };
  const endExclusive = nextRequestId;
  const start = nextRequestId > maxLookback + 1n ? nextRequestId - maxLookback : 1n;
  return { start, endExclusive };
}

/** Cap log lookback so public RPCs are not hammered. */
export function clampBlockLookback(head: bigint, lookback: bigint, minStart = 0n): bigint {
  if (lookback <= 0n) return head;
  if (head <= minStart) return minStart;
  const candidate = head > lookback ? head - lookback + 1n : minStart;
  return candidate < minStart ? minStart : candidate;
}
