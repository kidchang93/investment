/**
 * 러너 한 회차의 분봉 재료 검증.
 *
 * 여기 판정이 곧 "러너가 무엇을 근거로 주문을 내는가"다. 실계좌를 띄우지 않고
 * 잴 수 있는 자리라 경계를 못 박아 둔다.
 *
 * ── 픽스처를 짓는 규칙 ────────────────────────────────────────────────────
 *
 * 시각은 `+09:00` 오프셋을 붙인 벽시계 문자열로 만든다. **검사 대상인
 * `kstDayKey`로 픽스처나 기대값을 짓지 않는다** — 그 함수가 틀리면 시험도 같이
 * 틀려서 아무것도 못 잡는다. 기대 날짜는 `'20260730'`처럼 그대로 적는다.
 * KRX는 서머타임이 없으므로 오프셋은 언제나 +09:00이다.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Candle, Instrument } from '@invest/shared';

import {
  candleDayKey,
  candleTargets,
  checkCandleDay,
  classifyCandles,
  describeCandleSkips,
  kstDayKey,
  type CandleSkip,
} from './runCandles.js';
import { getStrategy } from './strategy.js';

/** 그날 KST 벽시계 시각. */
function kst(clock: string): Date {
  return new Date(clock.includes('T') ? `${clock}+09:00` : `2026-07-31T${clock}+09:00`);
}

/** `Candle.time`은 UTC epoch **초**다. */
function candle(clock: string, close = 10_000): Candle {
  return {
    time: Math.floor(kst(clock).getTime() / 1000),
    open: close,
    high: close,
    low: close,
    close,
    volume: 100,
  };
}

/** 1분봉 `count`개를 `date`의 15:30에서 거꾸로 채운다. KIS가 주는 모양 그대로다. */
function minuteBars(date: string, count: number, endClock = '15:30'): Candle[] {
  const end = new Date(`${date}T${endClock}:00+09:00`).getTime();
  return Array.from({ length: count }, (_unused, index) => {
    const at = new Date(end - (count - 1 - index) * 60_000);
    return {
      time: Math.floor(at.getTime() / 1000),
      open: 10_000,
      high: 10_010,
      low: 9_990,
      close: 10_000,
      volume: 100,
    };
  });
}

describe('캔들 거래일 — KST 달력으로 잰다', () => {
  it('epoch 초를 KST 날짜로 읽는다', () => {
    assert.equal(candleDayKey(Math.floor(kst('2026-07-30T15:30:00').getTime() / 1000)), '20260730');
  });

  it('KST 자정 직후 봉은 그날 것이다 — UTC로 재면 전날이 된다', () => {
    /*
     * 2026-07-31 00:30 KST = 2026-07-30 15:30 UTC. UTC 달력으로 읽으면 하루
     * 어긋난다. KRX 분봉이 이 시각에 나오지는 않지만, 계산이 어느 달력을
     * 쓰는지는 여기서만 갈린다.
     */
    assert.equal(candleDayKey(Math.floor(kst('2026-07-31T00:30:00').getTime() / 1000)), '20260731');
  });

  it('ms를 넣으면 날짜가 나오지 않는다 — 초 단위 계약을 못 박는다', () => {
    /*
     * `Candle.time`을 ms로 잘못 넣으면 서기 58548년이 된다. `Date` 범위 안이라
     * 오류도 안 나고 `'585481106'` 9자리가 나왔다 — 그대로 두면 전 종목이 사유
     * 없이 빠진다. 8자리가 아니면 날짜로 쓰지 않는다.
     */
    assert.equal(candleDayKey(kst('2026-07-31T09:00:00').getTime()), undefined);
  });

  it('읽을 수 없는 값은 undefined다', () => {
    assert.equal(candleDayKey(Number.NaN), undefined);
    assert.equal(candleDayKey(Number.POSITIVE_INFINITY), undefined);
    assert.equal(kstDayKey(new Date('없는 날짜')), undefined);
  });
});

describe('마지막 봉이 오늘 것인가', () => {
  it('오늘 봉이면 통과한다', () => {
    const check = checkCandleDay(minuteBars('2026-07-31', 120, '14:06'), kst('14:07:00'));
    assert.deepEqual(check, { state: 'today', tradingDay: '20260731' });
  });

  it('어제 봉만 오면 제외한다 — 신호 없음이 아니라 제외다', () => {
    const check = checkCandleDay(minuteBars('2026-07-30', 120), kst('09:00:30'));
    assert.deepEqual(check, { state: 'otherDay', tradingDay: '20260730' });
  });

  it('봉이 120개라 minBars가 차 있어도 어제 것이면 제외한다', () => {
    /*
     * 2026-07-31 실측: `20260726`(일)을 물었더니 `20260724` 120봉이 `MCA00000
     * 정상처리`로 왔다. 개수로는 막을 수 없다는 것이 이 결함의 핵심이다 —
     * 세 전략의 `minBars`(20~21)가 전부 차 있고 어제 15:30 종가가 `price`가 된다.
     */
    const stale = minuteBars('2026-07-24', 120);
    for (const key of ['ma_cross', 'volatility_breakout', 'mean_reversion']) {
      const strategy = getStrategy(key);
      assert.ok(strategy, key);
      assert.ok(stale.length >= strategy.minBars, `${key}의 minBars는 이미 차 있다`);
    }
    assert.equal(checkCandleDay(stale, kst('2026-07-26T10:00:00')).state, 'otherDay');
  });

  it('장전 08:30에 어제 봉을 쥐면 제외한다 — UTC로 재면 통과해 버린다', () => {
    /*
     * **이 시험이 이 모듈의 이유다.** 08:30 KST = 전날 23:30 UTC라, UTC 달력으로
     * 비교하면 어제 15:30 봉과 같은 날이 되어 `today`로 통과한다. 그러면 개장
     * 직후 리스크 룰 시간대(09:00~15:30)에 들어서는 순간 어제 종가로 주문이 나간다.
     */
    const check = checkCandleDay(minuteBars('2026-07-30', 120), kst('08:30:00'));
    assert.equal(check.state, 'otherDay');
    assert.equal(check.tradingDay, '20260730');
  });

  it('마지막 봉이 오늘이면 앞이 어제여도 통과한다 — price는 마지막 봉에서 나온다', () => {
    /*
     * 이 TR의 날짜 경계는 실측상 단단하다(`20260730 090500` → 6봉 전부 0730).
     * 그래도 판정의 주인이 **마지막 봉**이라는 계약을 못 박는다. 섞여 오기
     * 시작해도 "오늘 값을 쥐었나"라는 물음의 답은 바뀌지 않는다.
     */
    const mixed = [...minuteBars('2026-07-30', 118), ...minuteBars('2026-07-31', 2, '09:01')];
    assert.deepEqual(checkCandleDay(mixed, kst('09:01:30')), { state: 'today', tradingDay: '20260731' });
  });

  it('마지막 봉만 어제면 제외한다 — 개수로 판정하지 않는다', () => {
    const mixed = [...minuteBars('2026-07-31', 118, '14:00'), candle('2026-07-30T15:30:00')];
    assert.equal(checkCandleDay(mixed, kst('14:01:00')).state, 'otherDay');
  });

  it('봉이 없거나 시각을 못 읽으면 unknown이다', () => {
    assert.deepEqual(checkCandleDay([], kst('10:00:00')), { state: 'unknown' });
    const broken = [{ ...candle('09:00:00'), time: Number.NaN }];
    assert.deepEqual(checkCandleDay(broken, kst('10:00:00')), { state: 'unknown' });
  });

  it('휴장일에는 전 종목이 빠진다 — 그게 맞는 동작이다', () => {
    // 2026-07-26은 일요일. 이때 물으면 20260724 봉이 온다(실측).
    assert.equal(checkCandleDay(minuteBars('2026-07-24', 120), kst('2026-07-26T11:00:00')).state, 'otherDay');
    assert.equal(checkCandleDay(minuteBars('2026-07-24', 120), kst('2026-07-25T11:00:00')).state, 'otherDay');
  });
});

/** 종목은 id만 다르면 충분하다 — 고르기는 값을 보지 않는다. */
function instrument(symbol: string): Instrument {
  return {
    id: `KR:KOSPI:${symbol}`,
    symbol,
    name: `종목${symbol}`,
    market: 'KOSPI',
    country: 'KR',
    currency: 'KRW',
    assetType: 'stock',
    provider: 'kis',
    providerSymbol: symbol,
    exchangeCode: 'KRX',
    timezone: 'Asia/Seoul',
  };
}

const ids = (list: Instrument[]): string[] => list.map((item) => item.symbol);

describe('분봉을 받을 종목 고르기', () => {
  const candidates = ['000010', '000020', '000030', '000040', '000050'].map(instrument);

  it('보유가 없으면 후보를 예산까지만 자른다', () => {
    assert.deepEqual(ids(candleTargets([], candidates, 3)), ['000010', '000020', '000030']);
  });

  it('보유 종목이 먼저 온다', () => {
    const held = [instrument('999999')];
    assert.deepEqual(ids(candleTargets(held, candidates, 3)), ['999999', '000010', '000020']);
  });

  it('보유 종목은 예산을 넘겨도 잘리지 않는다 — 자르면 못 판다', () => {
    /*
     * 여기가 잘리면 그 종목은 매도 신호가 아예 날 수 없다. 후보를 못 사는 것과
     * 보유를 못 파는 것은 무게가 다르다.
     */
    const held = Array.from({ length: 12 }, (_unused, index) => instrument(`9000${index}`));
    const targets = candleTargets(held, candidates, 8);
    assert.equal(targets.length, 12);
    assert.deepEqual(ids(targets), ids(held));
  });

  it('보유가 후보에도 있으면 한 번만 넣고 후보 자리를 먹지 않는다', () => {
    const targets = candleTargets([candidates[0]], candidates, 3);
    assert.deepEqual(ids(targets), ['000010', '000020', '000030']);
  });

  it('예산이 0이어도 보유는 들어간다', () => {
    assert.deepEqual(ids(candleTargets([instrument('999999')], candidates, 0)), ['999999']);
  });

  it('후보가 비어도 보유는 판단 대상이다 — 현금이 없는 회차가 그렇다', () => {
    /*
     * 현금을 다 써서 산 다음 회차는 `loadAutoTraderCandidates`가 `현금이
     * 없습니다`로 빈 목록을 준다. 예전에는 그래서 방금 산 종목을 영영 못 팔았다.
     */
    assert.deepEqual(ids(candleTargets([instrument('999999')], [], 8)), ['999999']);
  });

  it('같은 종목이 보유에 두 번 들어와도 한 번만 묻는다', () => {
    const held = [instrument('999999'), instrument('999999')];
    assert.equal(candleTargets(held, [], 8).length, 1);
  });
});

describe('받아 온 분봉을 후보로 쓸지 정하기', () => {
  const target = instrument('005930');

  it('오늘 봉이면 후보가 되고 price는 마지막 봉 종가다', () => {
    /*
     * `price`가 주문 수량(`cash / price`)을 정한다. 첫 봉 종가를 쓰면 값이
     * 다르고, 그러면 수량이 달라진다.
     */
    const candles = [candle('09:00:00', 10_000), candle('09:01:00', 11_000), candle('09:02:00', 12_500)];
    const result = classifyCandles(target, candles, false, kst('09:02:30'));
    assert.equal(result.skip, undefined);
    assert.equal(result.candidate?.price, 12_500);
    assert.equal(result.candidate?.instrument.symbol, '005930');
  });

  it('어제 봉만 오면 후보가 아니다 — 어제 종가로 수량을 정하지 않는다', () => {
    const result = classifyCandles(target, minuteBars('2026-07-30', 120), false, kst('09:00:30'));
    assert.equal(result.candidate, undefined);
    assert.deepEqual(result.skip, {
      name: '종목005930',
      reason: 'notToday',
      held: false,
      tradingDay: '20260730',
    });
  });

  it('조회 실패와 빈 분봉을 다른 사유로 가른다', () => {
    assert.equal(classifyCandles(target, null, false, kst('10:00:00')).skip?.reason, 'requestFailed');
    assert.equal(classifyCandles(target, [], false, kst('10:00:00')).skip?.reason, 'noCandles');
  });

  it('보유 여부를 사유에 함께 남긴다', () => {
    const result = classifyCandles(target, minuteBars('2026-07-30', 120), true, kst('09:00:30'));
    assert.equal(result.skip?.held, true);
  });
});

describe('빠진 종목을 실행 기록에 적기', () => {
  const skip = (overrides: Partial<CandleSkip> = {}): CandleSkip => ({
    name: '종목A',
    reason: 'notToday',
    held: false,
    tradingDay: '20260730',
    ...overrides,
  });

  it('빠진 것이 없으면 빈 문자열이다 — 0종목이라고 적지 않는다', () => {
    assert.equal(describeCandleSkips([]), '');
  });

  it('사유와 개수와 마지막 봉 날짜를 적는다', () => {
    const note = describeCandleSkips([skip(), skip({ name: '종목B' })]);
    assert.equal(note, '마지막 분봉이 오늘 것이 아니어서 제외 2종목 (마지막 봉 20260730)');
  });

  it('마지막 봉 날짜가 여럿이면 전부 적는다', () => {
    const note = describeCandleSkips([skip(), skip({ name: '종목B', tradingDay: '20260724' })]);
    assert.equal(note, '마지막 분봉이 오늘 것이 아니어서 제외 2종목 (마지막 봉 20260724, 20260730)');
  });

  it('사유가 섞이면 순서가 고정이다', () => {
    const note = describeCandleSkips([
      skip({ name: '종목C', reason: 'noCandles', tradingDay: undefined }),
      skip({ name: '종목B', reason: 'requestFailed', tradingDay: undefined }),
      skip(),
    ]);
    assert.equal(
      note,
      '마지막 분봉이 오늘 것이 아니어서 제외 1종목 (마지막 봉 20260730)'
        + ' · 분봉 조회 실패로 제외 1종목'
        + ' · 쓸 수 있는 분봉이 없어 제외 1종목',
    );
  });

  it('보유 종목이 빠지면 이름까지 적는다 — 못 사는 게 아니라 못 파는 것이다', () => {
    const note = describeCandleSkips([skip({ name: '삼성전자', held: true }), skip({ name: '종목B' })]);
    assert.ok(note.includes('보유 1종목은 이번 회차에 팔 수 없습니다 (삼성전자)'), note);
  });

  it('보유가 안 빠졌으면 보유 문장을 붙이지 않는다', () => {
    assert.ok(!describeCandleSkips([skip()]).includes('보유'), '보유가 없는데 보유를 말하면 안 된다');
  });

  it('보간한 값 뒤에 조사를 붙이지 않는다', () => {
    /*
     * 종목명·날짜는 실행 시점에 정해지는데 받침에 따라 조사가 달라진다.
     * 괄호로 빼서 문장 끝에 두는 규칙(`docs/CODE_STYLE.md`)을 지키는지 본다.
     */
    for (const name of ['삼성전자', 'SK하이닉스', '005930']) {
      const note = describeCandleSkips([skip({ name, held: true })]);
      assert.ok(note.endsWith(`(${name})`), note);
    }
  });
});
