/**
 * 적정가 계산의 **계약**을 못 박는다.
 *
 * 가장 중요한 것은 **못 낼 때 `null`을 낸다**는 것이다. 짐작으로 숫자를 채우면
 * 판단자가 그것을 사실로 읽고, 그 위에 산 자리는 근거가 없는 자리가 된다.
 *
 * 두 번째는 **띠가 쓸 만한 폭**인가다. 2026-09-03 첫 판에서 KODEX 200이
 * 13,775~218,832원으로 나왔다 — 거의 모든 값이 그 안에 들어 아무것도 판정하지
 * 못했다. 그 회귀를 막는 시험이 아래 「띠가 지수만큼 넓어지지 않는다」다.
 */

import assert from 'node:assert/strict';
import { describe as suite, it } from 'node:test';

import {
  FALLING_GATE, chartBand, classifyAsset, combine, describe, fundamentalBand,
  isFalling, return60,
  type Bar,
} from './fairValue.js';

/** 값이 `base` 둘레에서 `swing` 폭으로 오르내리는 봉을 만든다 */
function bars(count: number, base: number, swing = 0.05): Bar[] {
  const out: Bar[] = [];
  for (let i = 0; i < count; i += 1) {
    const close = base * (1 + Math.sin(i / 7) * swing);
    out.push({
      tradingDay: `2026${String((i % 12) + 1).padStart(2, '0')}${String((i % 28) + 1).padStart(2, '0')}`,
      close, high: close * 1.01, low: close * 0.99,
    });
  }
  return out;
}

suite('차트 축', () => {
  it('표본이 모자라면 짐작하지 않고 null이다', () => {
    assert.equal(chartBand(bars(30, 10_000)), null);
    assert.equal(chartBand([]), null);
  });

  it('띠가 최근 종가 범위 안에 든다', () => {
    const band = chartBand(bars(200, 10_000, 0.05));
    assert.ok(band, '띠를 내야 한다');
    // 값이 9,500~10,500을 오가므로 25~75분위는 그 안이다.
    assert.ok(band.low > 9_000 && band.low < 10_100, `low=${band.low}`);
    assert.ok(band.high > 9_900 && band.high < 11_000, `high=${band.high}`);
    assert.ok(band.low < band.high);
  });

  it('★ 띠가 지수만큼 넓어지지 않는다 — 변동성이 커도 실측 범위 안이다', () => {
    /*
     * 2026-09-03 회귀 시험. 일간 ±6%가 나오는 시장에서 이론적 폭
     * (변동성 × √60 × 2)을 쓰면 띠가 지수 자체만큼 커진다.
     * 실측 분위를 쓰면 **실제로 있었던 값 사이**를 벗어날 수 없다.
     */
    const wild = bars(200, 100_000, 0.30);
    const band = chartBand(wild);
    assert.ok(band);
    const closes = wild.map((b) => b.close);
    assert.ok(band.low >= Math.min(...closes), '띠 아래가 실제 최저보다 낮을 수 없다');
    assert.ok(band.high <= Math.max(...closes), '띠 위가 실제 최고보다 높을 수 없다');
    // 폭이 중앙값의 2배를 넘지 않는다 — 첫 판에서는 15배였다.
    assert.ok((band.high - band.low) / band.mid < 2, `폭 비율 ${(band.high - band.low) / band.mid}`);
  });
});

suite('재무 축', () => {
  const pbr = { low: 0.4, mid: 0.5, high: 0.6 };
  const per = { low: 5, mid: 6, high: 7 };

  it('BPS·EPS가 둘 다 있으면 두 값을 평균한다', () => {
    const band = fundamentalBand({ bps: 100_000, eps: 10_000 }, pbr, per);
    assert.ok(band);
    // BPS 축 40,000~60,000 · EPS 축 50,000~70,000 → 평균 45,000~65,000
    assert.equal(band.low, 45_000);
    assert.equal(band.high, 65_000);
  });

  it('과거 배수를 못 구하면 그 축을 빼고 나머지로 낸다', () => {
    const band = fundamentalBand({ bps: 100_000, eps: 10_000 }, pbr, null);
    assert.ok(band);
    assert.equal(band.low, 40_000, 'BPS 축만 남는다');
  });

  it('★ 재무도 배수도 없으면 null이다 — 12배 같은 값을 짐작해 넣지 않는다', () => {
    assert.equal(fundamentalBand({}, pbr, per), null);
    assert.equal(fundamentalBand({ bps: 100_000 }, null, null), null);
  });

  it('BPS가 0 이하면 쓰지 않는다 — 자본잠식은 배수로 못 잰다', () => {
    assert.equal(fundamentalBand({ bps: -500 }, pbr, null), null);
  });
});

suite('합치기', () => {
  const band = (mid: number) => ({ low: mid * 0.9, mid, high: mid * 1.1, basis: 'x' });

  it('두 축의 중앙값 평균 대비로 gap을 낸다', () => {
    const fv = combine('005930', 'stock', 110, band(100), band(100), []);
    assert.ok(fv.gap !== null);
    assert.ok(Math.abs(fv.gap - 0.1) < 1e-9, `gap=${fv.gap}`);
  });

  it('축이 하나뿐이면 그것으로 낸다', () => {
    const fv = combine('005930', 'stock', 90, band(100), null, ['재무 없음']);
    assert.ok(fv.gap !== null);
    assert.ok(Math.abs(fv.gap + 0.1) < 1e-9);
  });

  it('★★ 축이 하나도 없으면 gap이 null이다 — 0으로 채우지 않는다', () => {
    const fv = combine('005930', 'stock', 100, null, null, ['차트 없음', '재무 없음']);
    assert.equal(fv.gap, null, '"적정가와 같다"와 "모른다"는 다른 사실이다');
    assert.deepEqual(fv.missing, ['차트 없음', '재무 없음']);
  });

  it('현재가가 0이면 gap을 못 낸다', () => {
    assert.equal(combine('005930', 'stock', 0, band(100), null, []).gap, null);
  });
});

suite('사람이 읽을 문장', () => {
  const band = (mid: number) => ({ low: mid * 0.9, mid, high: mid * 1.1, basis: 'x' });

  it('싸다·비싸다를 말로도 적는다 — 부호만 보면 반대로 읽는다', () => {
    assert.match(describe(combine('A', 'stock', 90, band(100), null, []), '가'), /싸다/);
    assert.match(describe(combine('A', 'stock', 110, band(100), null, []), '가'), /비싸다/);
    assert.match(describe(combine('A', 'stock', 100, band(100), null, []), '가'), /비슷하다/);
  });

  it('못 냈으면 사유를 적는다 — 조용히 빠지면 "괜찮은가 보다"로 읽힌다', () => {
    const text = describe(combine('A', 'stock', 100, null, null, ['재무 없음']), '가');
    assert.match(text, /못 냈다/);
    assert.match(text, /재무 없음/);
  });
});

suite('종목 갈래 — 갈래마다 적정가의 뜻이 다르다', () => {
  it('개별 주식은 stock이다', () => {
    assert.equal(classifyAsset('KB금융', 'stock'), 'stock');
    assert.equal(classifyAsset('삼성전자', undefined), 'stock');
  });

  it('광범위 지수 ETF를 가른다', () => {
    assert.equal(classifyAsset('KODEX 200', 'etf'), 'indexEtf');
    assert.equal(classifyAsset('TIGER 미국S&P500', 'etf'), 'indexEtf');
    assert.equal(classifyAsset('KODEX 코스닥150', 'etf'), 'indexEtf');
  });

  it('★ 레버리지·인버스를 지수보다 먼저 본다 — 지수 이름을 달고 온다', () => {
    // "KODEX 200선물인버스2X"는 200이 들어 있어 지수로 샐 수 있다.
    assert.equal(classifyAsset('KODEX 200선물인버스2X', 'etf'), 'leveraged');
    assert.equal(classifyAsset('KODEX 레버리지', 'etf'), 'leveraged');
    assert.equal(classifyAsset('KODEX 인버스', 'etf'), 'leveraged');
    assert.equal(classifyAsset('TIGER SK하이닉스단일종목레버리지', 'etf'), 'leveraged');
  });

  it('원자재·실물은 재무가 성립하지 않는다', () => {
    assert.equal(classifyAsset('ACE KRX금현물', 'etf'), 'commodityEtf');
    assert.equal(classifyAsset('TIGER 원유선물Enhanced(H)', 'etf'), 'commodityEtf');
  });

  it('나머지 ETF는 섹터·테마다', () => {
    assert.equal(classifyAsset('PLUS 고배당주', 'etf'), 'sectorEtf');
    assert.equal(classifyAsset('TIGER 리츠부동산인프라', 'etf'), 'sectorEtf');
    assert.equal(classifyAsset('TIGER K방산&우주', 'etf'), 'sectorEtf');
  });
});

suite('추세 축 — 떨어지는 중인가', () => {
  /** 한 방향으로 곧게 가는 봉 */
  function ramp(count: number, from: number, to: number): Bar[] {
    const out: Bar[] = [];
    for (let i = 0; i < count; i += 1) {
      const close = from + ((to - from) * i) / (count - 1);
      out.push({ tradingDay: `2026${String((i % 12) + 1).padStart(2, '0')}01`, close, high: close, low: close });
    }
    return out;
  }

  it('봉이 모자라면 짐작하지 않고 null이다', () => {
    assert.equal(return60(ramp(40, 100, 90)), null);
    assert.equal(return60([]), null);
  });

  it('60거래일 전 대비로 잰다 — 시작점이 아니다', () => {
    // 121봉: 마지막이 index 120, 60일 전이 index 60.
    const bars = ramp(121, 100, 220);
    const r = return60(bars);
    assert.ok(r !== null);
    // index60 = 160, index120 = 220 → 37.5%
    assert.ok(Math.abs(r - 0.375) < 1e-6, `r=${r}`);
  });

  it('★★ 시장보다 크게 빠졌으면 급락이다 — 절대값이 아니라 상대값이다', () => {
    /*
     * 2026-09-03 회귀. 시장 전체가 60일 −7.6%인 날이었다. 절대 문턱을 쓰면
     * 시장이 빠질 때 전부 걸린다.
     */
    assert.equal(isFalling(FALLING_GATE - 0.01), true);
    assert.equal(isFalling(FALLING_GATE + 0.01), false);
  });

  it('상대값을 모르면 급락이라고 하지 않는다 — 모르는 것은 근거가 아니다', () => {
    assert.equal(isFalling(null), false);
  });

  it('많이 올랐어도 시장이 더 올랐으면 급락일 수 있다', () => {
    // 절대 +10%인데 시장이 +35%면 상대 −25%p다.
    assert.equal(isFalling(0.10 - 0.35), true);
  });
});
