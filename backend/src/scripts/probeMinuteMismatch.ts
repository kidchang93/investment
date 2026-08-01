/**
 * 분봉 재구성이 일봉 고저와 어긋나는 날을 찾아 **어느 쪽이 넓은지** 본다.
 *
 * ── 왜 ────────────────────────────────────────────────────────────────────
 *
 * `collectMinuteCandles.ts`는 이어 붙인 분봉의 고가·저가가 일봉과 정확히 맞을
 * 때만 그 종목·날을 쓴다. 2026-08-01 측정에서 300건 중 **42건이 불일치로
 * 버려졌고 전부 ETF였다**(일반주 0건). 버리는 판정 자체는 옳게 동작하지만
 * 원인을 모르면 ETF가 표본에서 계속 빠진다.
 *
 * ── 무엇을 가르나 ────────────────────────────────────────────────────────
 *
 * 어긋나는 방향이 원인을 좁힌다.
 *
 *   재구성이 **좁다** → 분봉에 안 잡히는 체결이 있다 (시간외·단일가·LP 호가 등)
 *   재구성이 **넓다** → 일봉 쪽이 좁다 (수정주가 등 다른 기준)
 *
 * 어느 쪽인지, 그리고 차이가 몇 호가인지까지 봐야 다음 물음이 정해진다.
 * **여기서 원인을 단정하지 않는다** — 방향과 크기만 잰다.
 *
 * **주문은 내지 않는다.** 조회만 한다.
 *
 *   npx tsx src/scripts/probeMinuteMismatch.ts 0000D0 0000H0 [거래일수]
 */

import { getInstrument } from '../db/instruments.js';
import { MINUTE_CALLS_PER_DAY, getDailyCandles, getDomesticDayMinuteCandles } from '../kis/rest.js';
import { KRX_SESSION_MINUTES } from '@invest/shared';
import { candleToMinuteBar, spreadEvenly } from '../trading/rangeExpansion.js';

const DAILY_HISTORY_DAYS = 55;

function kstDateOf(time: number): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' })
    .format(new Date(time * 1000))
    .replace(/-/g, '');
}

function pct(part: number, whole: number): string {
  return whole > 0 ? `${((part / whole) * 100).toFixed(2)}%` : '—';
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dayCount = Number(args[args.length - 1]) > 0 ? Number(args.pop()) : 8;
  const symbols = args;
  if (symbols.length === 0) {
    console.log('종목코드를 넘기세요. 예: npx tsx src/scripts/probeMinuteMismatch.ts 0000D0 000020 8');
    return;
  }

  const calendar = await getDailyCandles('005930', DAILY_HISTORY_DAYS);
  const today = kstDateOf(Math.floor(Date.now() / 1000));
  const dates = spreadEvenly(
    calendar.candles.map((candle) => kstDateOf(candle.time)).filter((date) => date < today),
    dayCount,
  );

  console.log(`거래일 ${dates.length}일 (${dates[0]}~${dates[dates.length - 1]})`);
  console.log(`종목당 KIS ${dates.length * MINUTE_CALLS_PER_DAY + 1}회\n`);

  for (const symbol of symbols) {
    const instrument = await getInstrument(`KR:KOSPI:${symbol}`) ?? await getInstrument(`KR:KOSDAQ:${symbol}`);
    if (!instrument) {
      console.log(`${symbol}: 종목을 찾지 못했습니다.\n`);
      continue;
    }
    const daily = await getDailyCandles(symbol, DAILY_HISTORY_DAYS).catch(() => null);
    const dailyByDate = new Map((daily?.candles ?? []).map((candle) => [kstDateOf(candle.time), candle]));

    console.log(`${symbol} ${instrument.name} (${instrument.assetType})`);
    let match = 0;
    let narrower = 0;
    let wider = 0;

    for (const date of dates) {
      const dayCandle = dailyByDate.get(date);
      if (!dayCandle) {
        console.log(`  ${date}  일봉 없음`);
        continue;
      }
      const candles = await getDomesticDayMinuteCandles(instrument, date);
      if (candles.length === 0) {
        console.log(`  ${date}  분봉 없음`);
        continue;
      }
      const high = Math.max(...candles.map((candle) => candle.high));
      const low = Math.min(...candles.map((candle) => candle.low));

      if (high === dayCandle.high && low === dayCandle.low) {
        match += 1;
        console.log(`  ${date}  일치 (${candles.length}봉)`);
        continue;
      }

      /*
       * 어느 쪽이 넓은지. 고가가 낮거나 저가가 높으면 재구성이 좁은 것이다 —
       * 분봉이 못 본 체결이 있다는 뜻이다.
       */
      const reconNarrower = high <= dayCandle.high && low >= dayCandle.low;
      if (reconNarrower) narrower += 1;
      else wider += 1;

      const bars = candles.map(candleToMinuteBar);
      const outside = bars.filter(
        (bar) => bar.minute < KRX_SESSION_MINUTES.open || bar.minute > KRX_SESSION_MINUTES.close,
      ).length;

      console.log(
        `  ${date}  ${reconNarrower ? '재구성이 좁다' : '재구성이 넓다'} (${candles.length}봉`
        + (outside > 0 ? `, 정규장 밖 ${outside}봉` : '')
        + `)\n`
        + `           고가 일봉 ${dayCandle.high} · 재구성 ${high}`
        + ` (차이 ${pct(Math.abs(dayCandle.high - high), dayCandle.high)})\n`
        + `           저가 일봉 ${dayCandle.low} · 재구성 ${low}`
        + ` (차이 ${pct(Math.abs(dayCandle.low - low), dayCandle.low)})`,
      );
    }

    console.log(`  → 일치 ${match} · 재구성이 좁음 ${narrower} · 재구성이 넓음 ${wider}\n`);
  }

  console.log('재구성이 좁으면 분봉에 안 잡히는 체결이 있다는 뜻이고, 넓으면 일봉 쪽 기준이 다르다는 뜻이다.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
