/**
 * 전략 변경 규율 검증.
 *
 * ★ 여기서 못 박는 것은 **어길 유혹이 큰 자리들**이다 — 성과가 나쁠 때 동결을
 *   깨고 싶어지고, 판정이 안 될 때 "일단 유지"가 그럴듯해 보인다. 값으로 박아
 *   두면 그 유혹이 코드 밖에 남는다.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  FREEZE_TRADING_DAYS,
  canChangeNow,
  freezeEndDay,
  judgeOutcome,
  type StrategyVersionState,
} from './strategyVersion.js';

const version = (over: Partial<StrategyVersionState> = {}): StrategyVersionState => ({
  id: 2,
  activeFrom: '2026-08-24',
  freezeUntil: '2026-09-18',
  prediction: { metric: '단기 층 실현손익', expected: 0, horizonDays: 20 },
  previousId: 1,
  ...over,
});

describe('동결 — 관찰이 끝나기 전에는 못 바꾼다', () => {
  it('첫 버전은 언제나 만들 수 있다 — 얼릴 것이 아직 없다', () => {
    assert.deepEqual(canChangeNow(null, '2026-08-24'), { ok: true });
  });

  it('★ 동결 기간 안이면 거부한다', () => {
    const v = canChangeNow(version(), '2026-09-01');
    assert.equal(v.ok, false);
    assert.equal(v.ok === false && v.unfreezesOn, '2026-09-18');
  });

  it('★ 동결 마지막 날에도 아직 못 바꾼다 — 경계를 유리하게 읽지 않는다', () => {
    assert.equal(canChangeNow(version(), '2026-09-18').ok, false);
  });

  it('동결 다음 날부터 바꿀 수 있다', () => {
    assert.deepEqual(canChangeNow(version(), '2026-09-19'), { ok: true });
  });

  it('거부 사유가 무엇을 해야 하는지 말한다 — 막기만 하면 우회한다', () => {
    const v = canChangeNow(version(), '2026-09-01');
    assert.match(v.ok === false ? v.why : '', /기록/);
  });
});

describe('판정 — 되돌리기는 판단이 아니라 규칙이다', () => {
  it('관찰 중에는 손대지 않는다', () => {
    const r = judgeOutcome(version(), '2026-09-01', -1_000_000);
    assert.equal(r.state, 'observing', '기간 안에는 성과가 나빠도 건드리지 않는다');
  });

  it('예측을 넘겼으면 유지한다', () => {
    assert.equal(judgeOutcome(version(), '2026-09-19', 500_000).state, 'keep');
  });

  it('예측과 같으면 유지한다 — 경계는 통과다', () => {
    assert.equal(judgeOutcome(version(), '2026-09-19', 0).state, 'keep');
  });

  it('★ 못 미쳤으면 되돌린다. "조금만 더"가 없다', () => {
    const r = judgeOutcome(version(), '2026-09-19', -1);
    assert.equal(r.state, 'revert');
    assert.equal(r.state === 'revert' ? r.revertTo : undefined, 1);
  });

  it('★★ 지표를 못 쟀으면 유지가 아니라 되돌리기다', () => {
    for (const bad of [null, Number.NaN]) {
      const r = judgeOutcome(version(), '2026-09-19', bad);
      assert.equal(r.state, 'revert', `입력 ${String(bad)}`);
    }
  });

  it('되돌릴 앞 버전이 없으면 대상 없이 되돌리기로 남는다 — 부르는 쪽이 정지시킨다', () => {
    const r = judgeOutcome(version({ previousId: undefined }), '2026-09-19', -1);
    assert.equal(r.state, 'revert');
    assert.equal(r.state === 'revert' ? r.revertTo : 0, undefined);
  });
});

describe('동결 끝 — 달력일이 아니라 거래일로 센다', () => {
  const days = (n: number): string[] =>
    Array.from({ length: n }, (_, i) => `2026-09-${String(i + 1).padStart(2, '0')}`);

  it('20번째 거래일이 동결 끝이다', () => {
    assert.equal(freezeEndDay(days(30)), '2026-09-20');
    assert.equal(FREEZE_TRADING_DAYS, 20);
  });

  it('★ 남은 거래일이 모자라면 정하지 않는다 — 없는 날짜를 지어내지 않는다', () => {
    assert.equal(freezeEndDay(days(5)), null);
  });

  it('연휴가 끼어도 거래일 수는 그대로다', () => {
    // 9/1~9/3 뒤 추석으로 건너뛰어도 20번째 거래일이 동결 끝이다.
    const withHoliday = ['2026-09-01', '2026-09-02', '2026-09-03', ...days(30).slice(10)];
    assert.equal(freezeEndDay(withHoliday, 5), withHoliday[4]);
  });
});
