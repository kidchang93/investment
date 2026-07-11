import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  createChart,
  CrosshairMode,
  LineStyle,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type CandlestickData,
  type HistogramData,
  type LineData,
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

export interface ChartReadout {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  color: string;
}

interface CrosshairReadout extends ChartReadout {
  x: number;
  y: number;
}

interface RsiPoint {
  x: number;
  y: number;
  value: number;
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
  /** 전일종가 기준선 */
  previousClose?: number;
  /** 일봉 차트일 때 최신 가격으로 마지막 캔들을 갱신한다. */
  updateLastCandle?: boolean;
  /** 분봉 차트는 시간까지 표시한다. */
  timeVisible?: boolean;
  /** 부모 툴바에서 전달하는 차트 조작 명령 */
  command?: ChartCommand;
  /** 이동평균선 표시 여부 */
  showMovingAverage?: boolean;
  /** RSI 보조지표 표시 여부 */
  showRsi?: boolean;
  /** 당일 시가/고가/저가 기준선 표시 여부 */
  showPriceLevels?: boolean;
  /** crosshair가 가리키는 캔들의 readout 값 */
  onReadoutChange?: (readout: ChartReadout | null) => void;
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

function toMovingAverageData(candles: Candle[], period: number): LineData[] {
  const data: LineData[] = [];
  let sum = 0;

  for (let i = 0; i < candles.length; i += 1) {
    sum += candles[i].close;
    if (i >= period) sum -= candles[i - period].close;
    if (i < period - 1) continue;
    data.push({
      time: candles[i].time as UTCTimestamp,
      value: sum / period,
    });
  }

  return data;
}

function calculateRsiPoints(candles: Candle[], period = 14): RsiPoint[] {
  if (candles.length <= period) return [];

  const values: number[] = [];
  let gains = 0;
  let losses = 0;

  for (let i = 1; i <= period; i += 1) {
    const diff = candles[i].close - candles[i - 1].close;
    if (diff >= 0) gains += diff;
    else losses += Math.abs(diff);
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;
  values.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss));

  for (let i = period + 1; i < candles.length; i += 1) {
    const diff = candles[i].close - candles[i - 1].close;
    avgGain = (avgGain * (period - 1) + Math.max(diff, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-diff, 0)) / period;
    values.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss));
  }

  return values.map((value, index) => ({
    x: values.length === 1 ? 100 : (index / (values.length - 1)) * 100,
    y: 100 - value,
    value,
  }));
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

function formatSignedChartPrice(value: number): string {
  if (!Number.isFinite(value)) return '-';
  return `${value > 0 ? '+' : ''}${formatChartPrice(value)}`;
}

function formatChartRate(value: number): string {
  if (!Number.isFinite(value)) return '-';
  return `${value > 0 ? '+' : ''}${value.toFixed(2)}%`;
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
  previousClose,
  updateLastCandle = true,
  timeVisible = false,
  command,
  showMovingAverage = false,
  showRsi = false,
  showPriceLevels = false,
  onReadoutChange,
}: ChartProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const volumeRef = useRef<ISeriesApi<'Histogram'> | null>(null);
  const ma5Ref = useRef<ISeriesApi<'Line'> | null>(null);
  const ma20Ref = useRef<ISeriesApi<'Line'> | null>(null);
  const priceLineRef = useRef<IPriceLine | null>(null);
  const priceLevelLinesRef = useRef<IPriceLine[]>([]);
  const onReadoutChangeRef = useRef(onReadoutChange);
  const latestPriceRef = useRef(latestPrice);
  const lastPriceRafRef = useRef<number | null>(null);
  // 실시간 갱신 시 "오늘 캔들"의 time을 알아야 한다. 마지막 일봉 time을 기준으로 잡는다.
  const lastTimeRef = useRef<UTCTimestamp | null>(null);
  const [crosshair, setCrosshair] = useState<CrosshairReadout | null>(null);
  const [lastPriceY, setLastPriceY] = useState<number | null>(null);
  const rsiPoints = useMemo(() => calculateRsiPoints(candles), [candles]);
  const rsiPath = rsiPoints.map((point) => `${point.x.toFixed(2)},${point.y.toFixed(2)}`).join(' ');
  const latestRsi = rsiPoints.at(-1)?.value;
  const rsiState =
    latestRsi === undefined
      ? undefined
      : latestRsi >= 70
        ? { tone: 'hot', label: '과매수' }
        : latestRsi <= 30
          ? { tone: 'cold', label: '과매도' }
          : { tone: 'neutral', label: '중립' };
  latestPriceRef.current = latestPrice;

  const refreshLastPriceY = useCallback((): void => {
    const series = seriesRef.current;
    const latest = latestPriceRef.current;
    setLastPriceY(series && latest ? series.priceToCoordinate(latest.price) : null);
  }, []);

  const scheduleLastPriceYRefresh = useCallback((): void => {
    if (lastPriceRafRef.current !== null) return;
    lastPriceRafRef.current = window.requestAnimationFrame(() => {
      lastPriceRafRef.current = null;
      refreshLastPriceY();
    });
  }, [refreshLastPriceY]);

  useEffect(() => {
    onReadoutChangeRef.current = onReadoutChange;
  }, [onReadoutChange]);

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
    const ma5 = chart.addLineSeries({
      color: '#f5c451',
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: false,
      title: 'MA5',
    });
    const ma20 = chart.addLineSeries({
      color: '#22c55e',
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: false,
      title: 'MA20',
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
    ma5Ref.current = ma5;
    ma20Ref.current = ma20;

    chart.subscribeCrosshairMove((param) => {
      if (!param.point || !param.time || param.point.x < 0 || param.point.y < 0) {
        setCrosshair(null);
        onReadoutChangeRef.current?.(null);
        return;
      }
      if (param.point.x > container.clientWidth || param.point.y > container.clientHeight) {
        setCrosshair(null);
        onReadoutChangeRef.current?.(null);
        return;
      }

      const candle = param.seriesData.get(series) as CandlestickData | undefined;
      if (!candle) {
        setCrosshair(null);
        onReadoutChangeRef.current?.(null);
        return;
      }

      const volumeData = param.seriesData.get(volume) as HistogramData | undefined;
      const tooltipWidth = 196;
      const tooltipHeight = 190;
      const x = Math.min(param.point.x + 16, Math.max(12, container.clientWidth - tooltipWidth - 12));
      const y = Math.min(param.point.y + 16, Math.max(12, container.clientHeight - tooltipHeight - 12));
      const readout = {
        date: formatChartTime(param.time),
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        volume: Number(volumeData?.value ?? 0),
        color: candle.close >= candle.open ? '#e5484d' : '#3b82f6',
      };
      setCrosshair({
        x,
        y,
        ...readout,
      });
      onReadoutChangeRef.current?.(readout);
    });
    chart.timeScale().subscribeVisibleLogicalRangeChange(scheduleLastPriceYRefresh);
    window.addEventListener('resize', scheduleLastPriceYRefresh);

    return () => {
      onReadoutChangeRef.current?.(null);
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(scheduleLastPriceYRefresh);
      window.removeEventListener('resize', scheduleLastPriceYRefresh);
      if (lastPriceRafRef.current !== null) {
        window.cancelAnimationFrame(lastPriceRafRef.current);
        lastPriceRafRef.current = null;
      }
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
      volumeRef.current = null;
      ma5Ref.current = null;
      ma20Ref.current = null;
      priceLineRef.current = null;
      priceLevelLinesRef.current = [];
    };
  }, [scheduleLastPriceYRefresh]);

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
      scheduleLastPriceYRefresh();
      return;
    }
    zoomVisibleRange(chart, command.type === 'zoomIn' ? 0.72 : 1.35);
    scheduleLastPriceYRefresh();
  }, [command, scheduleLastPriceYRefresh]);

  // 일봉 데이터 세팅 (종목 전환 시)
  useEffect(() => {
    const series = seriesRef.current;
    const volume = volumeRef.current;
    if (!series) return;
    series.setData(candles.map(toCandlestickData));
    volume?.setData(candles.map(toVolumeData));
    ma5Ref.current?.setData(showMovingAverage ? toMovingAverageData(candles, 5) : []);
    ma20Ref.current?.setData(showMovingAverage ? toMovingAverageData(candles, 20) : []);
    lastTimeRef.current = candles.length ? (candles[candles.length - 1].time as UTCTimestamp) : null;
    chartRef.current?.timeScale().fitContent();
    scheduleLastPriceYRefresh();
  }, [candles, scheduleLastPriceYRefresh, showMovingAverage]);

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
    scheduleLastPriceYRefresh();
  }, [latestPrice, scheduleLastPriceYRefresh]);

  useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;

    for (const line of priceLevelLinesRef.current) {
      series.removePriceLine(line);
    }
    priceLevelLinesRef.current = [];

    if (!latestPrice || !showPriceLevels) return;

    priceLevelLinesRef.current = [
      ...(Number.isFinite(previousClose)
        ? [
            series.createPriceLine({
              price: previousClose as number,
              color: 'rgba(148, 163, 184, 0.68)',
              lineWidth: 1,
              lineStyle: LineStyle.Dashed,
              axisLabelVisible: true,
              title: '전일',
            }),
          ]
        : []),
      series.createPriceLine({
        price: latestPrice.high,
        color: 'rgba(229, 72, 77, 0.72)',
        lineWidth: 1,
        lineStyle: LineStyle.Dotted,
        axisLabelVisible: true,
        title: '고가',
      }),
      series.createPriceLine({
        price: latestPrice.open,
        color: 'rgba(245, 196, 81, 0.72)',
        lineWidth: 1,
        lineStyle: LineStyle.Dotted,
        axisLabelVisible: true,
        title: '시가',
      }),
      series.createPriceLine({
        price: latestPrice.low,
        color: 'rgba(59, 130, 246, 0.72)',
        lineWidth: 1,
        lineStyle: LineStyle.Dotted,
        axisLabelVisible: true,
        title: '저가',
      }),
    ];
  }, [latestPrice, previousClose, showPriceLevels]);

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
    scheduleLastPriceYRefresh();
  }, [latestPrice, liveTrade, scheduleLastPriceYRefresh, updateLastCandle]);

  const crosshairStats = crosshair
    ? {
        change: crosshair.close - crosshair.open,
        changeRate: crosshair.open !== 0 ? ((crosshair.close - crosshair.open) / crosshair.open) * 100 : 0,
        range: crosshair.high - crosshair.low,
        rangeRate: crosshair.low !== 0 ? ((crosshair.high - crosshair.low) / crosshair.low) * 100 : 0,
      }
    : null;

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
          {crosshairStats && (
            <>
              <span style={{ color: crosshair.color }}>
                변동{' '}
                <b>
                  {formatSignedChartPrice(crosshairStats.change)} ({formatChartRate(crosshairStats.changeRate)})
                </b>
              </span>
              <span>
                폭 <b>{formatChartPrice(crosshairStats.range)} ({formatChartRate(crosshairStats.rangeRate)})</b>
              </span>
            </>
          )}
        </div>
      )}
      {showRsi && rsiPoints.length > 0 && (
        <div className="chart__rsi">
          <div className="chart__rsi-header">
            <strong>RSI 14</strong>
            <span>
              {rsiState && <em data-tone={rsiState.tone}>{rsiState.label}</em>}
              {latestRsi?.toFixed(1)}
            </span>
          </div>
          <svg aria-hidden="true" preserveAspectRatio="none" viewBox="0 0 100 100">
            <line className="chart__rsi-band" x1="0" x2="100" y1="30" y2="30" />
            <line className="chart__rsi-band" x1="0" x2="100" y1="70" y2="70" />
            <polyline className="chart__rsi-line" points={rsiPath} />
          </svg>
        </div>
      )}
    </div>
  );
}
