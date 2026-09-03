/**
 * 판단자 소집 게이트의 **계약**을 못 박는다.
 *
 * 2026-09-03에 이 판정이 두 번 무너졌고 **둘 다 시험이 없어서 로그를 눈으로
 * 읽고 알았다.** 아래 ★★ 둘이 그 회귀를 막는다.
 */

import assert from 'node:assert/strict';
import { describe as suite, it } from 'node:test';

import {
  CHEAP_GATE, RICH_GATE, crossesGate, gateSignature, type GateInput,
} from './judgeGate.js';

const row = (symbol: string, gap: number | null, held = false): GateInput =>
  ({ symbol, gap, held });

suite('문턱', () => {
  it('싸면 부른다 — 보유든 후보든 살 수 있다', () => {
    assert.equal(crossesGate(row('069500', CHEAP_GATE - 0.01, false)), true);
    assert.equal(crossesGate(row('069500', CHEAP_GATE - 0.01, true)), true);
  });

  it('★★ 비싼 것은 **보유일 때만** 부른다 — 공매도를 하지 않는다', () => {
    /*
     * 2026-09-03 회귀. 후보 발굴을 넣자 거래대금 상위 종목이 죄다 비싸서
     * (금호건설 +145%, JW신약 +94%) 매 회차 판단자를 불렀다. 그날 13번 불려
     * 11번이 결정 0건이었다. 안 들고 있는 종목이 비싼 것은 **안 사면 되는 일**이다.
     */
    assert.equal(crossesGate(row('002990', 1.45, false)), false, '후보가 비싼 것은 부를 이유가 아니다');
    assert.equal(crossesGate(row('002990', 1.45, true)), true, '들고 있으면 팔 것인지 봐야 한다');
    assert.equal(crossesGate(row('005930', RICH_GATE + 0.01, false)), false);
  });

  it('문턱 사이는 부르지 않는다', () => {
    assert.equal(crossesGate(row('069500', 0, true)), false);
    assert.equal(crossesGate(row('069500', RICH_GATE - 0.01, true)), false);
    assert.equal(crossesGate(row('069500', CHEAP_GATE + 0.01, true)), false);
  });

  it('적정가를 못 냈으면 부르지 않는다 — 모르는 것은 신호가 아니다', () => {
    assert.equal(crossesGate(row('069500', null, true)), false);
  });
});

suite('시그니처', () => {
  it('★★ gap이 조금 흔들려도 같은 신호다', () => {
    /*
     * 2026-09-03 회귀. 1%p 단위로 적었더니 −9%↔−10%만 오가도 새 신호가 되어
     * 10:35~10:55에 다섯 번을 불렀다. 5%p 칸이면 같은 칸에 든다.
     */
    const a = gateSignature([row('069500', -0.09, true)]);
    const b = gateSignature([row('069500', -0.10, true)]);
    assert.equal(a, b, `${a} vs ${b}`);
  });

  it('충분히 깊어지면 다른 신호다 — 새 정보다', () => {
    assert.notEqual(
      gateSignature([row('069500', -0.08, true)]),
      gateSignature([row('069500', -0.25, true)]),
    );
  });

  it('표의 순서가 바뀌어도 같은 신호다', () => {
    const x = [row('AAA', -0.20, true), row('BBB', -0.30, true)];
    assert.equal(gateSignature(x), gateSignature([...x].reverse()));
  });

  it('넘은 것이 없으면 빈 문자열이다', () => {
    assert.equal(gateSignature([row('069500', 0.01, true)]), '');
  });

  it('★ 문턱을 안 넘은 종목은 시그니처에 안 들어간다', () => {
    // 후보가 아무리 비싸도 흔들려서 새 신호를 만들면 안 된다.
    const sig1 = gateSignature([row('069500', -0.20, true), row('002990', 1.45, false)]);
    const sig2 = gateSignature([row('069500', -0.20, true), row('002990', 1.60, false)]);
    assert.equal(sig1, sig2, '후보의 비싼 정도가 바뀌어도 같은 신호여야 한다');
  });
});
