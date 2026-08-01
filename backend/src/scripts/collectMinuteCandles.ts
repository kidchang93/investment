/**
 * 분봉 축 측정의 **원자료를 받아 둔다.** 해석은 하지 않는다.
 *
 * ── 왜 받는 것과 재는 것을 가르나 ────────────────────────────────────────
 *
 * 종목·하루당 KIS 5회다(`MINUTE_CALLS_PER_DAY`). 20종목 × 15거래일이면 1,500회,
 * 약 9분이다. 전략을 바꾸거나 비용 가정을 손볼 때마다 다시 받을 수 없다.
 * `measureRangeExpansion` → `analyzeRangeExpansion`이 같은 이유로 갈라져 있다.
 *
 * 받은 것은 JSONL로 남고 `measureStrategiesIntraday.ts`가 그것만 읽는다.
 *
 * ── 왜 이 원자료가 필요한가 ──────────────────────────────────────────────
 *
 * 화면의 전략 판정문은 **일봉**으로 잰 것인데 자동매매 러너는 **1분봉**으로 돈다.
 * 2026-07-31에 그 차이를 쟀지만 스크래치패드 도구로 잰 것이라 다시 잴 수 없었고,
 * 그동안 분봉 축 숫자는 갱신되지 않았다. 이 스크립트가 그 자리를 메운다.
 *
 * ── 무엇을 믿을 수 있게 만드나 ───────────────────────────────────────────
 *
 * 1. **일봉 고가·저가와 대조한다.** 창 다섯 개 중 하나라도 빠지면 하루 고저가
 *    달라지므로 봉 수를 세는 것보다 엄한 검사다. 안 맞으면 그 종목·날짜는 버린다.
 *    일봉이 없어 검산을 못 하는 날도 버린다 — 맞다고 치지 않는다.
 * 2. **그 날짜 봉만 남긴다.** 그 날짜에 봉이 없으면 KIS가 이전 거래일 것을 조용히
 *    준다(`getDomesticDayMinuteCandles`가 거른다).
 * 3. **버린 것을 센다.** 파일 끝의 `summary` 줄에 남는다 — 몇 건을 왜 버렸는지
 *    모르면 남은 표본이 무엇을 대표하는지 알 수 없다.
 *
 * **주문은 내지 않는다.** 조회만 한다.
 *
 *   npx tsx src/scripts/collectMinuteCandles.ts [종목수] [거래일수] [spread|contiguous]
 *   MINUTE_OUT=/tmp/minute-candles.jsonl npx tsx src/scripts/collectMinuteCandles.ts 20 15
 */

import { appendFileSync, existsSync, unlinkSync } from 'node:fs';

import type { Candle, Instrument } from '@invest/shared';

import { getCategoryInstruments } from '../db/instruments.js';
import { MINUTE_CALLS_PER_DAY, getDailyCandles, getDomesticDayMinuteCandles } from '../kis/rest.js';
import { spreadEvenly } from '../trading/rangeExpansion.js';

const OUT = process.env.MINUTE_OUT ?? '/tmp/minute-candles.jsonl';

/** 창 사이 간격. KIS 초당 한도를 태우지 않는다 — 백엔드도 같은 앱키를 쓴다. */
const CALL_GAP_MS = 220;

/**
 * 일봉을 몇 거래일치 받아 둘까.
 *
 * KIS 일봉은 한 번에 100건이 상한이고 `getDailyCandles`가 달력일을 `days × 1.7`로
 * 잡는다. 55면 약 94달력일 ≒ 64거래일이라 상한 안이다. 여기서 얻은 날짜가 곧
 * 표본의 시간 폭이고, **검산용 일봉이기도 하다.**
 */
const DAILY_HISTORY_DAYS = 55;

const SOURCE_CATEGORIES = ['kr-all', 'kr-etf'];

/** 한 종목·하루치 분봉. 파일 한 줄이 이 모양이다. */
export interface MinuteDayRecord {
  kind: 'day';
  symbol: string;
  instrumentId: string;
  name: string;
  date: string;
  candles: Candle[];
}

/** 파일 마지막 줄. 무엇을 몇 건 버렸는지. */
export interface CollectSummary {
  kind: 'summary';
  collectedAt: string;
  /**
   * 날을 어떻게 골랐나. **이 파일을 이어 붙여 백테스트해도 되는지**가 여기 달렸다.
   * `spread`는 날 사이가 며칠씩 벌어져 있어 이어 붙이면 갭이 인공물이 된다.
   */
  dateMode: 'spread' | 'contiguous';
  stockCount: number;
  dates: string[];
  usedDays: number;
  noBarDays: number;
  unverifiedDays: number;
  mismatchedDays: number;
  kisCalls: number;
}

function isOrderable(instrument: Instrument): boolean {
  if (instrument.country !== 'KR') return false;
  return instrument.assetType === 'stock' || instrument.assetType === 'etf' || instrument.assetType === 'etn';
}

/**
 * 스크리닝과 **같은 풀**을 쓴다.
 *
 * 다른 명단으로 재면 실측과 견줄 수 없다. `measureRangeExpansion.ts`·
 * `measureStrategies.ts`가 같은 순서를 쓴다.
 */
async function buildPool(size: number): Promise<Instrument[]> {
  const pools = await Promise.all(
    SOURCE_CATEGORIES.map((category) => getCategoryInstruments(category, 300).catch(() => [])),
  );
  const pool: Instrument[] = [];
  const seen = new Set<string>();
  for (let index = 0; pool.length < size; index += 1) {
    let added = false;
    for (const list of pools) {
      const instrument = list[index];
      if (!instrument || !isOrderable(instrument) || seen.has(instrument.id)) continue;
      seen.add(instrument.id);
      pool.push(instrument);
      added = true;
    }
    if (!added) break;
  }
  return pool;
}

/** `Candle.time`(UTC epoch 초) → KST 달력 날짜 `YYYYMMDD`. */
function kstDateOf(time: number): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' })
    .format(new Date(time * 1000))
    .replace(/-/g, '');
}

async function main(): Promise<void> {
  const stockCount = Number(process.argv[2] ?? 20);
  const dayCount = Number(process.argv[3] ?? 15);
  /*
   * 날을 어떻게 고를까. **쓰임이 다르면 표본도 달라야 한다.**
   *
   *   spread(기본)  받아 온 구간 전체에 고르게 흩뿌린다. 여러 장세를 보려는 것이라
   *                 **분포를 재는 데** 맞다.
   *   contiguous    최근 N거래일을 연달아. **이어 붙여 백테스트하는 데** 맞다.
   *
   * ★ 이 둘을 섞어 쓰다가 틀렸다(2026-08-01). 흩뿌린 표본을 이어 붙여 백테스트했더니
   * 날 사이 간격이 **중앙값 7일**(최대 53일)이었고, 그 자리의 갭이 |Δ| 중앙 3.30%로
   * **왕복 비용 0.43%의 7.7배**였다. 백테스트는 그걸 "한 봉"으로 먹는다. 건수로는
   * 밤 넘김이 4~7%뿐이라 무시해도 되는 줄 알았는데, 손익으로는 전체 손실의 56~162%를
   * 만들고 있었다 — **그 손실이 시장이 아니라 표본 설계에서 나온 인공물이다.**
   */
  const dateMode = (process.argv[4] ?? 'spread') as 'spread' | 'contiguous';
  if (dateMode !== 'spread' && dateMode !== 'contiguous') {
    console.error(`날짜 고르는 방식은 spread 또는 contiguous입니다: ${dateMode}`);
    process.exit(1);
  }

  /*
   * 거래일은 지어내지 않는다. 삼성전자 일봉의 날짜가 곧 개장일이고, 오늘은 뺀다 —
   * 장중이면 하루가 아직 안 끝났다.
   */
  const calendar = await getDailyCandles('005930', DAILY_HISTORY_DAYS);
  const today = kstDateOf(Math.floor(Date.now() / 1000));
  const available = calendar.candles.map((candle) => kstDateOf(candle.time)).filter((date) => date < today);
  const dates = dateMode === 'contiguous' ? available.slice(-dayCount) : spreadEvenly(available, dayCount);

  const pool = await buildPool(stockCount);
  const planned = pool.length * dates.length * MINUTE_CALLS_PER_DAY;
  console.log(
    `종목 ${pool.length} × 거래일 ${dates.length} (${dates[0]}~${dates[dates.length - 1]})`
    + ` · 종목·하루당 KIS ${MINUTE_CALLS_PER_DAY}회 = 분봉 ${planned}회 + 일봉 ${pool.length}회`,
  );
  console.log(
    dateMode === 'contiguous'
      ? '날짜: 최근 연속 거래일 — 이어 붙여 백테스트하는 데 쓴다'
      : '날짜: 구간 전체에 고르게 흩뿌림 — 분포를 재는 데 쓴다.'
        + ' ★ 이어 붙여 백테스트하지 마라 (날 사이 갭이 왕복 비용의 몇 배다)',
  );
  console.log(`원자료 ${OUT}\n`);

  // 이어 쓰면 옛 표본이 섞인다. 표본이 무엇인지 모르게 되는 쪽이 더 나쁘다.
  if (existsSync(OUT)) unlinkSync(OUT);

  let usedDays = 0;
  let noBarDays = 0;
  let unverifiedDays = 0;
  let mismatchedDays = 0;
  let kisCalls = 0;

  for (const instrument of pool) {
    // 검산용 일봉. 종목당 한 번만 받는다.
    const daily = await getDailyCandles(instrument.symbol, DAILY_HISTORY_DAYS).catch(() => null);
    kisCalls += 1;
    const dailyByDate = new Map((daily?.candles ?? []).map((candle) => [kstDateOf(candle.time), candle]));

    for (const date of dates) {
      const candles = await getDomesticDayMinuteCandles(instrument, date, CALL_GAP_MS);
      kisCalls += MINUTE_CALLS_PER_DAY;
      if (candles.length === 0) {
        noBarDays += 1;
        continue;
      }

      /*
       * **봉 수로 거르지 않는다.** 예전에 `measureRangeExpansion`이 60봉 미만을
       * 버렸더니 거래가 뜸한 종목이 통째로 빠졌다 — 그건 정확히 비용 문턱에
       * 걸리는 쪽이라 버리면 결과가 실제보다 좋게 나온다.
       */
      const dayCandle = dailyByDate.get(date);
      if (!dayCandle) {
        unverifiedDays += 1;
        continue;
      }
      const high = Math.max(...candles.map((candle) => candle.high));
      const low = Math.min(...candles.map((candle) => candle.low));
      if (dayCandle.high !== high || dayCandle.low !== low) {
        mismatchedDays += 1;
        continue;
      }

      usedDays += 1;
      const record: MinuteDayRecord = {
        kind: 'day',
        symbol: instrument.symbol,
        instrumentId: instrument.id,
        name: instrument.name,
        date,
        candles,
      };
      appendFileSync(OUT, `${JSON.stringify(record)}\n`);
    }

    console.log(
      `  ${instrument.symbol} ${instrument.name.slice(0, 14).padEnd(16)}`
      + ` 누적: 쓴 날 ${usedDays} · 봉 없음 ${noBarDays} · 일봉 없음 ${unverifiedDays} · 고저 불일치 ${mismatchedDays}`,
    );
  }

  const summary: CollectSummary = {
    kind: 'summary',
    collectedAt: new Date().toISOString(),
    dateMode,
    stockCount: pool.length,
    dates,
    usedDays,
    noBarDays,
    unverifiedDays,
    mismatchedDays,
    kisCalls,
  };
  appendFileSync(OUT, `${JSON.stringify(summary)}\n`);

  const attempted = pool.length * dates.length;
  console.log(
    `\n쓸 수 있는 종목·날 ${usedDays}/${attempted}건`
    + ` (봉 없음 ${noBarDays} · 일봉 없어 검산 못 함 ${unverifiedDays} · 고저 불일치 ${mismatchedDays})`,
  );
  console.log(`KIS ${kisCalls}회\n`);
  console.log(`재기: npx tsx src/scripts/measureStrategiesIntraday.ts ${OUT}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
