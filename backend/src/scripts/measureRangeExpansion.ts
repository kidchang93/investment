/**
 * 하루 변동폭이 장중에 어떻게 벌어지는지 실제로 잰다.
 *
 * ── 왜 ────────────────────────────────────────────────────────────────────
 *
 * `screenQuote`의 비용 문턱은 하루치 잣대(왕복 비용 0.43%가 변동폭의 절반을
 * 넘으면 탈락 → **하루 변동폭 0.860% 이상 필요**)인데 장 초반에도 그대로
 * 걸린다. 유동성 문턱만 `elapsed`를 곱한다. 2026-07-31 장중 실측에서
 * 09:04에 120종목 중 18종목이 `costHeavy`였고 10:00에는 12종목이었다.
 *
 * 고칠지 말지를 하루치 관찰로 정할 수는 없다. 이 스크립트는 **과거를
 * 재구성해** 여러 날·여러 종목·여러 시각의 분포를 모은다.
 *
 * ── 과거를 어떻게 재구성하나 (2026-07-31 실측으로 확인) ──────────────────
 *
 * 주식일별분봉조회(`FHKST03010230`)는 `FID_INPUT_DATE_1`로 **과거 날짜**를
 * 받고 `FID_INPUT_HOUR_1`로 끝 시각을 정해 **거기서 뒤로 120봉**을 준다.
 * 2025-10-31까지 거슬러 받아지는 것을 확인했다. 정규장 09:00~15:30은 391분
 * 이라 창 다섯 개를 이어 붙여야 하루가 덮인다 — 그래서 종목·하루당 5회다.
 * (`getInstrumentIntradayCandles`는 오늘 날짜가 박혀 있고 120봉만 준다.)
 *
 * 이어 붙인 것이 맞는지는 **일봉의 고가·저가와 대조**한다. 한 칸이라도
 * 빠지면 하루 고저가 달라지므로, 안 맞으면 그 종목·날짜는 버린다.
 *
 * ── 무엇을 세나 ───────────────────────────────────────────────────────────
 *
 * 시각 t마다 두 값을 낸다 (`trading/rangeExpansion.ts`).
 *   rangeRate      개장~t 누적 고저폭 ÷ 그 시각 값 → **지금 잣대가 보는 것**
 *   aheadRangeRate t 이후~마감 고저폭 ÷ 그 시각 값 → **t에 들어간 사람 앞에 남은 폭**
 *
 * 비용 문턱이 진짜 묻는 것은 뒤쪽이다. 그래서 세 잣대를 뒤쪽 사실과 견준다.
 *   지금       rangeRate ≥ 0.860%
 *   시간비례   rangeRate ≥ 0.860% × elapsed
 *   √t 보정    rangeRate ≥ 0.860% × √elapsed
 *
 * **주문은 내지 않는다.** 조회만 한다.
 *
 * KIS를 직접 부르는 것은 조사용 스크립트의 규약이다(`captureAuction.ts` 선례,
 * `docs/ARCHITECTURE.md`). 날짜를 지정하는 분봉 조회가 화면 기능이 되면 그때
 * `kis/rest.ts`로 옮긴다 — 지금 `getInstrumentIntradayCandles`는 오늘 날짜가
 * 박혀 있어 이 측정에 쓸 수 없다.
 *
 *   npx tsx src/scripts/measureRangeExpansion.ts [종목수] [거래일수]
 *   npx tsx src/scripts/measureRangeExpansion.ts 60 10
 */

import { appendFileSync } from 'node:fs';

import { KRX_SESSION_MINUTES } from '@invest/shared';

import { config } from '../config.js';
import { getCategoryInstruments } from '../db/instruments.js';
import { getAccessToken, primaryCredentials } from '../kis/auth.js';
import { getDailyCandles } from '../kis/rest.js';
import {
  fullDayRangeRate,
  normalizeMinuteBars,
  snapshotAt,
  spreadEvenly,
  type MinuteBar,
} from '../trading/rangeExpansion.js';
import { MAX_COST_SHARE_OF_RANGE, MIN_DAILY_TURNOVER, ROUND_TRIP_COST_RATE } from '../trading/universe.js';
import type { Instrument } from '@invest/shared';

const OUT = process.env.RANGE_OUT ?? '/tmp/range-expansion.jsonl';
/** KIS 초당 한도(EGW00201)를 태우지 않게 둔다. 백엔드도 같은 앱키를 쓰고 있다. */
const CALL_GAP_MS = 220;
const RATE_LIMIT_BACKOFF_MS = 1200;

/*
 * 정규장 391분을 덮는 창 다섯 개. 한 번에 120봉이라 겹쳐 가며 이어 붙인다.
 *   093000 → 0900~0930 · 110000 → 0901~1100 · 130000 → 1101~1300
 *   150000 → 1301~1500 · 235959 → 1321~1530
 * 09:00 봉을 위해 093000이 따로 있다 — 개장 동시호가가 거기 들어간다.
 */
const WINDOW_HOURS = ['093000', '110000', '130000', '150000', '235959'];

const SESSION_OPEN = KRX_SESSION_MINUTES.open;
const SESSION_CLOSE = KRX_SESSION_MINUTES.close;
const SESSION_MINUTES = SESSION_CLOSE - SESSION_OPEN;

/** 재 볼 시각. 장 초반을 촘촘히 둔다 — 문제가 거기서 난다. */
const GRID = ['09:01', '09:05', '09:15', '09:30', '10:00', '10:30', '11:00', '12:00', '13:00', '14:00', '15:00', '15:30'];

/** 왕복 비용을 이기려면 필요한 하루 변동폭. 0.43% ÷ 0.5 = 0.860% */
const REQUIRED_RANGE_RATE = ROUND_TRIP_COST_RATE / MAX_COST_SHARE_OF_RANGE;

const SOURCE_CATEGORIES = ['kr-all', 'kr-etf'];

/**
 * 일봉을 몇 거래일치 받아 둘까.
 *
 * KIS 일봉은 한 번에 100건이 상한이다(`rest.ts`의 `DAILY_PAGE_CALENDAR_DAYS`
 * 주석). `getDailyCandles`가 달력일을 `days × 1.7`로 잡으므로 55면 약 94
 * 달력일 ≒ 64거래일이라 상한 안이다. 여기서 얻은 날짜가 곧 표본의 시간 폭이다.
 */
const DAILY_HISTORY_DAYS = 55;

function toMinute(clock: string): number {
  const [hour, minute] = clock.split(':').map(Number);
  return hour * 60 + minute;
}

function isOrderable(instrument: Instrument): boolean {
  if (instrument.country !== 'KR') return false;
  return instrument.assetType === 'stock' || instrument.assetType === 'etf' || instrument.assetType === 'etn';
}

/** 스크리닝과 같은 풀을 쓴다. 다른 명단으로 재면 실측과 견줄 수 없다. */
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

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchWindow(code: string, date: string, hour: string, token: string): Promise<MinuteBar[]> {
  const url = new URL('/uapi/domestic-stock/v1/quotations/inquire-time-dailychartprice', config.restBase);
  url.searchParams.set('FID_COND_MRKT_DIV_CODE', 'J');
  url.searchParams.set('FID_INPUT_ISCD', code);
  url.searchParams.set('FID_INPUT_HOUR_1', hour);
  url.searchParams.set('FID_INPUT_DATE_1', date);
  url.searchParams.set('FID_PW_DATA_INCU_YN', 'N');
  url.searchParams.set('FID_FAKE_TICK_INCU_YN', '');

  async function once(): Promise<{ bars: MinuteBar[]; rateLimited: boolean }> {
    const res = await fetch(url, {
      headers: {
        authorization: `Bearer ${token}`,
        appkey: primaryCredentials.appKey,
        appsecret: primaryCredentials.appSecret,
        tr_id: 'FHKST03010230',
        custtype: config.custType,
      },
    });
    const json = (await res.json()) as { msg_cd?: string; output2?: Array<Record<string, string>> };
    if (json.msg_cd === 'EGW00201') return { bars: [], rateLimited: true };
    const bars = (json.output2 ?? [])
      .filter((row) => /^\d{6}$/.test(row.stck_cntg_hour ?? '') && row.stck_bsop_date === date)
      .map((row) => ({
        minute: Number(row.stck_cntg_hour.slice(0, 2)) * 60 + Number(row.stck_cntg_hour.slice(2, 4)),
        high: Number(row.stck_hgpr),
        low: Number(row.stck_lwpr),
        close: Number(row.stck_prpr),
        // 빈 문자열은 `Number('') === 0`이라 "거래 없음"이 지어진다. 없으면 없다고 둔다.
        volume: row.cntg_vol === undefined || row.cntg_vol === '' ? undefined : Number(row.cntg_vol),
      }));
    return { bars, rateLimited: false };
  }

  const first = await once();
  if (!first.rateLimited) return first.bars;
  await delay(RATE_LIMIT_BACKOFF_MS);
  return (await once()).bars;
}

/** 하루치 분봉. 창 다섯 개를 이어 붙인다. */
async function fetchDay(code: string, date: string, token: string): Promise<MinuteBar[]> {
  const all: MinuteBar[] = [];
  for (const hour of WINDOW_HOURS) {
    all.push(...(await fetchWindow(code, date, hour, token)));
    await delay(CALL_GAP_MS);
  }
  return normalizeMinuteBars(all).filter((bar) => bar.minute >= SESSION_OPEN && bar.minute <= SESSION_CLOSE);
}

interface Sample {
  date: string;
  symbol: string;
  clock: string;
  elapsed: number;
  rangeRate: number;
  aheadRangeRate: number;
  fullDayRangeRate: number;
  /** 개장~t 누적 거래대금 어림. 유동성 문턱을 통과했는지 가르는 데만 쓴다 */
  turnoverSoFar: number | undefined;
  /** 그 시각에 `screenQuote`의 유동성 문을 통과했나 */
  liquid: boolean;
}

function pct(value: number): string {
  return Number.isFinite(value) ? `${(value * 100).toFixed(2)}%` : '   -  ';
}

async function main(): Promise<void> {
  const stockCount = Number(process.argv[2] ?? 60);
  const dayCount = Number(process.argv[3] ?? 10);
  const token = await getAccessToken(primaryCredentials);

  /*
   * 거래일은 지어내지 않는다. 삼성전자 일봉의 날짜가 곧 개장일이고, 오늘은
   * 뺀다 — 장중이라 하루가 아직 안 끝났다.
   *
   * **연달아 붙은 날로만 재지 않는다.** 이어진 열흘은 같은 장세라 표본이
   * 늘어도 새로 아는 것이 별로 없다. 받아 온 구간 전체에 고르게 흩뿌린다.
   * (`DAILY_HISTORY_DAYS`는 KIS 일봉 100건 상한 안에 드는 값이다. 넘기면
   *  오래된 날이 잘려 나가 검산용 일봉이 없어진다.)
   */
  const calendar = await getDailyCandles('005930', DAILY_HISTORY_DAYS);
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date()).replace(/-/g, '');
  const available = calendar.candles
    .map((candle) => new Date(candle.time * 1000).toISOString().slice(0, 10).replace(/-/g, ''))
    .filter((date) => date < today);
  const dates = spreadEvenly(available, dayCount);

  const pool = await buildPool(stockCount);
  console.log(
    `종목 ${pool.length} × 거래일 ${dates.length} (${dates[0]}~${dates[dates.length - 1]})`
    + ` · 종목·하루당 KIS ${WINDOW_HOURS.length}회 = 총 ${pool.length * dates.length * WINDOW_HOURS.length}회`,
  );
  console.log(`필요한 하루 변동폭 ${pct(REQUIRED_RANGE_RATE)} (왕복 비용 ${pct(ROUND_TRIP_COST_RATE)} ÷ ${MAX_COST_SHARE_OF_RANGE})`);
  console.log(`원자료 ${OUT}\n`);

  const samples: Sample[] = [];
  let usedDays = 0;
  let noBarDays = 0;
  let unverifiedDays = 0;
  let mismatchedDays = 0;

  for (const instrument of pool) {
    // 일봉의 고저와 대조하려고 한 번 받아 둔다. 이어 붙인 것이 맞는지 확인한다.
    const daily = await getDailyCandles(instrument.symbol, DAILY_HISTORY_DAYS).catch(() => null);
    const dailyByDate = new Map(
      (daily?.candles ?? []).map((candle) => [
        new Date(candle.time * 1000).toISOString().slice(0, 10).replace(/-/g, ''),
        candle,
      ]),
    );

    for (const date of dates) {
      const bars = await fetchDay(instrument.symbol, date, token);
      if (bars.length === 0) {
        noBarDays += 1;
        continue;
      }
      /*
       * **봉 수로 거르지 않는다.** 예전에 60봉 미만을 버렸더니 거래가 뜸한
       * 종목이 통째로 표본에서 빠졌다 — 그건 정확히 비용 문턱에 걸리는 쪽이라,
       * 버리면 `costHeavy` 비율이 실제보다 낮게 나온다.
       *
       * 대신 일봉의 고가·저가와 **정확히** 대조한다. 창을 하나라도 놓치면
       * 하루 고저가 달라지므로 봉 수보다 엄한 검사다. 일봉이 없는 날은
       * 검산을 못 하므로 쓰지 않는다 — 맞다고 치지 않는다.
       */
      const dayCandle = dailyByDate.get(date);
      if (!dayCandle) {
        unverifiedDays += 1;
        continue;
      }
      const reconstructedHigh = Math.max(...bars.map((bar) => bar.high));
      const reconstructedLow = Math.min(...bars.map((bar) => bar.low));
      if (dayCandle.high !== reconstructedHigh || dayCandle.low !== reconstructedLow) {
        mismatchedDays += 1;
        continue;
      }
      const full = fullDayRangeRate(bars);
      if (full === null) {
        noBarDays += 1;
        continue;
      }
      usedDays += 1;

      for (const clock of GRID) {
        const minute = toMinute(clock);
        const snapshot = snapshotAt(bars, minute);
        if (!snapshot) continue;
        const elapsed = Math.max(minute - SESSION_OPEN, 1) / SESSION_MINUTES;
        const sample: Sample = {
          date,
          symbol: instrument.symbol,
          clock,
          elapsed,
          rangeRate: snapshot.rangeRate,
          aheadRangeRate: snapshot.aheadRangeRate,
          fullDayRangeRate: full,
          turnoverSoFar: snapshot.turnoverSoFar,
          // `screenQuote`와 같은 순서다 — 유동성에 걸린 종목은 비용을 묻지도 않는다.
          liquid: (snapshot.turnoverSoFar ?? 0) >= MIN_DAILY_TURNOVER * elapsed,
        };
        samples.push(sample);
        appendFileSync(OUT, `${JSON.stringify(sample)}\n`);
      }
    }
    console.log(
      `  ${instrument.symbol} ${instrument.name.slice(0, 14).padEnd(16)}`
      + ` 누적: 쓴 날 ${usedDays} · 봉 없음 ${noBarDays} · 일봉 없음 ${unverifiedDays} · 고저 불일치 ${mismatchedDays}`,
    );
  }

  console.log(
    `\n표본 ${samples.length}건 · 종목·날 ${usedDays}건`
    + ` (봉 없음 ${noBarDays} · 일봉 없어 검산 못 함 ${unverifiedDays} · 고저 불일치 ${mismatchedDays})\n`,
  );

  /*
   * 해석은 여기서 하지 않는다. `analyzeRangeExpansion.ts`가 이 파일만 읽고
   * 분포·잣대 비교를 낸다 — 보는 각도를 바꿀 때마다 KIS를 다시 때릴 수 없다.
   */
  console.log(`해석: npx tsx src/scripts/analyzeRangeExpansion.ts ${OUT}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
