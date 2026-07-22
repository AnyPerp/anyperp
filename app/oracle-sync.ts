/**
 * Keep both mock oracle adapters in lockstep for a base token.
 * Divergent prices → OracleDeviation (0x0d637948) on Market.indexPrice().
 */
import {
  createPublicClient,
  createWalletClient,
  custom,
  http,
  isAddress,
  parseUnits,
  type Address,
  type WalletClient,
} from "viem";
import { resolveAppChain } from "../packages/sdk/src/index";

const appChain = resolveAppChain();
const rpcUrl =
  process.env.NEXT_PUBLIC_RPC_URL ?? appChain.rpcUrls.default.http[0] ?? "https://rpc.testnet.chain.robinhood.com";
const publicClient = createPublicClient({ chain: appChain, transport: http(rpcUrl) });

export const ORACLE_ADAPTERS: Address[] = (
  process.env.NEXT_PUBLIC_ORACLE_ADAPTERS ||
  "0x957ce5792080b0aaf97632cc78c976905fe17962,0x5d669814ca06142581bcea83f51f794d0fd1eafb"
)
  .split(",")
  .map((s) => s.trim())
  .filter((s): s is Address => isAddress(s));

const mockOracleAbi = [
  {
    type: "function",
    name: "set",
    stateMutability: "nonpayable",
    inputs: [
      { name: "asset", type: "address" },
      {
        name: "data",
        type: "tuple",
        components: [
          { name: "priceWad", type: "uint256" },
          { name: "confidenceBps", type: "uint256" },
          { name: "updatedAt", type: "uint256" },
          { name: "liquidityWad", type: "uint256" },
          { name: "historySeconds", type: "uint256" },
          { name: "validSources", type: "uint8" },
        ],
      },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "read",
    stateMutability: "view",
    inputs: [{ name: "asset", type: "address" }],
    outputs: [
      {
        type: "tuple",
        components: [
          { name: "priceWad", type: "uint256" },
          { name: "confidenceBps", type: "uint256" },
          { name: "updatedAt", type: "uint256" },
          { name: "liquidityWad", type: "uint256" },
          { name: "historySeconds", type: "uint256" },
          { name: "validSources", type: "uint8" },
        ],
      },
    ],
  },
] as const;

export function isOracleDeviationError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /0x0d637948|OracleDeviation/i.test(msg);
}

/** Read both adapters; return true if prices match within 1% (or missing). */
export async function adaptersInSync(baseToken: Address): Promise<{ ok: boolean; prices: number[] }> {
  const prices: number[] = [];
  for (const a of ORACLE_ADAPTERS) {
    try {
      const d = await publicClient.readContract({
        address: a,
        abi: mockOracleAbi,
        functionName: "read",
        args: [baseToken],
      });
      prices.push(Number(d.priceWad) / 1e18);
    } catch {
      prices.push(0);
    }
  }
  const positive = prices.filter((p) => p > 0);
  if (positive.length < 2) return { ok: false, prices };
  const min = Math.min(...positive);
  const max = Math.max(...positive);
  const mid = (min + max) / 2;
  const dev = mid > 0 ? (max - min) / mid : 1;
  return { ok: dev <= 0.01, prices }; // 1% soft check; contract allows ~5% tier default
}

export async function pushIdenticalOraclePrice(
  wallet: WalletClient,
  account: Address,
  baseToken: Address,
  priceUsd: number,
  liqUsd = 5_000_000,
): Promise<void> {
  if (!(priceUsd > 0) || !isAddress(baseToken)) throw new Error("Invalid price/base for oracle push");
  if (!ORACLE_ADAPTERS.length) throw new Error("No oracle adapters configured");
  const block = await publicClient.getBlock();
  const priceStr = priceUsd >= 1 ? priceUsd.toFixed(8) : priceUsd.toFixed(18);
  const data = {
    priceWad: parseUnits(priceStr, 18),
    confidenceBps: 20n,
    updatedAt: block.timestamp,
    liquidityWad: parseUnits(String(Math.max(1_000_000, Math.floor(liqUsd))), 18),
    historySeconds: 2_592_000n,
    validSources: 1,
  } as const;

  // Same payload to every adapter — never leave them diverged
  for (const adapter of ORACLE_ADAPTERS) {
    let lastErr: unknown;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const sim = await publicClient.simulateContract({
          account,
          address: adapter,
          abi: mockOracleAbi,
          functionName: "set",
          args: [baseToken, data],
        });
        const hash = await wallet.writeContract(sim.request);
        const receipt = await publicClient.waitForTransactionReceipt({ hash });
        if (receipt.status !== "success") throw new Error(`Oracle set reverted on ${adapter}`);
        lastErr = undefined;
        break;
      } catch (e) {
        lastErr = e;
        const msg = e instanceof Error ? e.message : String(e);
        if (!/nonce|replacement|underpriced/i.test(msg) || attempt === 4) throw e;
        await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
      }
    }
    if (lastErr) throw lastErr;
  }

  const { ok, prices } = await adaptersInSync(baseToken);
  if (!ok) {
    throw new Error(
      `Oracle adapters still diverged after push (${prices.map((p) => p.toPrecision(4)).join(" vs ")}). Retry.`,
    );
  }
}

export async function pushIdenticalWithInjectedWallet(
  account: Address,
  baseToken: Address,
  priceUsd: number,
  liqUsd?: number,
): Promise<void> {
  if (typeof window === "undefined" || !window.ethereum) throw new Error("Connect wallet first");
  const wallet = createWalletClient({
    account,
    chain: appChain,
    transport: custom(window.ethereum),
  });
  await pushIdenticalOraclePrice(wallet, account, baseToken, priceUsd, liqUsd);
}
