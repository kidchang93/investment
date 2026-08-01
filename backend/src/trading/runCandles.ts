/**
 * 러너 한 회차의 분봉 재료 — 무엇을 받아 올지 고르고, 받은 것이 오늘 것인지 본다.
 *
 * 네트워크·DB를 타지 않는 순수 계산만 둔다. 여기 있는 판정이 곧 "러너가 무엇을
 * 근거로 주문을 내는가"라서, 실계좌를 띄우지 않고도 시험으로 덮을 수 있어야 한다.
 *
 * ── 왜 날짜를 봐야 하나 (2026-07-31 실전 서버 실측) ───────────────────────
 *
 * 러너는 `getInstrumentIntradayCandles`(`FHKST03010230`, `FID_INPUT_HOUR_1='235959'`)로
 * 1분봉 120개를 받는다. **그 날짜에 봉이 하나도 없으면 KIS가 이전 거래일 것을
 * 채워 준다** — 오류도 빈 응답도 아니고 `MCA00000 정상처리`다.
 *
 *   20260726(일) 요청 → 120봉 전부 20260724 (12:55~15:30)
 *   20260725(토) 요청 → 120봉 전부 20260724
 *
 * 예전 `loadCandles`는 날짜를 안 보고 `candles[last].close`를 그대로 `price`로
 * 썼다. 그래서 09:00:00부터 KIS가 오늘 첫 분봉을 내놓기 전까지는 `minBars`
 * (20~21)가 이미 차 있고, **어제 15:30 종가로 신호와 주문 수량이 나올 수 있었다.**
 * 리스크 룰의 거래 시간대(09:00~15:30) 안이라 시간으로는 막히지 않는다.
 * 그 구간이 몇 초인지는 **못 쟀다** — 개장 시각에 재야 한다.
 *
 * ── 왜 시계가 아니라 데이터를 보나 ────────────────────────────────────────
 *
 * "장전이면 검사를 건너뛴다" 같은 시계 조건을 붙이지 않는다. 휴장일을 아는 것은
 * 서버(KIS `chk-holiday`)지 이 계산이 아니고, 시계로 가르면 휴장일에 같은 결함이
 * 그대로 돌아온다. **마지막 봉의 날짜 하나가 "오늘 값을 쥐고 있나"를 그대로
 * 말해 준다.**
 *
 * 그래서 장전·휴장일에는 후보가 전부 빠진다. 그게 맞는 동작이다 — 그 시각에는
 * 오늘 값이 존재하지 않는다. 다만 실행 기록에는 `신호 없음`이 아니라 **제외**로
 * 남아야 한다. "볼 것을 다 보고 낼 신호가 없었다"와 "볼 수가 없었다"는 다른
 * 사실이고, 뒤엣것은 고칠 수 있는 것도 아니라 사유가 남아야 한다.
 *
 * ── 마지막 봉만 본다 ──────────────────────────────────────────────────────
 *
 * 앞부분이 어제이고 마지막만 오늘인 묶음은 통과시킨다. `price`가 나오는 자리가
 * 마지막 봉이고, 그 값이 오늘 값이면 "어제 종가로 주문한다"는 결함은 없다.
 *
 * 덧붙여 이 TR의 날짜 경계는 단단하다 — 위 실측에서 `20260730 090500`은 6봉이
 * 전부 0730이었고 섞여 온 적이 없다. 그래도 마지막 봉으로 판정하는 계약을
 * 시험에 못 박아 둔다. 섞여 오기 시작해도 판정이 흔들리지 않게.
 */

import type { Candle, CandleAxis, Instrument } from '@invest/shared';

/**
 * 러너가 전략에 넣는 봉. **여기가 축의 주인이다** — 실제로 분봉을 받아 오는 곳이라
 * 이 값이 바뀌면 받아 오는 코드도 같이 바뀐다.
 *
 * 전략 판정문이 다른 축에서 잰 것이면 화면이 그 사실을 말해야 한다. 예전에는 축이
 * 어디에도 값으로 없어서, 일봉으로 잰 판정문이 자동매매 시작 버튼 옆에 아무 표시
 * 없이 떠 있었다.
 */
export const RUNNER_CANDLE_AXIS: CandleAxis = 'minute';

/** 마지막 봉이 어느 거래일 것인가. */
export interface CandleDayCheck {
  /** `unknown`은 봉이 없거나 시각을 읽을 수 없는 것이다 */
  state: 'today' | 'otherDay' | 'unknown';
  /** 마지막 봉의 거래일(KST `YYYYMMDD`). 읽지 못했으면 undefined */
  tradingDay?: string;
}

const KST_DAY_FORMAT = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Seoul',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** 어느 시각의 KST 달력 날짜 `YYYYMMDD`. 읽을 수 없으면 undefined. */
export function kstDayKey(at: Date): string | undefined {
  if (Number.isNaN(at.getTime())) return undefined;
  const parts = KST_DAY_FORMAT.formatToParts(at);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const key = `${values.year ?? ''}${values.month ?? ''}${values.day ?? ''}`;
  /*
   * 8자리가 아니면 날짜로 쓰지 않는다. `Candle.time`을 ms로 넣으면 서기 58548년이
   * 되는데 `Date` 범위 안이라 오류가 나지 않고 `'585481106'` 9자리가 나온다.
   * 그걸 날짜인 척 돌려주면 전 종목이 사유 없이 빠진다.
   */
  return /^\d{8}$/.test(key) ? key : undefined;
}

/**
 * 캔들 하나의 거래일.
 *
 * `Candle.time`은 UTC epoch **초**다(ms 아님 — `docs/REVIEW.md`). ms를 넣으면
 * 5만 년 뒤가 나오고 그건 언제나 `otherDay`라 조용히 전 종목이 빠진다.
 */
export function candleDayKey(time: number): string | undefined {
  if (!Number.isFinite(time)) return undefined;
  return kstDayKey(new Date(time * 1000));
}

/** 마지막 봉이 오늘(KST) 것인지. 러너가 `price`로 쓰는 바로 그 봉을 본다. */
export function checkCandleDay(candles: Candle[], now: Date): CandleDayCheck {
  const last = candles[candles.length - 1];
  if (!last) return { state: 'unknown' };
  const tradingDay = candleDayKey(last.time);
  const today = kstDayKey(now);
  if (tradingDay === undefined || today === undefined) return { state: 'unknown' };
  return { state: tradingDay === today ? 'today' : 'otherDay', tradingDay };
}

/**
 * 이번 회차에 분봉을 받아 올 종목. **보유 종목이 먼저고, 잘리지 않는다.**
 *
 * ── 왜 보유 종목을 따로 넣나 ──────────────────────────────────────────────
 *
 * 예전에는 후보 앞 `budget`종목만 분봉을 받았고, `positions`도 그 교집합이었다.
 * 그래서 **후보 필터에서 빠진 보유 종목은 매도 신호가 아예 날 수 없었다.**
 * 값이 올라 `tooExpensive`가 되거나 얇아져 `illiquid`가 되면 매도 통로가
 * 사라진다. 특히 현금을 다 써서 산 다음 회차는 `loadAutoTraderCandidates`가
 * `현금이 없습니다`로 빈 목록을 돌려주므로, 방금 산 종목을 영영 못 판다.
 *
 * 위 날짜 검사가 이걸 더 나쁘게 만든다 — 제외되는 종목이 늘면 그만큼 못 판다.
 * 그래서 같은 작업에서 함께 고친다.
 *
 * ── 호출 수 ───────────────────────────────────────────────────────────────
 *
 * 한 회차 호출 수는 `max(budget, 보유 종목 수)`다. 보유 종목에는 예산을 걸지
 * 않는다 — 자르는 순간 "팔 수 없는 종목"이 다시 생기고, 그게 이 함수가 있는
 * 이유다. 보유 수는 계좌가 실제로 들고 있는 것이라 사람이 정한 상한이 아니다.
 * 대신 후보는 남은 자리만 쓴다. 보유가 예산을 다 먹으면 이번 회차는 매도만
 * 판단한다 — 나가는 문이 들어오는 문보다 앞이다.
 */
export function candleTargets(
  held: Instrument[],
  candidates: Instrument[],
  budget: number,
): Instrument[] {
  const targets: Instrument[] = [];
  const seen = new Set<string>();
  for (const instrument of held) {
    if (seen.has(instrument.id)) continue;
    seen.add(instrument.id);
    targets.push(instrument);
  }
  let room = Math.max(0, budget - targets.length);
  for (const instrument of candidates) {
    if (room <= 0) break;
    // 이미 보유로 들어간 종목은 자리를 먹지 않는다. 같은 종목을 두 번 묻지도 않는다.
    if (seen.has(instrument.id)) continue;
    seen.add(instrument.id);
    targets.push(instrument);
    room -= 1;
  }
  return targets;
}

/** 분봉을 쥐지 못해 이번 회차 판단에서 빠진 사유. */
export type CandleSkipReason = 'notToday' | 'requestFailed' | 'noCandles';

export interface CandleSkip {
  /** 실행 기록에 적을 종목 이름 */
  name: string;
  reason: CandleSkipReason;
  /** 보유 중이면 true. "이번 회차에 못 판다"는 뜻이라 따로 적는다 */
  held: boolean;
  /** `notToday`일 때 마지막 봉의 거래일 */
  tradingDay?: string;
}

/*
 * 사유 이름은 **잰 사실**로 짓는다. 마지막 봉이 오늘 것이 아니라는 것만 잰
 * 사실이고, "오늘 분봉이 아직 안 나왔다"는 그 원인의 추측이다 — 장전에는 그게
 * 맞지만 상장폐지·거래정지처럼 오늘 봉이 영영 안 나오는 경우도 같은 모양이다.
 */
const SKIP_LABELS: Record<CandleSkipReason, string> = {
  notToday: '마지막 분봉이 오늘 것이 아니어서 제외',
  requestFailed: '분봉 조회 실패로 제외',
  noCandles: '쓸 수 있는 분봉이 없어 제외',
};

/** 기록이 회차마다 흔들리지 않도록 사유 순서를 고정한다. */
const SKIP_ORDER: CandleSkipReason[] = ['notToday', 'requestFailed', 'noCandles'];

/**
 * 전략에게 넘길 한 종목. `StrategyContext['candidates']`의 원소와 같은 모양이다.
 *
 * 전략 쪽 타입을 가져오지 않는 이유는 방향이다 — 여기는 순수 계산이고 전략을
 * 몰라야 한다. 구조가 같으니 그대로 들어간다.
 */
export interface CandleCandidate {
  instrument: Instrument;
  candles: Candle[];
  price: number;
}

/**
 * 받아 온 분봉 하나로 "이번 회차에 이 종목을 판단할 수 있나"를 정한다.
 *
 * `candles`가 null이면 조회가 실패한 것이다. 실패를 빈 배열로 바꾸지 않는다 —
 * "못 받았다"와 "봉이 없다"는 다른 사실이고 사유도 달라야 한다.
 *
 * **`price`는 마지막 봉의 종가다.** 이 값이 주문 수량(`cash / price`)을 정하므로,
 * 날짜 검사가 지키는 것이 바로 이 한 줄이다.
 */
export function classifyCandles(
  instrument: Instrument,
  candles: Candle[] | null,
  held: boolean,
  now: Date,
): { candidate?: CandleCandidate; skip?: CandleSkip } {
  if (candles === null) {
    return { skip: { name: instrument.name, reason: 'requestFailed', held } };
  }
  const day = checkCandleDay(candles, now);
  if (day.state === 'unknown') {
    return { skip: { name: instrument.name, reason: 'noCandles', held } };
  }
  if (day.state === 'otherDay') {
    return { skip: { name: instrument.name, reason: 'notToday', held, tradingDay: day.tradingDay } };
  }
  const last = candles[candles.length - 1];
  return { candidate: { instrument, candles, price: last.close } };
}

/**
 * 빠진 종목을 실행 기록 한 줄로 적는다. 빠진 것이 없으면 빈 문자열이다.
 *
 * 보간한 값 뒤에 조사를 붙이지 않는다(`docs/CODE_STYLE.md`) — 날짜·종목명은
 * 괄호로 빼서 문장 끝에 둔다.
 */
export function describeCandleSkips(skips: CandleSkip[]): string {
  if (skips.length === 0) return '';
  const parts: string[] = [];
  for (const reason of SKIP_ORDER) {
    const group = skips.filter((skip) => skip.reason === reason);
    if (group.length === 0) continue;
    const days = [...new Set(group.map((skip) => skip.tradingDay).filter((day): day is string => Boolean(day)))].sort();
    const daysHint = days.length > 0 ? ` (마지막 봉 ${days.join(', ')})` : '';
    parts.push(`${SKIP_LABELS[reason]} ${group.length}종목${daysHint}`);
  }
  /*
   * 보유 종목이 빠졌다는 것은 사유가 다르다 — 못 사는 게 아니라 **못 파는**
   * 것이다. 개수만으로는 어느 종목이 갇혔는지 알 수 없으니 이름까지 적는다.
   */
  const heldNames = skips.filter((skip) => skip.held).map((skip) => skip.name);
  if (heldNames.length > 0) {
    parts.push(`보유 ${heldNames.length}종목은 이번 회차에 팔 수 없습니다 (${heldNames.join(', ')})`);
  }
  return parts.join(' · ');
}
