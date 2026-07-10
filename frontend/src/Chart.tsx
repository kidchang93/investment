import { useEffect, useRef } from 'react';
import {
  createChart,
  CrosshairMode,
  type IChartApi,
  type ISeriesApi,
  type CandlestickData,
  type UTCTimestamp,
} from 'lightweight-charts';
import type { Candle, Trade } from '@invest/shared';

interface ChartProps {
  /** 초기 일봉 배열 (오름차순) */
  candles: Candle[];
  /** 이 차트가 그리는 종목의 최신 실시간 체결 (없을 수 있음) */
  liveTrade?: Trade;
}

function toCandlestickData(c: Candle): CandlestickData {
  return {
    time: c.time as UTCTimestamp,
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
  };
}

function yyyymmddToTimestamp(date: string): UTCTimestamp | null {
  if (!/^\d{8}$/.test(date)) return null;
  const y = Number(date.slice(0, 4));
  const m = Number(date.slice(4, 6));
  const d = Number(date.slice(6, 8));
  return Math.floor(Date.UTC(y, m - 1, d) / 1000) as UTCTimestamp;
}

/**
 * lightweight-charts 캔들 차트.
 * 일봉 배열로 초기 렌더 후, 실시간 체결이 오면 "오늘 캔들"을 업데이트한다.
 * 실시간 체결에는 당일 시/고/저/현재가가 모두 담겨 있어 그대로 갱신하면 된다.
 */
export function Chart({ candles, liveTrade }: ChartProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  // 실시간 갱신 시 "오늘 캔들"의 time을 알아야 한다. 마지막 일봉 time을 기준으로 잡는다.
  const lastTimeRef = useRef<UTCTimestamp | null>(null);

  // 차트 생성 (마운트 시 1회) + 리사이즈 대응
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const chart = createChart(container, {
      autoSize: true,
      layout: {
        background: { color: '#0f1117' },
        textColor: '#c7ccd6',
      },
      grid: {
        vertLines: { color: '#1c1f2a' },
        horzLines: { color: '#1c1f2a' },
      },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: '#2a2e3a' },
      timeScale: { borderColor: '#2a2e3a', timeVisible: false },
    });

    const series = chart.addCandlestickSeries({
      upColor: '#e5484d',
      downColor: '#3b82f6',
      borderUpColor: '#e5484d',
      borderDownColor: '#3b82f6',
      wickUpColor: '#e5484d',
      wickDownColor: '#3b82f6',
    });

    chartRef.current = chart;
    seriesRef.current = series;

    return () => {
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
  }, []);

  // 일봉 데이터 세팅 (종목 전환 시)
  useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;
    series.setData(candles.map(toCandlestickData));
    lastTimeRef.current = candles.length ? (candles[candles.length - 1].time as UTCTimestamp) : null;
    chartRef.current?.timeScale().fitContent();
  }, [candles]);

  // 실시간 체결 반영: 마지막 캔들(오늘)의 OHLC 갱신
  useEffect(() => {
    const series = seriesRef.current;
    const tradeTime = liveTrade ? yyyymmddToTimestamp(liveTrade.date) : null;
    const lastTime = lastTimeRef.current;
    if (!series || !liveTrade || tradeTime === null) return;
    if (lastTime !== null && tradeTime < lastTime) return;
    series.update({
      time: tradeTime,
      open: liveTrade.open,
      high: liveTrade.high,
      low: liveTrade.low,
      close: liveTrade.price,
    });
    lastTimeRef.current = tradeTime;
  }, [liveTrade]);

  return <div ref={containerRef} className="chart" />;
}
