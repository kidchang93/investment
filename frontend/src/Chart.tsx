import { useEffect, useRef, useState } from 'react';
import {
  createChart,
  CrosshairMode,
  LineStyle,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type CandlestickData,
  type HistogramData,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts';
import type { Candle, PriceSign, Trade } from '@invest/shared';

interface LatestPrice {
  price: number;
  change: number;
  changeRate: number;
  sign: PriceSign;
  open: number;
  high: number;
  low: number;
  accVolume: number;
}

interface CrosshairReadout {
  x: number;
  y: number;
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  color: string;
}

export type ChartCommandType = 'fit' | 'zoomIn' | 'zoomOut';

export interface ChartCommand {
  type: ChartCommandType;
  nonce: number;
}

interface ChartProps {
  /** 초기 일봉 배열 (오름차순) */
  candles: Candle[];
  /** 이 차트가 그리는 종목의 최신 실시간 체결 (없을 수 있음) */
  liveTrade?: Trade;
  /** 현재가 라인과 가격 배지를 그릴 최신 가격 */
  latestPrice?: LatestPrice;
  /** 일봉 차트일 때 최신 가격으로 마지막 캔들을 갱신한다. */
  updateLastCandle?: boolean;
  /** 분봉 차트는 시간까지 표시한다. */
  timeVisible?: boolean;
  /** 부모 툴바에서 전달하는 차트 조작 명령 */
  command?: ChartCommand;
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

function volumeColor(close: number, open: number): string {
  return close >= open ? 'rgba(229, 72, 77, 0.32)' : 'rgba(59, 130, 246, 0.32)';
}

function toVolumeData(c: Candle): HistogramData {
  return {
    time: c.time as UTCTimestamp,
    value: c.volume ?? 0,
    color: volumeColor(c.close, c.open),
  };
}

function yyyymmddToTimestamp(date: string): UTCTimestamp | null {
  if (!/^\d{8}$/.test(date)) return null;
  const y = Number(date.slice(0, 4));
  const m = Number(date.slice(4, 6));
  const d = Number(date.slice(6, 8));
  return Math.floor(Date.UTC(y, m - 1, d) / 1000) as UTCTimestamp;
}

function priceColor(sign?: PriceSign): string {
  if (sign === '1' || sign === '2') return '#e5484d';
  if (sign === '4' || sign === '5') return '#3b82f6';
  return '#d1d5db';
}

function formatChartPrice(value: number): string {
  if (!Number.isFinite(value)) return '-';
  return new Intl.NumberFormat('ko-KR', {
    maximumFractionDigits: value >= 1000 ? 0 : 2,
  }).format(value);
}

function formatChartVolume(value: number): string {
  if (!Number.isFinite(value)) return '-';
  if (value >= 100_000_000) return `${(value / 100_000_000).toFixed(1)}억`;
  if (value >= 10_000) return `${Math.floor(value / 10_000).toLocaleString('ko-KR')}만`;
  return value.toLocaleString('ko-KR');
}

function formatChartTime(time: Time): string {
  if (typeof time === 'number') {
    const date = new Date(time * 1000);
    if (time % 86_400 === 0) {
      return new Intl.DateTimeFormat('ko-KR', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        timeZone: 'Asia/Seoul',
      }).format(date);
    }
    return new Intl.DateTimeFormat('ko-KR', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZone: 'Asia/Seoul',
    }).format(date);
  }
  if (typeof time === 'string') return time;
  return `${time.year}.${String(time.month).padStart(2, '0')}.${String(time.day).padStart(2, '0')}`;
}

function zoomVisibleRange(chart: IChartApi, factor: number): void {
  const range = chart.timeScale().getVisibleLogicalRange();
  if (!range) return;

  const center = (range.from + range.to) / 2;
  const width = Math.max(8, (range.to - range.from) * factor);
  chart.timeScale().setVisibleLogicalRange({
    from: center - width / 2,
    to: center + width / 2,
  });
}

/**
 * lightweight-charts 캔들 차트.
 * 일봉 배열로 초기 렌더 후, 실시간 체결이 오면 "오늘 캔들"을 업데이트한다.
 * 실시간 체결에는 당일 시/고/저/현재가가 모두 담겨 있어 그대로 갱신하면 된다.
 */
export function Chart({
  candles,
  liveTrade,
  latestPrice,
  updateLastCandle = true,
  timeVisible = false,
  command,
}: ChartProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const volumeRef = useRef<ISeriesApi<'Histogram'> | null>(null);
  const priceLineRef = useRef<IPriceLine | null>(null);
  // 실시간 갱신 시 "오늘 캔들"의 time을 알아야 한다. 마지막 일봉 time을 기준으로 잡는다.
  const lastTimeRef = useRef<UTCTimestamp | null>(null);
  const [crosshair, setCrosshair] = useState<CrosshairReadout | null>(null);
  const [lastPriceY, setLastPriceY] = useState<number | null>(null);

  // 차트 생성 (마운트 시 1회) + 리사이즈 대응
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const chart = createChart(container, {
      autoSize: true,
      layout: {
        background: { color: '#0b0f17' },
        textColor: '#8f98a8',
        fontFamily:
          "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Apple SD Gothic Neo', 'Noto Sans KR', sans-serif",
      },
      grid: {
        vertLines: { color: 'rgba(148, 163, 184, 0.06)' },
        horzLines: { color: 'rgba(148, 163, 184, 0.08)' },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: 'rgba(226, 232, 240, 0.28)', labelBackgroundColor: '#1f2937' },
        horzLine: { color: 'rgba(226, 232, 240, 0.28)', labelBackgroundColor: '#1f2937' },
      },
      rightPriceScale: {
        borderColor: 'rgba(148, 163, 184, 0.12)',
        scaleMargins: { top: 0.08, bottom: 0.24 },
      },
      timeScale: {
        borderColor: 'rgba(148, 163, 184, 0.12)',
        rightOffset: 8,
        barSpacing: 8,
        timeVisible,
        secondsVisible: false,
      },
      handleScale: {
        axisDoubleClickReset: true,
        axisPressedMouseMove: true,
        mouseWheel: true,
        pinch: true,
      },
      handleScroll: {
        horzTouchDrag: true,
        mouseWheel: true,
        pressedMouseMove: true,
        vertTouchDrag: false,
      },
    });

    const series = chart.addCandlestickSeries({
      upColor: '#e5484d',
      downColor: '#3b82f6',
      borderUpColor: '#e5484d',
      borderDownColor: '#3b82f6',
      wickUpColor: '#e5484d',
      wickDownColor: '#3b82f6',
    });
    const volume = chart.addHistogramSeries({
      priceFormat: { type: 'volume' },
      priceScaleId: '',
    });
    chart.priceScale('').applyOptions({
      scaleMargins: {
        top: 0.82,
        bottom: 0,
      },
    });

    chartRef.current = chart;
    seriesRef.current = series;
    volumeRef.current = volume;

    chart.subscribeCrosshairMove((param) => {
      if (!param.point || !param.time || param.point.x < 0 || param.point.y < 0) {
        setCrosshair(null);
        return;
      }
      if (param.point.x > container.clientWidth || param.point.y > container.clientHeight) {
        setCrosshair(null);
        return;
      }

      const candle = param.seriesData.get(series) as CandlestickData | undefined;
      if (!candle) {
        setCrosshair(null);
        return;
      }

      const volumeData = param.seriesData.get(volume) as HistogramData | undefined;
      const tooltipWidth = 196;
      const tooltipHeight = 156;
      const x = Math.min(param.point.x + 16, Math.max(12, container.clientWidth - tooltipWidth - 12));
      const y = Math.min(param.point.y + 16, Math.max(12, container.clientHeight - tooltipHeight - 12));
      setCrosshair({
        x,
        y,
        date: formatChartTime(param.time),
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        volume: Number(volumeData?.value ?? 0),
        color: candle.close >= candle.open ? '#e5484d' : '#3b82f6',
      });
    });

    return () => {
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
      volumeRef.current = null;
      priceLineRef.current = null;
    };
  }, []);

  useEffect(() => {
    chartRef.current?.timeScale().applyOptions({
      timeVisible,
      secondsVisible: false,
      barSpacing: timeVisible ? 10 : 8,
    });
  }, [timeVisible]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || !command) return;

    if (command.type === 'fit') {
      chart.timeScale().fitContent();
      return;
    }
    zoomVisibleRange(chart, command.type === 'zoomIn' ? 0.72 : 1.35);
  }, [command]);

  // 일봉 데이터 세팅 (종목 전환 시)
  useEffect(() => {
    const series = seriesRef.current;
    const volume = volumeRef.current;
    if (!series) return;
    series.setData(candles.map(toCandlestickData));
    volume?.setData(candles.map(toVolumeData));
    lastTimeRef.current = candles.length ? (candles[candles.length - 1].time as UTCTimestamp) : null;
    chartRef.current?.timeScale().fitContent();
  }, [candles]);

  useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;

    if (priceLineRef.current) {
      series.removePriceLine(priceLineRef.current);
      priceLineRef.current = null;
    }

    if (!latestPrice) {
      setLastPriceY(null);
      return;
    }

    const color = priceColor(latestPrice.sign);
    priceLineRef.current = series.createPriceLine({
      price: latestPrice.price,
      color,
      lineWidth: 1,
      lineStyle: LineStyle.Dashed,
      axisLabelVisible: true,
      title: '현재가',
    });
    setLastPriceY(series.priceToCoordinate(latestPrice.price));
  }, [latestPrice]);

  // 실시간 체결 반영: 마지막 캔들(오늘)의 OHLC 갱신
  useEffect(() => {
    const series = seriesRef.current;
    const volume = volumeRef.current;
    const latest = liveTrade ?? latestPrice;
    const tradeTime = liveTrade ? yyyymmddToTimestamp(liveTrade.date) : lastTimeRef.current;
    const lastTime = lastTimeRef.current;
    if (!updateLastCandle || !series || !latest || tradeTime === null) return;
    if (lastTime !== null && tradeTime < lastTime) return;
    series.update({
      time: tradeTime,
      open: latest.open,
      high: latest.high,
      low: latest.low,
      close: latest.price,
    });
    volume?.update({
      time: tradeTime,
      value: latest.accVolume,
      color: volumeColor(latest.price, latest.open),
    });
    lastTimeRef.current = tradeTime;
  }, [latestPrice, liveTrade, updateLastCandle]);

  return (
    <div className="chart">
      <div ref={containerRef} className="chart__canvas" />
      {latestPrice && lastPriceY !== null && (
        <div
          className="chart__last-price"
          style={{ top: lastPriceY, color: priceColor(latestPrice.sign), borderColor: priceColor(latestPrice.sign) }}
        >
          {formatChartPrice(latestPrice.price)}
        </div>
      )}
      {crosshair && (
        <div
          className="chart__tooltip"
          style={{ left: crosshair.x, top: crosshair.y }}
        >
          <strong>{crosshair.date}</strong>
          <span>시가 <b>{formatChartPrice(crosshair.open)}</b></span>
          <span>고가 <b>{formatChartPrice(crosshair.high)}</b></span>
          <span>저가 <b>{formatChartPrice(crosshair.low)}</b></span>
          <span style={{ color: crosshair.color }}>종가 <b>{formatChartPrice(crosshair.close)}</b></span>
          <span>거래량 <b>{formatChartVolume(crosshair.volume)}</b></span>
        </div>
      )}
    </div>
  );
}
