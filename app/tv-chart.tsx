"use client";

import { useEffect, useRef, useState } from "react";
import { fetchRobinhoodDex, syntheticMainnetCandles, type DexRhQuote } from "./rh-catalog";

export type Candle = {
  time: number; // unix seconds
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
};

type Interval = "1m" | "5m" | "15m" | "1h";

const INTERVAL_SEC: Record<Interval, number> = {
  "1m": 60,
  "5m": 300,
  "15m": 900,
  "1h": 3600,
};

async function fetchBinanceKlines(symbol: string, interval: Interval, limit = 120): Promise<Candle[]> {
  const map: Record<Interval, string> = { "1m": "1m", "5m": "5m", "15m": "15m", "1h": "1h" };
  const url = `https://api.binance.com/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=${map[interval]}&limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Binance ${res.status}`);
  const raw = (await res.json()) as Array<[number, string, string, string, string, string]>;
  return raw.map((k) => ({
    time: Math.floor(k[0] / 1000),
    open: Number(k[1]),
    high: Number(k[2]),
    low: Number(k[3]),
    close: Number(k[4]),
    volume: Number(k[5]),
  }));
}

/** Infer Binance pair from mark band or explicit symbol */
function resolveChartPair(chartSymbol?: string, markPrice?: number): string | null {
  if (chartSymbol && /^[A-Z0-9]+USDT$/i.test(chartSymbol)) return chartSymbol.toUpperCase();
  if (chartSymbol && /^(BTC|ETH|SOL)$/i.test(chartSymbol)) return `${chartSymbol.toUpperCase()}USDT`;
  if (markPrice == null || !(markPrice > 0)) return null;
  if (markPrice > 20_000) return "BTCUSDT";
  if (markPrice > 200 && markPrice < 20_000) return "ETHUSDT";
  if (markPrice > 20 && markPrice < 200) return "SOLUSDT";
  return null;
}

/** Build OHLC candles from sparse on-chain index ticks. */
function candlesFromTicks(ticks: { t: number; p: number }[], intervalSec: number): Candle[] {
  if (!ticks.length) return [];
  const buckets = new Map<number, Candle>();
  for (const { t, p } of ticks) {
    const bucket = Math.floor(t / intervalSec) * intervalSec;
    const prev = buckets.get(bucket);
    if (!prev) {
      buckets.set(bucket, { time: bucket, open: p, high: p, low: p, close: p });
    } else {
      prev.high = Math.max(prev.high, p);
      prev.low = Math.min(prev.low, p);
      prev.close = p;
    }
  }
  return [...buckets.values()].sort((a, b) => a.time - b.time);
}

function seedSyntheticCandles(mark: number, intervalSec: number, count = 80): Candle[] {
  const now = Math.floor(Date.now() / 1000);
  const start = now - count * intervalSec;
  let price = mark * (1 - 0.004);
  const out: Candle[] = [];
  for (let i = 0; i < count; i++) {
    const t = start + i * intervalSec;
    const drift = (mark - price) * 0.08;
    const noise = mark * (Math.sin(i * 0.7) * 0.0008 + Math.cos(i * 0.31) * 0.0005);
    const open = price;
    const close = Math.max(mark * 0.98, price + drift + noise);
    const high = Math.max(open, close) * (1 + 0.0006);
    const low = Math.min(open, close) * (1 - 0.0006);
    out.push({ time: t, open, high, low, close });
    price = close;
  }
  const last = out[out.length - 1];
  last.close = mark;
  last.high = Math.max(last.high, mark);
  last.low = Math.min(last.low, mark);
  return out;
}

function formatChartPrice(n: number, isMc: boolean): string {
  if (isMc) {
    if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
    if (n >= 1_000) return `$${(n / 1_000).toFixed(2)}K`;
    return `$${n.toFixed(0)}`;
  }
  if (n < 0.0001) return `$${n.toPrecision(4)}`;
  if (n < 1) return `$${n.toFixed(6)}`;
  return `$${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

type Props = {
  /** Live on-chain mark price (token USD) */
  markPrice?: number;
  title?: string;
  chartSymbol?: string;
  /** RH / community: use mainnet Dex windows for shape */
  dexMode?: boolean;
  /** Mainnet token CA for live DexScreener OHLC rebuild (GMGN-like) */
  sourceCa?: string;
  /** @deprecated */
  dexChange24h?: number | null;
  preferBtcHistory?: boolean;
};

export function TvCandleChart({
  markPrice,
  title = "Index",
  chartSymbol,
  preferBtcHistory,
  dexMode,
  sourceCa,
  dexChange24h,
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<import("lightweight-charts").IChartApi | null>(null);
  const seriesRef = useRef<import("lightweight-charts").ISeriesApi<"Candlestick"> | null>(null);
  const [interval, setIntervalKey] = useState<Interval>("1h");
  const [status, setStatus] = useState("Loading chart…");
  const [mode, setMode] = useState<"hist" | "dex" | "live" | "seed">("seed");
  /** GMGN default is Market Cap for memes */
  const [unit, setUnit] = useState<"price" | "mc">("mc");
  const [dexQuote, setDexQuote] = useState<DexRhQuote | null>(null);
  const ticksRef = useRef<{ t: number; p: number }[]>([]);
  const lastCandleRef = useRef<Candle | null>(null);
  const unitScaleRef = useRef(1);
  const pair = resolveChartPair(chartSymbol, markPrice);

  // Create chart once
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    let disposed = false;
    let chart: import("lightweight-charts").IChartApi | null = null;

    void (async () => {
      const lc = await import("lightweight-charts");
      if (disposed || !containerRef.current) return;
      const initialH = Math.max(280, Math.round(containerRef.current.clientHeight || 380));
      chart = lc.createChart(containerRef.current, {
        autoSize: true,
        height: initialH,
        layout: {
          background: { type: lc.ColorType.Solid, color: "#0b1220" },
          textColor: "#9aa4b2",
          fontFamily: "ui-sans-serif, system-ui, sans-serif",
        },
        grid: {
          vertLines: { color: "rgba(148,163,184,0.12)" },
          horzLines: { color: "rgba(148,163,184,0.12)" },
        },
        crosshair: {
          mode: lc.CrosshairMode.Normal,
          vertLine: { color: "rgba(148,163,184,0.4)", labelBackgroundColor: "#1e293b" },
          horzLine: { color: "rgba(148,163,184,0.4)", labelBackgroundColor: "#1e293b" },
        },
        rightPriceScale: {
          borderColor: "rgba(148,163,184,0.2)",
          scaleMargins: { top: 0.08, bottom: 0.08 },
        },
        timeScale: {
          borderColor: "rgba(148,163,184,0.2)",
          timeVisible: true,
          secondsVisible: false,
        },
      });
      const series = chart.addSeries(lc.CandlestickSeries, {
        upColor: "#22c55e",
        downColor: "#ef4444",
        borderUpColor: "#22c55e",
        borderDownColor: "#ef4444",
        wickUpColor: "#22c55e",
        wickDownColor: "#ef4444",
      });
      chartRef.current = chart;
      seriesRef.current = series;
    })();

    return () => {
      disposed = true;
      chart?.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
  }, []);

  // Poll mainnet Dex quote for RH tokens (shape + MC)
  useEffect(() => {
    if (!dexMode || !sourceCa) return;
    let cancelled = false;
    const pull = async () => {
      try {
        const q = await fetchRobinhoodDex(sourceCa);
        if (!cancelled && q) setDexQuote(q);
      } catch {
        /* ignore */
      }
    };
    void pull();
    // Fast poll so chart tracks GMGN/mainnet pumps without waiting for on-chain oracle
    const id = window.setInterval(() => void pull(), 5_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [dexMode, sourceCa]);

  // Load / rebuild candles
  useEffect(() => {
    const series = seriesRef.current;
    // Dex markets: prefer live mainnet Dex price for chart (matches GMGN), not stale on-chain mark
    const livePrice =
      dexMode && dexQuote?.priceUsd && dexQuote.priceUsd > 0
        ? dexQuote.priceUsd
        : markPrice && markPrice > 0
          ? markPrice
          : dexQuote?.priceUsd;
    if (!series || !(livePrice && livePrice > 0)) return;
    let cancelled = false;
    const histPair = resolveChartPair(chartSymbol, livePrice);

    void (async () => {
      if (dexMode) {
        const px = livePrice;
        const mc = dexQuote?.marketCap ?? dexQuote?.fdv ?? null;
        // GMGN charts market cap by default when MC available
        const useMc = unit === "mc" && mc != null && mc > 0 && px > 0;
        const unitScale = useMc ? mc / px : 1;
        unitScaleRef.current = unitScale;
        const windows = dexQuote?.priceChange ?? { h24: dexChange24h };
        const candles = syntheticMainnetCandles(
          px,
          dexQuote?.priceChange24h ?? dexChange24h,
          INTERVAL_SEC[interval],
          interval === "1h" ? 72 : interval === "15m" ? 96 : 120,
          windows,
          unitScale,
        );
        if (cancelled) return;
        series.setData(
          candles.map((c) => ({
            time: c.time as import("lightweight-charts").UTCTimestamp,
            open: c.open,
            high: c.high,
            low: c.low,
            close: c.close,
          })),
        );
        lastCandleRef.current = candles[candles.length - 1] ?? null;
        chartRef.current?.timeScale().fitContent();
        setMode("dex");
        const ch24 = dexQuote?.priceChange24h ?? dexChange24h;
        setStatus(
          useMc
            ? `Mainnet MC chart · DexScreener · 24h ${ch24 != null ? `${ch24 >= 0 ? "+" : ""}${ch24.toFixed(1)}%` : "—"}`
            : `Mainnet price · DexScreener · last = live mark`,
        );
        return;
      }

      try {
        if (histPair) {
          setStatus(`Loading ${histPair} candles…`);
          const candles = await fetchBinanceKlines(histPair, interval, 150);
          if (cancelled) return;
          if (candles.length) {
            const last = candles[candles.length - 1];
            last.close = livePrice;
            last.high = Math.max(last.high, livePrice);
            last.low = Math.min(last.low, livePrice);
          }
          series.setData(
            candles.map((c) => ({
              time: c.time as import("lightweight-charts").UTCTimestamp,
              open: c.open,
              high: c.high,
              low: c.low,
              close: c.close,
            })),
          );
          lastCandleRef.current = candles[candles.length - 1] ?? null;
          chartRef.current?.timeScale().fitContent();
          setMode("hist");
          unitScaleRef.current = 1;
          setStatus(`TradingView candles · ${histPair} · last = on-chain mark`);
          return;
        }
      } catch {
        /* fall through */
      }

      const fromTicks = candlesFromTicks(ticksRef.current, INTERVAL_SEC[interval]);
      const candles = fromTicks.length >= 3 ? fromTicks : seedSyntheticCandles(livePrice, INTERVAL_SEC[interval]);
      if (cancelled) return;
      series.setData(
        candles.map((c) => ({
          time: c.time as import("lightweight-charts").UTCTimestamp,
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
        })),
      );
      lastCandleRef.current = candles[candles.length - 1] ?? null;
      chartRef.current?.timeScale().fitContent();
      unitScaleRef.current = 1;
      setMode(fromTicks.length >= 3 ? "live" : "seed");
      setStatus(fromTicks.length >= 3 ? "Candles from on-chain samples" : "Candles warming up · live mark");
    })();

    return () => {
      cancelled = true;
    };
  }, [interval, chartSymbol, dexMode, unit, dexQuote, markPrice, dexChange24h, sourceCa]);

  // Live tick → update last candle
  useEffect(() => {
    const livePrice =
      dexMode && dexQuote?.priceUsd && dexQuote.priceUsd > 0
        ? dexQuote.priceUsd
        : markPrice && markPrice > 0
          ? markPrice
          : dexQuote?.priceUsd;
    if (!(livePrice && livePrice > 0) || !seriesRef.current) return;
    const scaled = livePrice * (unitScaleRef.current || 1);
    const now = Math.floor(Date.now() / 1000);
    ticksRef.current = [...ticksRef.current, { t: now, p: scaled }].slice(-500);
    const intervalSec = INTERVAL_SEC[interval];
    const bucket = Math.floor(now / intervalSec) * intervalSec;
    const prev = lastCandleRef.current;
    let candle: Candle;
    if (prev && prev.time === bucket) {
      candle = {
        time: bucket,
        open: prev.open,
        high: Math.max(prev.high, scaled),
        low: Math.min(prev.low, scaled),
        close: scaled,
      };
    } else {
      candle = {
        time: bucket,
        open: prev?.close ?? scaled,
        high: Math.max(prev?.close ?? scaled, scaled),
        low: Math.min(prev?.close ?? scaled, scaled),
        close: scaled,
      };
    }
    lastCandleRef.current = candle;
    try {
      seriesRef.current.update({
        time: candle.time as import("lightweight-charts").UTCTimestamp,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
      });
    } catch {
      /* chart not ready */
    }
  }, [markPrice, dexQuote?.priceUsd, interval, unit, dexMode]);

  // Footer: always show freshest mainnet figure for RH tokens
  const displayLive =
    unit === "mc" && dexQuote?.marketCap
      ? dexQuote.marketCap
      : dexMode && dexQuote?.priceUsd
        ? dexQuote.priceUsd
        : markPrice && markPrice > 0
          ? markPrice
          : dexQuote?.priceUsd;

  return (
    <div className="tv-chart-wrap">
      <div className="tv-chart-toolbar">
        <div className="tv-chart-title">
          <strong>{title}</strong>
          <span>{status}</span>
        </div>
        <div className="tv-intervals">
          {dexMode && (
            <>
              <button
                type="button"
                className={unit === "mc" ? "tv-iv active" : "tv-iv"}
                onClick={() => setUnit("mc")}
                title="Market cap (GMGN-style)"
              >
                MC
              </button>
              <button
                type="button"
                className={unit === "price" ? "tv-iv active" : "tv-iv"}
                onClick={() => setUnit("price")}
                title="Token price USD"
              >
                Price
              </button>
              <span className="tv-iv-sep" />
            </>
          )}
          {(["1m", "5m", "15m", "1h"] as Interval[]).map((k) => (
            <button
              key={k}
              type="button"
              className={interval === k ? "tv-iv active" : "tv-iv"}
              onClick={() => setIntervalKey(k)}
            >
              {k}
            </button>
          ))}
        </div>
      </div>
      <div ref={containerRef} className="tv-chart-canvas" />
      <div className="tv-chart-footer">
        <span>
          {mode === "hist"
            ? `${pair ?? chartSymbol ?? "History"} (Binance) + live mark`
            : mode === "dex"
              ? `DexScreener mainnet · ${unit === "mc" ? "Market Cap" : "Price"} (GMGN-like)`
              : mode === "live"
                ? "On-chain candles"
                : "Warming up"}
          {dexQuote?.url ? (
            <>
              {" · "}
              <a href={dexQuote.url} target="_blank" rel="noreferrer" style={{ color: "var(--green)" }}>
                Dex ↗
              </a>
            </>
          ) : null}
        </span>
        {displayLive != null && displayLive > 0 && (
          <strong>
            {unit === "mc" && dexQuote?.marketCap ? "MC " : "Mark "}
            {formatChartPrice(displayLive, unit === "mc" && !!dexQuote?.marketCap)}
            {dexQuote?.priceChange24h != null && (
              <span style={{ marginLeft: 8, color: dexQuote.priceChange24h >= 0 ? "#22c55e" : "#ef4444", fontSize: 12 }}>
                {dexQuote.priceChange24h >= 0 ? "+" : ""}
                {dexQuote.priceChange24h.toFixed(2)}%
              </span>
            )}
          </strong>
        )}
      </div>
    </div>
  );
}
