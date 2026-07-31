/**
 * 후보 거르기 검증.
 *
 * 이 두 문이 무엇을 통과시키느냐가 자동매매가 무엇을 사느냐다. 백테스트가
 * 아무리 좋게 나와도 여기서 잘못 통과시키면 그 값에 체결되지 않는다.
 *
 * 경계값을 못 박아 둔다 — 문턱은 조정할 값이지만, 조정했을 때 어느 쪽으로
 * 움직이는지는 시험이 말해 줘야 한다.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Quote } from '@invest/shared';

import { knownRangeRate, MIN_DAILY_TURNOVER, screenQuote, sessionElapsedRatio } from './universe.js';

/** 넉넉히 통과하는 기본값. 시험마다 필요한 값만 덮어쓴다. */
function quote(overrides: Partial<Quote> = {}): Quote {
  return {
    code: 'KR:KOSPI:000000',
    // 후보 거르기는 나이를 보지 않지만, 시각 없는 시세는 만들 수 없다.
    fetchedAt: Date.parse('2026-07-31T00:54:11.441Z'),
    price: 10_000,
    change: 0,
    changeRate: 0,
    sign: '3',
    open: 10_000,
    // 하루 2% 움직인 종목. 왕복 비용 0.43%는 변동폭의 21% 수준이라 통과한다.
    high: 10_100,
    low: 9_900,
    accVolume: 100_000, // 거래대금 10억
    ...overrides,
  };
}

describe('후보 거르기 — 유동성', () => {
  it('거래대금이 넉넉하면 통과한다', () => {
    assert.equal(screenQuote(quote(), 1), null);
  });

  it('거래대금이 문턱에 못 미치면 걸린다', () => {
    // 5천만원 문턱. 1만원 × 4,000주 = 4천만원.
    assert.equal(screenQuote(quote({ accVolume: 4_000 }), 1), 'illiquid');
  });

  it('문턱 바로 위는 통과한다', () => {
    // 1만원 × 5,000주 = 5천만원 = 문턱. 미만일 때만 거르므로 통과다.
    assert.equal(screenQuote(quote({ accVolume: 5_000 }), 1), null);
  });

  it('KIS가 준 실제 거래대금을 쓴다 — 현재가 × 거래량 어림이 아니다', () => {
    /*
     * 어림값(현재가 × 누적거래량)은 하루치 체결을 마지막 값 하나로 곱하는 것이라
     * 실제와 어긋난다. 005930 실측(2026-07-30 종가): 어림 9.67조 vs 실제 9.92조.
     *
     * 여기서는 둘이 문턱의 **반대편**에 놓이게 만든다. 어림값을 쓰면 판정이
     * 뒤집히므로, 이 시험이 통과한다는 것은 실제 값을 봤다는 뜻이다.
     */
    const underEstimated = quote({ price: 10_000, accVolume: 4_000, turnover: 60_000_000 });
    assert.equal(underEstimated.price * underEstimated.accVolume, 40_000_000, '어림하면 문턱 아래다');
    assert.equal(screenQuote(underEstimated, 1), null, '실제 거래대금은 6천만원이라 통과해야 한다');

    const overEstimated = quote({ price: 10_000, accVolume: 6_000, turnover: 40_000_000 });
    assert.equal(overEstimated.price * overEstimated.accVolume, 60_000_000, '어림하면 문턱 위다');
    assert.equal(screenQuote(overEstimated, 1), 'illiquid', '실제 거래대금은 4천만원이라 걸려야 한다');
  });

  it('거래대금을 안 주는 경로(해외·선물·야간 환산가)는 어림값으로 본다', () => {
    // 값이 없다고 통과시키거나 통째로 거르지 않는다. 어림이라는 사실만 남긴다.
    assert.equal(screenQuote(quote({ accVolume: 4_000 }), 1), 'illiquid');
    assert.equal(screenQuote(quote({ accVolume: 6_000 }), 1), null);
  });

  it('거래대금이 0이면 값이 0인 것이지 모르는 것이 아니다', () => {
    // 거래정지 종목이 실제로 이렇게 온다(009310 실측: 현재가 5,330 · 거래량 0).
    assert.equal(screenQuote(quote({ accVolume: 0, turnover: 0, high: 0, low: 0 }), 1), 'illiquid');
  });

  it('장 초반에는 지난 시간만큼만 요구한다', () => {
    /*
     * 09:05에는 5분치만 쌓인다. 하루치 문턱을 그대로 걸면 전 종목이 걸린다.
     * 10%가 지났으면 문턱도 10%다.
     */
    const early = quote({ accVolume: 600 }); // 거래대금 600만원
    assert.equal(screenQuote(early, 1), 'illiquid', '하루치 기준으로는 부족하다');
    assert.equal(screenQuote(early, 0.1), null, '10%만 지났으면 통과해야 한다');
  });
});

describe('후보 거르기 — 왕복 비용', () => {
  it('하루 변동폭이 넉넉하면 통과한다', () => {
    // 변동폭 2%, 왕복 비용 0.43% → 비용이 변동폭의 21%.
    assert.equal(screenQuote(quote({ high: 10_100, low: 9_900 }), 1), null);
  });

  it('변동폭이 왕복 비용의 두 배에 못 미치면 걸린다', () => {
    /*
     * 왕복 비용 0.43%(수수료 0.015%×2 + 거래세 0.20% + 슬리피지 0.1%×2).
     * 변동폭이 0.5%면 비용이 그 82%다. 방향을 맞혀도 남지 않는다.
     */
    assert.equal(screenQuote(quote({ high: 10_025, low: 9_975 }), 1), 'costHeavy');
  });

  it('고가·저가가 아직 없으면 이 잣대로 거르지 않는다', () => {
    /*
     * 장 초반이나 거래가 없는 종목은 고가·저가가 0으로 온다. 그걸 변동폭
     * 0으로 읽고 거르면, 모르는 것을 나쁜 것으로 단정하는 셈이다.
     */
    assert.equal(screenQuote(quote({ high: 0, low: 0 }), 1), null);
    assert.equal(knownRangeRate(quote({ high: 0, low: 0 })), undefined);
    // KIS가 빈 문자열을 준 자리는 NaN으로 온다. 그것도 모르는 것이다.
    assert.equal(knownRangeRate(quote({ high: NaN, low: NaN })), undefined);
  });

  it('고가 = 저가는 아는 값이다 — 폭 0이라 걸린다', () => {
    /*
     * 예전에는 `range > 0` 가드가 이 종목의 비용 검사를 통째로 건너뛰어,
     * **1원 움직인 종목은 버리면서 한 푼도 안 움직인 종목은 통과**시켰다.
     * 폭이 넓을수록 나쁠 수는 없다.
     *
     * 2026-07-31 장중 실측: `000227 유유제약2우B`가 09:35·10:00 두 회차 모두
     * `pass`였다. 거래대금이 8,684,600원으로 1원도 안 바뀐 채였다 — 25분간
     * 체결이 없는데 유동성은 누적값이라 통과하고 비용은 고가=저가라 면제됐다.
     */
    const flat = quote({ price: 10_000, high: 10_000, low: 10_000 });
    assert.equal(knownRangeRate(flat), 0);
    assert.equal(screenQuote(flat, 1), 'costHeavy');
  });

  it('폭이 넓어질수록 판정이 나빠지지 않는다', () => {
    /*
     * 폭 0 → 2원 → 80원 → 86원(문턱 0.860%) → 400원. 문턱을 한 번 넘은 뒤
     * 다시 탈락으로 돌아가면 안 된다. 예전 코드는 폭 0에서만 통과였다.
     */
    const verdicts = [0, 1, 40, 43, 200].map((half) =>
      screenQuote(quote({ price: 10_000, high: 10_000 + half, low: 10_000 - half }), 1),
    );
    assert.deepEqual(verdicts, ['costHeavy', 'costHeavy', 'costHeavy', null, null]);
  });

  it('고가가 저가보다 낮으면 모르는 것으로 둔다 — 음수 폭을 만들지 않는다', () => {
    assert.equal(knownRangeRate(quote({ high: 9_900, low: 10_100 })), undefined);
  });

  it('유동성이 먼저 걸리면 그 사유로 돌려준다', () => {
    // 둘 다 걸리는 종목. 순서가 정해져 있어야 기록이 흔들리지 않는다.
    assert.equal(screenQuote(quote({ accVolume: 100, high: 10_025, low: 9_975 }), 1), 'illiquid');
  });
});

/*
 * ── 장 경과 비율 ──────────────────────────────────────────────────────────
 *
 * 시각은 `+09:00` 오프셋을 붙인 벽시계 문자열로 만든다. **`KRX_SESSION_MINUTES`로
 * 픽스처를 짓지 않는다** — 검사 대상 상수로 데이터를 지으면 상수가 틀렸을 때
 * 시험도 같이 틀려서 아무것도 못 잡는다. 기대값도 KRX 사실(정규장 09:00~15:30 =
 * 390분 = 23,400초)에서 나온 숫자를 그대로 적는다.
 */
const SESSION_SECONDS = 23_400;

/** 그날 KST 벽시계 시각. 서머타임이 없으므로 오프셋은 언제나 +09:00이다. */
function kst(clock: string): Date {
  return new Date(`2026-07-31T${clock}+09:00`);
}

describe('장 경과 비율 — 경계', () => {
  it('개장 전에는 1이다 (전일 누적이 이미 하루치다)', () => {
    assert.equal(sessionElapsedRatio(kst('00:00:00')), 1);
    assert.equal(sessionElapsedRatio(kst('08:59:00')), 1);
    assert.equal(sessionElapsedRatio(kst('08:59:59')), 1);
  });

  it('09:00:00은 장 시작 후다 — 1이 아니다', () => {
    /*
     * 2026-07-31 장중 실측으로 잡은 오프바이원. 분 단위 + `<=`이던 때는
     * 09:00:00~09:00:59가 전부 1이었고, 유효 문턱이 하루치 5천만원이라
     * **개장 첫 1분이 15:29보다 엄격했다.**
     */
    assert.equal(sessionElapsedRatio(kst('09:00:00')), 1 / SESSION_SECONDS);
    assert.equal(sessionElapsedRatio(kst('09:00:01')), 1 / SESSION_SECONDS);
  });

  it('같은 09:00분 안에서도 초만큼 늘어난다', () => {
    // 분 해상도로 되돌리면 이 셋이 한 값으로 뭉친다.
    assert.equal(sessionElapsedRatio(kst('09:00:30')), 30 / SESSION_SECONDS);
    assert.equal(sessionElapsedRatio(kst('09:00:59')), 59 / SESSION_SECONDS);
  });

  it('분 경계 값은 예전 계약 그대로다 (60k/23400 = k/390)', () => {
    assert.equal(sessionElapsedRatio(kst('09:01:00')), 1 / 390);
    assert.equal(sessionElapsedRatio(kst('09:05:00')), 5 / 390);
    assert.equal(sessionElapsedRatio(kst('12:15:00')), 0.5);
    assert.equal(sessionElapsedRatio(kst('15:29:00')), 389 / 390);
  });

  it('마감 경계는 그대로 둔다 — 15:30부터 1이다', () => {
    // 실측으로 정상이라 확인된 쪽. 15:29:59까지는 아직 1이 아니다.
    assert.equal(sessionElapsedRatio(kst('15:29:59')), 23_399 / SESSION_SECONDS);
    assert.ok(sessionElapsedRatio(kst('15:29:59')) < 1);
    assert.equal(sessionElapsedRatio(kst('15:30:00')), 1);
    assert.equal(sessionElapsedRatio(kst('15:31:00')), 1);
    assert.equal(sessionElapsedRatio(kst('23:59:59')), 1);
  });

  it('개장 첫 1분이 마감 직전보다 엄격하지 않다', () => {
    /*
     * 버그의 모양을 그대로 못 박는다. 고치기 전에는 09:00:00이 1.0,
     * 09:01:00이 1/390이라 **한 걸음에 390배 계단**이었다.
     */
    const open = sessionElapsedRatio(kst('09:00:00'));
    const nextMinute = sessionElapsedRatio(kst('09:01:00'));
    const beforeClose = sessionElapsedRatio(kst('15:29:00'));
    assert.ok(open < nextMinute, '개장 정각이 1분 뒤보다 커서는 안 된다');
    assert.ok(open < beforeClose / 1000, '개장 정각 문턱은 마감 직전의 1/1000보다도 작아야 한다');
    assert.ok(nextMinute / open < 100, '한 걸음에 100배가 넘는 계단이 있으면 안 된다');
  });

  it('장 안에서는 문턱이 0원이 아니다 — 검사가 사라지면 안 된다', () => {
    /*
     * `<`로만 고치면 09:00대가 0이 되고 `turnover < 0`은 언제나 거짓이라
     * 유동성 검사가 통째로 사라진다. 거래정지 종목(거래대금 0원)까지 통과한다.
     */
    for (const clock of ['09:00:00', '09:00:01', '09:00:30', '09:01:00']) {
      assert.ok(sessionElapsedRatio(kst(clock)) > 0, `${clock}의 문턱이 0이면 안 된다`);
      assert.ok(MIN_DAILY_TURNOVER * sessionElapsedRatio(kst(clock)) >= 2_000, `${clock}`);
    }
  });
});

describe('장 경과 비율 — 후보 거르기에 태워 본다', () => {
  it('개장 정각에도 거래대금 0원은 걸린다', () => {
    // 거래정지 종목이 실제로 이렇게 온다(009310 실측: 현재가 5,330 · 거래량 0).
    const halted = quote({ price: 5_330, accVolume: 0, turnover: 0, high: 0, low: 0 });
    assert.equal(screenQuote(halted, sessionElapsedRatio(kst('09:00:00'))), 'illiquid');
    assert.equal(screenQuote(halted, sessionElapsedRatio(kst('09:00:30'))), 'illiquid');
  });

  it('개장 30초에 6천만원 거래된 종목은 통과한다', () => {
    /*
     * 고치기 전에는 09:00:30의 문턱이 하루치 5천만원이라 이 종목도 아슬아슬했고,
     * 3백만원짜리는 전부 `illiquid`로 버려졌다. 지금 문턱은 64,102원이다.
     */
    const openTick = sessionElapsedRatio(kst('09:00:30'));
    assert.equal(screenQuote(quote({ turnover: 60_000_000 }), openTick), null);
    assert.equal(screenQuote(quote({ turnover: 3_000_000 }), openTick), null);
    // 그래도 문턱 아래는 거른다.
    assert.equal(screenQuote(quote({ turnover: 60_000 }), openTick), 'illiquid');
  });
});
