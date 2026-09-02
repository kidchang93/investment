/**
 * **타이밍과 자산배분을 잰다** — 이 레포가 한 번도 안 잰 축.
 *
 * ── 왜 (2026-09-02) ──────────────────────────────────────────────────────
 *
 * 사용자가 짚었다 — *"전략도 없이 자동매매는 좀 맞지 않는 것 같고, 연 20% 이상의
 * 수익률을 낼 수 있는 전략을 채택해서 특정 사건 혹은 뉴스 브리핑이 있지 않은 이상
 * 자산이 증식되는 걸로 전략을 세우고 그 전략대로 매도 매수를 진행해야겠다."*
 *
 * 원장의 신호 22개를 전부 꺼내 보니 **한 종류였다** — `momentum20`·`reversal5`·
 * `foreign5`·`donchian20`·`rsi14`… 전부 *"오늘 3,900종목 중 무엇을 살까"*다.
 * **"지금 주식에 있어야 하나 현금에 있어야 하나"는 한 번도 안 쟀다.**
 *
 * ★★ 그리고 그것이 16칸 전멸의 진짜 이유일 수 있다 — **비용 구조가 다르다.**
 *
 *     5일 보유    연 50.4 왕복 × 0.43% = 연 21.7%를 비용으로 낸다
 *     월 1회      연 12   왕복 × 0.23% = 연  2.8%
 *     연 4회      연  4   왕복 × 0.23% = 연  0.9%
 *
 * 원장에서 잰 최고 우위가 왕복당 +0.14%였다. 그걸 연 50회 하면 −21%지만
 * 연 4회 하면 남는다. **이길 수 없는 게임판만 21년어치 재고 있었던 것이다.**
 *
 * ── ★★ 세금을 넣는다. 안 넣으면 또 같은 실수다 ──────────────────────────
 *
 * 2026-08-12에 이 레포는 **"ETF에 없는 세금 0.20%를 물리고 있었다"**를 고쳤고,
 * 그때 수익률 판정이 −18.53% → −10.85%로 통째로 바뀌었다. 이번에는 **반대
 * 방향의 같은 실수**가 가능하다:
 *
 *   - `069500`(국내 주식형 ETF)  매매차익 **비과세**
 *   - 그 외 전부(미국·금·채권·레버리지) 매매차익 **15.4% 과세**
 *
 * 자산배분은 정의상 이 자산들을 오간다. 세금을 빼면 **연 20%가 세후 17%**가
 * 되는데, 그 차이를 모른 채로 "연 20% 전략을 찾았다"고 적으면 거짓이 된다.
 * 매도할 때 이익이 났으면 그 이익의 15.4%를 뺀다.
 *
 * ★ 손실 상계는 넣지 않았다(같은 해 다른 ETF 손실과 통산 가능). **보수적인
 *   쪽으로 틀린다** — 실제 세금은 여기 계산보다 적거나 같다.
 *
 * ── 파라미터를 우리가 고르지 않는다 ──────────────────────────────────────
 *
 * 200일·10개월·12개월은 **문헌에 이미 있는 값**이다(Faber 2007, Antonacci 2014,
 * Keller 2017). 우리가 격자를 훑어 고르면 그 순간 과최적화가 되고, 이 레포가
 * `gate-arithmetic`에서 배운 것이 정확히 그것이다.
 *
 * 대신 **구간을 잘라 확인한다** — 전반에서 좋았던 것이 후반에도 좋은가.
 * 전략 12개를 재면 그중 하나는 우연히 좋으므로, 전체 성과만으로 고르지 않는다.
 *
 * ── 살 수 없는 가격으로 재지 않는다 ──────────────────────────────────────
 *
 * 2026-08-12에 **종가로 점수를 내고 그 종가에 사고 있었다**(`7f3ac08`). 원장
 * 176줄 전부가 그 위에 있었다. 여기서는 **월말 종가로 판단하고 다음 거래일
 * 시가에 체결**한다.
 *
 * 조회 전용이다. 주문을 내지 않는다.
 *
 *   npx tsx src/scripts/measureAssetTiming.ts [--from 20050301] [--csv]
 */

import { closeDb } from '../db/client.js';
import { getDailyBars, type DailyBar } from '../db/dailyBars.js';

// ── 자산 ────────────────────────────────────────────────────────────────

interface AssetSpec {
  symbol: string;
  name: string;
  /**
   * 매매차익에 15.4%가 붙나. **국내 주식형 ETF만 면제**다.
   * 해외지수·채권·원자재·파생형은 보유기간 과세 대상이다.
   */
  taxOnGain: boolean;
}

const ASSETS: Record<string, AssetSpec> = {
  __CASH__: { symbol: '__CASH__', name: '현금(무이자)', taxOnGain: false },
  // 주식 — 국내만 매매차익 비과세다
  '069500': { symbol: '069500', name: 'KODEX 200', taxOnGain: false },
  '122630': { symbol: '122630', name: 'KODEX 레버리지', taxOnGain: true },
  '133690': { symbol: '133690', name: 'TIGER 미국나스닥100', taxOnGain: true },
  '099140': { symbol: '099140', name: 'KODEX 차이나H', taxOnGain: true },
  '101280': { symbol: '101280', name: 'KODEX 일본TOPIX100', taxOnGain: true },
  '105010': { symbol: '105010', name: 'TIGER 라틴35', taxOnGain: true },
  // 주식이 아닌 것 — 주식 둘이 함께 빠질 때 갈 곳
  '132030': { symbol: '132030', name: 'KODEX 골드선물', taxOnGain: true },
  '130680': { symbol: '130680', name: 'TIGER 원유선물', taxOnGain: true },
  // 안전자산 — 국고채3년이 2009-07부터라 단기채권(2012-02)보다 4년 길다
  '114260': { symbol: '114260', name: 'KODEX 국고채3년', taxOnGain: true },
  '153130': { symbol: '153130', name: 'KODEX 단기채권', taxOnGain: true },
};

/** 위험자산 후보를 늘린 묶음. 다자산 듀얼 모멘텀이 쓴다 */
const RISKY_WIDE = ['069500', '133690', '099140', '101280', '105010'];
/** 거기에 주식이 아닌 것까지 */
const RISKY_ALL = [...RISKY_WIDE, '132030', '130680'];
/** 방어자산. 무이자 현금이 아니라 국고채다 — 실제로 그렇게 한다 */
const BOND = '114260';

/**
 * 안전자산 자리. **무이자 현금**이다.
 *
 * ★ 처음에는 단기채권 ETF(`153130`)를 썼는데 그것이 2012-02부터라 **모든 전략이
 *   14.5년으로 잘렸다.** 그러면 21.5년짜리 매수후보유와 **같은 구간에서 비교할 수
 *   없다** — "더 낫다"고 말할 근거가 사라진다. 무이자 현금으로 두면 069500만 쓰는
 *   전략은 21.5년을 다 쓴다.
 *
 * ★ 그리고 **보수적인 쪽으로 틀린다**: 실제로는 단기채권 ETF나 파킹통장에 두면
 *   연 2~3%가 붙는다. 여기 결과는 그만큼 낮게 나온다.
 */
const CASH_ASSET = '__CASH__';
const SAFE = CASH_ASSET;

/**
 * 왕복이 아니라 **한 방향** 비용이다. 리밸런싱은 팔고 사는 것이 짝이 아닐 수
 * 있어(비중만 조정) 방향별로 문다.
 *
 * 수수료 0.015% + 슬리피지 0.1%. ETF는 매도 거래세가 면제라 그것만이다.
 * `DEFAULT_COSTS`와 같은 값이다.
 */
const ONE_WAY_COST = 0.00015 + 0.001;

/** 국내 주식형이 아닌 ETF의 매매차익 세율 */
const GAIN_TAX = 0.154;

// ── 전략 ────────────────────────────────────────────────────────────────

interface Ctx {
  /** 이 월말까지의 종가 계열. **미래는 들어 있지 않다** */
  closes: Map<string, number[]>;
  /** 지금 인덱스(그 계열의 마지막 자리) */
  i: number;
}

interface StrategySpec {
  key: string;
  label: string;
  /** 어디서 온 규칙인가. 우리가 지어낸 것이 아님을 밝힌다 */
  source: string;
  assets: string[];
  /** 월말에 다음 달 목표 비중. 합이 1이 아니면 나머지는 안전자산 */
  weights(ctx: Ctx): Map<string, number>;
}

/** `n`거래일 전 대비 수익률. 자료가 모자라면 `null` */
function ret(closes: number[], i: number, n: number): number | null {
  if (i - n < 0) return null;
  const past = closes[i - n];
  if (!(past > 0)) return null;
  return closes[i] / past - 1;
}

/** `n`거래일 단순이동평균 */
function sma(closes: number[], i: number, n: number): number | null {
  if (i - n + 1 < 0) return null;
  let sum = 0;
  for (let k = i - n + 1; k <= i; k += 1) sum += closes[k];
  return sum / n;
}

/** 최근 `n`거래일 일간수익률 표준편차(연율화 안 함) */
function vol(closes: number[], i: number, n: number): number | null {
  if (i - n < 0) return null;
  const rs: number[] = [];
  for (let k = i - n + 1; k <= i; k += 1) {
    if (closes[k - 1] > 0) rs.push(closes[k] / closes[k - 1] - 1);
  }
  if (rs.length < 2) return null;
  const mean = rs.reduce((a, b) => a + b, 0) / rs.length;
  const v = rs.reduce((a, b) => a + (b - mean) ** 2, 0) / (rs.length - 1);
  return Math.sqrt(v);
}

const ONE = (symbol: string): Map<string, number> => new Map([[symbol, 1]]);
const CASH = (): Map<string, number> => new Map([[SAFE, 1]]);

/**
 * ★ 12개월 = 252거래일, 10개월 = 210, 6개월 = 126, 200일 = 200.
 *   전부 문헌값이다. 여기서 격자를 훑지 않는다.
 */
const STRATEGIES: StrategySpec[] = [
  {
    key: 'buyHold',
    label: '매수 후 보유 (KODEX 200)',
    source: '기준선 — 아무것도 안 하는 것',
    assets: ['069500'],
    weights: () => ONE('069500'),
  },
  {
    key: 'buyHoldLev',
    label: '매수 후 보유 (레버리지)',
    source: '기준선 — 2배를 그냥 들고 있으면',
    assets: ['122630'],
    weights: () => ONE('122630'),
  },
  {
    key: 'sma200',
    label: '200일 이동평균 타이밍',
    source: 'Faber(2007) 일별 판 — 위면 보유, 아래면 현금',
    assets: ['069500', SAFE],
    weights: ({ closes, i }) => {
      const c = closes.get('069500')!;
      const m = sma(c, i, 200);
      if (m === null) return CASH();
      return c[i] > m ? ONE('069500') : CASH();
    },
  },
  {
    key: 'sma10m',
    label: '10개월 이동평균 타이밍',
    source: 'Faber(2007) 원본 — 10개월(210거래일)',
    assets: ['069500', SAFE],
    weights: ({ closes, i }) => {
      const c = closes.get('069500')!;
      const m = sma(c, i, 210);
      if (m === null) return CASH();
      return c[i] > m ? ONE('069500') : CASH();
    },
  },
  {
    key: 'absMom12',
    label: '절대 모멘텀 12개월',
    source: 'Antonacci — 12개월 수익률이 양수면 보유',
    assets: ['069500', SAFE],
    weights: ({ closes, i }) => {
      const r = ret(closes.get('069500')!, i, 252);
      if (r === null) return CASH();
      return r > 0 ? ONE('069500') : CASH();
    },
  },
  {
    key: 'absMom6',
    label: '절대 모멘텀 6개월',
    source: '같은 규칙의 짧은 축 — 반응이 빠른 쪽',
    assets: ['069500', SAFE],
    weights: ({ closes, i }) => {
      const r = ret(closes.get('069500')!, i, 126);
      if (r === null) return CASH();
      return r > 0 ? ONE('069500') : CASH();
    },
  },
  {
    key: 'goldenCross',
    label: '골든크로스 (50/200일)',
    source: '가장 널리 알려진 규칙 — 안 재보고 넘어가지 않는다',
    assets: ['069500', SAFE],
    weights: ({ closes, i }) => {
      const c = closes.get('069500')!;
      const fast = sma(c, i, 50);
      const slow = sma(c, i, 200);
      if (fast === null || slow === null) return CASH();
      return fast > slow ? ONE('069500') : CASH();
    },
  },
  {
    key: 'dualMomentum',
    label: '듀얼 모멘텀 (국내/미국)',
    source: 'Antonacci GEM — 둘 중 12개월 수익률 높은 쪽, 둘 다 음수면 채권',
    assets: ['069500', '133690', SAFE],
    weights: ({ closes, i }) => {
      const kr = ret(closes.get('069500')!, i, 252);
      const us = ret(closes.get('133690')!, i, 252);
      if (kr === null || us === null) return CASH();
      const best = kr >= us ? '069500' : '133690';
      const bestRet = Math.max(kr, us);
      return bestRet > 0 ? ONE(best) : CASH();
    },
  },
  {
    key: 'dualMomentumGold',
    label: '듀얼 모멘텀 + 금',
    source: '같은 규칙에 금을 후보로 — 주식 둘이 함께 빠질 때 갈 곳',
    assets: ['069500', '133690', '132030', SAFE],
    weights: ({ closes, i }) => {
      const cands: Array<[string, number]> = [];
      for (const s of ['069500', '133690', '132030']) {
        const r = ret(closes.get(s)!, i, 252);
        if (r === null) return CASH();
        cands.push([s, r]);
      }
      cands.sort((a, b) => b[1] - a[1]);
      return cands[0][1] > 0 ? ONE(cands[0][0]) : CASH();
    },
  },
  {
    key: 'vaa4',
    label: 'VAA 계열 (모멘텀 점수)',
    source: 'Keller(2017) — 1·3·6·12개월 가중 점수, 하나라도 음수면 방어',
    assets: ['069500', '133690', '132030', SAFE],
    weights: ({ closes, i }) => {
      const score = (s: string): number | null => {
        const c = closes.get(s)!;
        const r1 = ret(c, i, 21);
        const r3 = ret(c, i, 63);
        const r6 = ret(c, i, 126);
        const r12 = ret(c, i, 252);
        if (r1 === null || r3 === null || r6 === null || r12 === null) return null;
        // 12·4·2·1 가중은 Keller의 원식이다.
        return 12 * r1 + 4 * r3 + 2 * r6 + 1 * r12;
      };
      const risky = ['069500', '133690', '132030'];
      const scored: Array<[string, number]> = [];
      for (const s of risky) {
        const v = score(s);
        if (v === null) return CASH();
        scored.push([s, v]);
      }
      // 하나라도 음수면 전부 방어로 — VAA의 핵심이 이 "경보" 규칙이다.
      if (scored.some(([, v]) => v < 0)) return CASH();
      scored.sort((a, b) => b[1] - a[1]);
      return ONE(scored[0][0]);
    },
  },
  {
    key: 'dualMomWide',
    label: '다자산 듀얼 모멘텀 (5개국)',
    source: '같은 규칙, 후보만 국내·미국·중국·일본·신흥국으로 — 갈 곳이 많으면 나은가',
    assets: [...RISKY_WIDE, BOND],
    weights: ({ closes, i }) => {
      const scored: Array<[string, number]> = [];
      for (const s of RISKY_WIDE) {
        const r = ret(closes.get(s)!, i, 252);
        if (r === null) return ONE(BOND);
        scored.push([s, r]);
      }
      scored.sort((a, b) => b[1] - a[1]);
      return scored[0][1] > 0 ? ONE(scored[0][0]) : ONE(BOND);
    },
  },
  {
    key: 'dualMomWideTop2',
    label: '다자산 듀얼 모멘텀 상위 2',
    source: '1등에 몰지 않고 둘로 나눈다 — 한 나라에 전부 거는 위험을 줄이려는 변형',
    assets: [...RISKY_WIDE, BOND],
    weights: ({ closes, i }) => {
      const scored: Array<[string, number]> = [];
      for (const s of RISKY_WIDE) {
        const r = ret(closes.get(s)!, i, 252);
        if (r === null) return ONE(BOND);
        scored.push([s, r]);
      }
      scored.sort((a, b) => b[1] - a[1]);
      const picked = scored.slice(0, 2).filter(([, r]) => r > 0);
      if (picked.length === 0) return ONE(BOND);
      const w = 1 / 2;
      const map = new Map<string, number>(picked.map(([sym]) => [sym, w]));
      // 하나만 양수면 나머지 절반은 채권으로 — 억지로 음수 자산을 사지 않는다
      if (picked.length === 1) map.set(BOND, w);
      return map;
    },
  },
  {
    key: 'dualMomAll',
    label: '전 자산 듀얼 모멘텀 (주식+금+원유)',
    source: '후보를 최대로 — 주식이 다 빠질 때 실물이 받아 주나',
    assets: [...RISKY_ALL, BOND],
    weights: ({ closes, i }) => {
      const scored: Array<[string, number]> = [];
      for (const s of RISKY_ALL) {
        const r = ret(closes.get(s)!, i, 252);
        if (r === null) return ONE(BOND);
        scored.push([s, r]);
      }
      scored.sort((a, b) => b[1] - a[1]);
      return scored[0][1] > 0 ? ONE(scored[0][0]) : ONE(BOND);
    },
  },
  {
    key: 'dualMomAccel',
    label: '가속 듀얼 모멘텀 (1·3·6개월)',
    source: 'Antonacci 변형 — 12개월 하나가 아니라 짧은 축 셋의 평균으로 고른다',
    assets: [...RISKY_WIDE, BOND],
    weights: ({ closes, i }) => {
      const scored: Array<[string, number]> = [];
      for (const s of RISKY_WIDE) {
        const c = closes.get(s)!;
        const r1 = ret(c, i, 21);
        const r3 = ret(c, i, 63);
        const r6 = ret(c, i, 126);
        if (r1 === null || r3 === null || r6 === null) return ONE(BOND);
        scored.push([s, (r1 + r3 + r6) / 3]);
      }
      scored.sort((a, b) => b[1] - a[1]);
      return scored[0][1] > 0 ? ONE(scored[0][0]) : ONE(BOND);
    },
  },
  {
    key: 'dualMomBond',
    label: '듀얼 모멘텀 (국내/미국) · 방어=국채',
    source: '이긴 규칙 그대로, 방어만 현금 대신 국고채 — 쉬는 동안에도 이자를 받는다',
    assets: ['069500', '133690', BOND],
    weights: ({ closes, i }) => {
      const kr = ret(closes.get('069500')!, i, 252);
      const us = ret(closes.get('133690')!, i, 252);
      if (kr === null || us === null) return ONE(BOND);
      const best = kr >= us ? '069500' : '133690';
      return Math.max(kr, us) > 0 ? ONE(best) : ONE(BOND);
    },
  },
  {
    key: 'dualMomLev',
    label: '듀얼 모멘텀 · 국내일 때 레버리지',
    source: '이긴 규칙에 노출을 얹는다 — 국내를 고른 달에만 2배 ETF를 산다',
    assets: ['069500', '133690', '122630', BOND],
    weights: ({ closes, i }) => {
      const kr = ret(closes.get('069500')!, i, 252);
      const us = ret(closes.get('133690')!, i, 252);
      if (kr === null || us === null) return ONE(BOND);
      if (Math.max(kr, us) <= 0) return ONE(BOND);
      return kr >= us ? ONE('122630') : ONE('133690');
    },
  },
  {
    key: 'riskParity',
    label: '위험균형 (변동성 역가중)',
    source: '변동성이 낮은 자산에 더 싣는다 — 월 리밸런싱',
    assets: ['069500', '133690', '132030', '153130'],
    weights: ({ closes, i }) => {
      const parts: Array<[string, number]> = [];
      for (const s of ['069500', '133690', '132030', '153130']) {
        const v = vol(closes.get(s)!, i, 126);
        if (v === null || v <= 0) return CASH();
        parts.push([s, 1 / v]);
      }
      const total = parts.reduce((a, [, w]) => a + w, 0);
      return new Map(parts.map(([s, w]) => [s, w / total]));
    },
  },
  {
    key: 'equalWeight',
    label: '동일가중 4자산',
    source: '기준선 — 고르지 않고 넷을 똑같이',
    assets: ['069500', '133690', '132030', '153130'],
    weights: () => new Map([
      ['069500', 0.25], ['133690', 0.25], ['132030', 0.25], ['153130', 0.25],
    ]),
  },
  {
    key: 'sma200Lev',
    label: '200일 타이밍 → 레버리지',
    source: '같은 신호로 2배 ETF를 산다. **낙폭을 줄인 뒤 노출을 키우는 것**이 연 20%의 유일한 길이라는 가설',
    assets: ['122630', SAFE, '069500'],
    weights: ({ closes, i }) => {
      // 신호는 지수(069500)로 낸다 — 레버리지 자체의 이동평균은 변동성 끌림에 오염된다.
      const c = closes.get('069500')!;
      const m = sma(c, i, 200);
      if (m === null) return CASH();
      return c[i] > m ? ONE('122630') : CASH();
    },
  },
  {
    key: 'absMom12Lev',
    label: '절대 모멘텀 12개월 → 레버리지',
    source: '같은 가설, 다른 신호',
    assets: ['122630', SAFE, '069500'],
    weights: ({ closes, i }) => {
      const r = ret(closes.get('069500')!, i, 252);
      if (r === null) return CASH();
      return r > 0 ? ONE('122630') : CASH();
    },
  },
];

// ── 시뮬레이션 ──────────────────────────────────────────────────────────

interface Position {
  quantity: number;
  /** 평균 취득가. 세금 계산에 쓴다 */
  cost: number;
}

/**
 * 자산 시계열의 한 구간에서 지표를 낸다.
 *
 * ★ **시뮬레이션은 전체 구간으로 돌리고 측정만 잘라 낸다.** 전반만 따로 돌리면
 *   워밍업(252일)이 구간 안을 먹어 표본이 줄고, 후반만 돌리면 그 시작에 이미
 *   들고 있던 자리를 새로 사는 것으로 잡혀 비용이 지어진다.
 */
function metrics(equity: number[], a: number, b: number): { cagr: number; mdd: number; sharpe: number } {
  if (b <= a + 20) return { cagr: 0, mdd: 0, sharpe: 0 };
  const years = (b - a) / 246;
  const cagr = (equity[b] / equity[a]) ** (1 / years) - 1;
  let peak = equity[a];
  let mdd = 0;
  for (let i = a; i <= b; i += 1) {
    if (equity[i] > peak) peak = equity[i];
    const dd = equity[i] / peak - 1;
    if (dd < mdd) mdd = dd;
  }
  const rs: number[] = [];
  for (let i = a + 1; i <= b; i += 1) rs.push(equity[i] / equity[i - 1] - 1);
  const mean = rs.reduce((x, y) => x + y, 0) / rs.length;
  const sd = Math.sqrt(rs.reduce((x, y) => x + (y - mean) ** 2, 0) / (rs.length - 1));
  return { cagr, mdd, sharpe: sd > 0 ? (mean / sd) * Math.sqrt(246) : 0 };
}

/** 한 구간의 전략 대 기준선 */
interface Half {
  from: string;
  to: string;
  cagr: number;
  benchCagr: number;
  mdd: number;
}

interface RunResult {
  key: string;
  label: string;
  source: string;
  from: string;
  to: string;
  years: number;
  cagr: number;
  mdd: number;
  sharpe: number;
  tradesPerYear: number;
  totalCost: number;
  totalTax: number;
  /**
   * ★★ **같은 구간의 KODEX 200 매수후보유.** 이것이 없으면 "더 낫다"고 말할 수
   *    없다 — 전략마다 시작일이 다르므로 전체 표의 다른 줄과는 비교가 안 된다.
   *    2026-09-02 첫 실행에서 듀얼 모멘텀 18.36%를 21.5년 매수후보유 12.62%와
   *    나란히 놓을 뻔했다. **구간이 7년 다르다.**
   */
  benchCagr: number;
  benchMdd: number;
  /**
   * ★★ **구간을 반으로 갈라 본다.** 13개를 재면 그중 하나는 우연히 좋다 —
   *    전체 성과만으로 고르면 그 하나를 고르게 된다. 전반에서도 후반에서도
   *    기준선을 이겨야 규칙으로 채택할 수 있다.
   */
  first: Half;
  second: Half;
  /** 비용·세금을 안 뺐다면 얼마였나 — 그 둘이 얼마나 먹었는지 본다 */
  cagrGross: number;
  finalEquity: number;
}

interface Series {
  days: string[];
  open: Map<string, number[]>;
  close: Map<string, number[]>;
}

/**
 * 한 전략을 돌린다. **월말 종가로 판단하고 다음 거래일 시가에 체결한다.**
 */
function run(
  spec: StrategySpec,
  series: Series,
  monthEnds: number[],
  startCash: number,
  benchmark: { days: string[]; close: number[] },
): RunResult | null {
  const { days, open, close } = series;

  // 이 전략에 필요한 자산이 모두 있는 첫 자리부터 시작한다.
  for (const s of spec.assets) {
    if (!close.has(s)) return null;
  }

  const positions = new Map<string, Position>();
  let cash = startCash;
  let totalCost = 0;
  let totalTax = 0;
  let trades = 0;

  const equityByDay: number[] = [];
  const equityDays: string[] = [];
  let started = false;
  let startIndex = 0;

  const valueAt = (i: number): number => {
    let v = cash;
    for (const [s, p] of positions) v += p.quantity * close.get(s)![i];
    return v;
  };

  // 월말 인덱스를 집합으로 두고 매일 훑는다 — 일별 자산가치가 있어야 MDD를 잰다.
  const rebalanceOn = new Set<number>();
  for (const m of monthEnds) if (m + 1 < days.length) rebalanceOn.add(m);

  for (let i = 0; i < days.length; i += 1) {
    if (rebalanceOn.has(i)) {
      const target = spec.weights({ closes: close, i });
      // 워밍업이 안 끝나 계산이 안 되면 아직 시작하지 않는다.
      const usable = [...target.keys()].every((s) => close.has(s));
      if (usable) {
        if (!started) {
          started = true;
          startIndex = i + 1;
        }
        // ★ **다음 거래일 시가**에 맞춘다. 판단한 값에 그대로 사지 않는다.
        const execIndex = i + 1;
        const priceOf = (s: string): number => open.get(s)![execIndex];

        let equity = cash;
        for (const [s, p] of positions) equity += p.quantity * priceOf(s);

        // 팔 것 먼저 — 현금을 만들어야 산다.
        for (const [s, p] of [...positions]) {
          const w = target.get(s) ?? 0;
          const wantQty = (equity * w) / priceOf(s);
          if (wantQty >= p.quantity) continue;
          const sellQty = p.quantity - wantQty;
          const price = priceOf(s);
          const gross = sellQty * price;
          const fee = gross * ONE_WAY_COST;
          const gain = sellQty * (price - p.cost);
          const tax = ASSETS[s].taxOnGain && gain > 0 ? gain * GAIN_TAX : 0;
          cash += gross - fee - tax;
          totalCost += fee;
          totalTax += tax;
          trades += 1;
          const left = p.quantity - sellQty;
          if (left <= 1e-9) positions.delete(s);
          else positions.set(s, { quantity: left, cost: p.cost });
        }

        // 그다음 살 것.
        for (const [s, w] of target) {
          if (w <= 0) continue;
          const price = priceOf(s);
          const have = positions.get(s)?.quantity ?? 0;
          const wantQty = (equity * w) / price;
          if (wantQty <= have + 1e-9) continue;
          const buyQty = wantQty - have;
          const gross = buyQty * price;
          const fee = gross * ONE_WAY_COST;
          if (gross + fee > cash + 1e-6) {
            // 현금이 모자라면 있는 만큼만 산다. 빚을 내지 않는다.
            const affordable = cash / (price * (1 + ONE_WAY_COST));
            if (affordable <= 1e-9) continue;
            const g2 = affordable * price;
            const f2 = g2 * ONE_WAY_COST;
            cash -= g2 + f2;
            totalCost += f2;
            trades += 1;
            const prev = positions.get(s);
            const newQty = (prev?.quantity ?? 0) + affordable;
            const newCost = prev
              ? (prev.quantity * prev.cost + affordable * price) / newQty
              : price;
            positions.set(s, { quantity: newQty, cost: newCost });
            continue;
          }
          cash -= gross + fee;
          totalCost += fee;
          trades += 1;
          const prev = positions.get(s);
          const newQty = (prev?.quantity ?? 0) + buyQty;
          const newCost = prev
            ? (prev.quantity * prev.cost + buyQty * price) / newQty
            : price;
          positions.set(s, { quantity: newQty, cost: newCost });
        }
      }
    }
    if (started && i >= startIndex) {
      equityByDay.push(valueAt(i));
      equityDays.push(days[i]);
    }
  }

  if (equityByDay.length < 250) return null;

  // ── 지표 ──
  const finalEquity = equityByDay[equityByDay.length - 1];
  const years = equityByDay.length / 246;
  const cagr = (finalEquity / startCash) ** (1 / years) - 1;

  let peak = equityByDay[0];
  let mdd = 0;
  for (const v of equityByDay) {
    if (v > peak) peak = v;
    const dd = v / peak - 1;
    if (dd < mdd) mdd = dd;
  }

  const rs: number[] = [];
  for (let i = 1; i < equityByDay.length; i += 1) {
    rs.push(equityByDay[i] / equityByDay[i - 1] - 1);
  }
  const mean = rs.reduce((a, b) => a + b, 0) / rs.length;
  const sd = Math.sqrt(rs.reduce((a, b) => a + (b - mean) ** 2, 0) / (rs.length - 1));
  const sharpe = sd > 0 ? (mean / sd) * Math.sqrt(246) : 0;

  // 비용·세금이 없었다면 — 둘이 얼마나 먹었는지 크기를 본다.
  const grossFinal = finalEquity + totalCost + totalTax;
  const cagrGross = (grossFinal / startCash) ** (1 / years) - 1;

  // 같은 구간에서 069500을 그냥 들고 있었다면. 비용은 살 때 한 번만 문다.
  const benchClose = benchmark.close;
  const benchDays = benchmark.days;
  const b0 = benchDays.indexOf(equityDays[0]);
  const b1 = benchDays.indexOf(equityDays[equityDays.length - 1]);
  let benchCagr = 0;
  let benchMdd = 0;
  if (b0 >= 0 && b1 > b0) {
    const shares = (startCash * (1 - ONE_WAY_COST)) / benchClose[b0];
    let bPeak = shares * benchClose[b0];
    for (let i = b0; i <= b1; i += 1) {
      const v = shares * benchClose[i];
      if (v > bPeak) bPeak = v;
      const dd = v / bPeak - 1;
      if (dd < benchMdd) benchMdd = dd;
    }
    const bFinal = shares * benchClose[b1];
    benchCagr = (bFinal / startCash) ** (1 / years) - 1;
  }

  // ── 구간 분할 ──
  const mid = Math.floor(equityByDay.length / 2);
  const benchEquity: number[] = [];
  if (b0 >= 0 && b1 > b0) {
    const shares = (startCash * (1 - ONE_WAY_COST)) / benchClose[b0];
    for (let i = b0; i <= b1; i += 1) benchEquity.push(shares * benchClose[i]);
  }
  const halfOf = (a: number, b: number): Half => {
    const m = metrics(equityByDay, a, b);
    const bm = benchEquity.length === equityByDay.length
      ? metrics(benchEquity, a, b)
      : { cagr: 0, mdd: 0, sharpe: 0 };
    return { from: equityDays[a], to: equityDays[b], cagr: m.cagr, benchCagr: bm.cagr, mdd: m.mdd };
  };
  const first = halfOf(0, mid);
  const second = halfOf(mid, equityByDay.length - 1);

  return {
    key: spec.key,
    label: spec.label,
    source: spec.source,
    first,
    second,
    from: equityDays[0],
    to: equityDays[equityDays.length - 1],
    years,
    cagr,
    mdd,
    sharpe,
    tradesPerYear: trades / years,
    totalCost,
    totalTax,
    benchCagr,
    benchMdd,
    cagrGross,
    finalEquity,
  };
}

// ── 자료 준비 ───────────────────────────────────────────────────────────

async function loadSeries(symbols: string[], from: string): Promise<Series> {
  // 현금은 DB에 없다. 실제 자산의 거래일에 맞춰 가격 1로 만들어 낸다.
  const real = symbols.filter((s) => s !== CASH_ASSET);
  const bars = new Map<string, DailyBar[]>();
  for (const s of real) {
    bars.set(s, await getDailyBars(s, { from }));
  }
  // 모든 자산에 봉이 있는 날만 쓴다 — 없는 날을 앞 값으로 메우면 그날 못 산 것을 샀다고 적게 된다.
  const counts = new Map<string, number>();
  for (const list of bars.values()) {
    for (const b of list) counts.set(b.tradingDay, (counts.get(b.tradingDay) ?? 0) + 1);
  }
  const days = [...counts.entries()]
    .filter(([, n]) => n === real.length)
    .map(([d]) => d)
    .sort();

  const open = new Map<string, number[]>();
  const close = new Map<string, number[]>();
  for (const s of real) {
    const byDay = new Map(bars.get(s)!.map((b) => [b.tradingDay, b]));
    open.set(s, days.map((d) => byDay.get(d)!.open));
    close.set(s, days.map((d) => byDay.get(d)!.close));
  }
  if (symbols.includes(CASH_ASSET)) {
    const ones = days.map(() => 1);
    open.set(CASH_ASSET, ones);
    close.set(CASH_ASSET, ones);
  }
  return { days, open, close };
}

/** 각 달의 마지막 거래일 인덱스 */
function monthEndIndices(days: string[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < days.length - 1; i += 1) {
    if (days[i].slice(0, 6) !== days[i + 1].slice(0, 6)) out.push(i);
  }
  return out;
}

// ── 출력 ────────────────────────────────────────────────────────────────

const pct = (v: number, digits = 2): string => `${(v * 100).toFixed(digits)}%`;

function printTable(title: string, results: RunResult[]): void {
  console.log(`\n${title}`);
  console.log('─'.repeat(108));
  console.log(
    ' 전략'.padEnd(27)
    + '연복리'.padStart(9)
    + '초과(전체)'.padStart(12)
    + '전반'.padStart(9)
    + '후반'.padStart(9)
    + '최대낙폭'.padStart(11)
    + '샤프'.padStart(7)
    + '매매/년'.padStart(8)
    + '세금'.padStart(10),
  );
  console.log('  ★ = 전반·후반 **둘 다** 기준선(같은 구간 KODEX 200 보유)을 이겼다');
  console.log('─'.repeat(104));
  for (const r of results) {
    const excess = r.cagr - r.benchCagr;
    const e1 = r.first.cagr - r.first.benchCagr;
    const e2 = r.second.cagr - r.second.benchCagr;
    // ★ 둘 다 이겨야 별을 준다. 전체 성과만 좋은 것은 우연일 수 있다.
    const both = e1 > 0 && e2 > 0 ? '★' : ' ';
    const sign = (v: number): string => `${v > 0 ? '+' : ''}${pct(v, 1)}`;
    console.log(
      `${both}${r.label.slice(0, 25).padEnd(26)}`
      + pct(r.cagr).padStart(9)
      + sign(excess).padStart(10)
      + sign(e1).padStart(10)
      + sign(e2).padStart(10)
      + pct(r.mdd).padStart(11)
      + r.sharpe.toFixed(2).padStart(7)
      + r.tradesPerYear.toFixed(1).padStart(8)
      + `${Math.round(r.totalTax / 10000).toLocaleString('ko-KR')}만`.padStart(10),
    );
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const fromArg = args.indexOf('--from');
  const from = fromArg >= 0 ? args[fromArg + 1] : '20050101';

  const symbols = Object.keys(ASSETS).filter((s) => s !== CASH_ASSET);
  console.log('타이밍·자산배분 측정 — 이 레포가 안 잰 축\n');
  console.log('자산');
  for (const s of symbols) {
    const bars = await getDailyBars(s, { from });
    const tax = ASSETS[s].taxOnGain ? '매매차익 15.4% 과세' : '매매차익 비과세(국내 주식형)';
    console.log(
      `  ${s} ${ASSETS[s].name.padEnd(20)} ${bars.length.toString().padStart(5)}봉`
      + ` ${bars[0]?.tradingDay ?? '-'}~${bars[bars.length - 1]?.tradingDay ?? '-'}  ${tax}`,
    );
  }
  console.log(`\n왕복 비용 ${pct(ONE_WAY_COST * 2, 2)} (수수료+슬리피지, ETF는 매도세 면제)`);
  console.log('월말 종가로 판단하고 **다음 거래일 시가**에 체결한다 — 판단한 값에 그대로 사지 않는다.');

  const startCash = 100_000_000;

  // 전략마다 필요한 자산이 다르다. 그 자산들의 공통 구간에서 각자 돈다.
  // ★ 기준선은 **한 번만** 만든다. 069500 전체 계열을 들고 다니며 각 전략의
  //   실제 구간을 잘라 쓴다 — 그래야 "같은 구간에서 더 나은가"를 답할 수 있다.
  const benchBars = await getDailyBars('069500', { from });
  const benchmark = {
    days: benchBars.map((b) => b.tradingDay),
    close: benchBars.map((b) => b.close),
  };

  const all: RunResult[] = [];
  for (const spec of STRATEGIES) {
    const need = [...new Set(spec.assets)];
    const series = await loadSeries(need, from);
    if (series.days.length < 300) continue;
    const result = run(spec, series, monthEndIndices(series.days), startCash, benchmark);
    if (result) all.push(result);
  }

  // 구간이 다른 것을 한 표에 놓으면 비교가 안 된다. 시작일로 묶는다.
  const long = all.filter((r) => r.from < '20100101');
  const short = all.filter((r) => r.from >= '20100101');

  if (long.length > 0) {
    printTable(
      `【긴 표본】 ${long[0].from}~${long[0].to} · ${long[0].years.toFixed(1)}년 · 국내 지수만 쓰는 전략`,
      long.sort((a, b) => (b.cagr - b.benchCagr) - (a.cagr - a.benchCagr)),
    );
  }
  if (short.length > 0) {
    printTable(
      `【짧은 표본】 자산이 여럿이라 늦게 시작한다 (구간이 서로 다르니 아래 시작일을 본다)`,
      short.sort((a, b) => (b.cagr - b.benchCagr) - (a.cagr - a.benchCagr)),
    );
    console.log('\n  구간');
    for (const r of short) {
      console.log(
        `    ${r.label.slice(0, 26).padEnd(28)} ${r.from}~${r.to} (${r.years.toFixed(1)}년)`
        + ` · 분할 ${r.first.to}`,
      );
    }
  }

  console.log('\n출처 — 파라미터를 우리가 고르지 않았다');
  for (const s of STRATEGIES) {
    if (!all.some((r) => r.key === s.key)) continue;
    console.log(`  ${s.label.slice(0, 28).padEnd(30)} ${s.source}`);
  }

  console.log(
    '\n★ 이 표는 **전체 구간 성과**다. 12개를 재면 그중 하나는 우연히 좋다 —'
    + '\n  고르기 전에 구간을 잘라 확인해야 한다(다음 단계).',
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
