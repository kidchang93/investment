/**
 * 후보 신호들. **재기 전에 가설을 적는다.**
 *
 * ── 왜 한곳에 모으나 (2026-08-04) ────────────────────────────────────────
 *
 * 지금까지 하루에 신호 하나씩 쟀다 — `ma_cross` 하루, 외국인 수급 하루. 이 속도면
 * 후보 열 개에 2주다. 더 나쁜 것은 **다중검정이 뒤로 밀린다**는 점이다: 하나씩
 * 재면 열 개 중 하나가 우연히 유의하게 나오고, 그걸 "찾았다"고 믿게 된다.
 * 이 레포는 검정 770칸에서 표본 밖 생존 0건을 이미 겪었다.
 *
 * 한꺼번에 재면 본페로니를 **앞에서** 걸 수 있다. 살아남는 게 없으면 그것도
 * 하루 만에 아는 답이다.
 *
 * ── `rationale`이 필드로 있는 이유 ───────────────────────────────────────
 *
 * **왜 이게 우위가 있을 수 있는지를 재기 전에 적는다.** 안 적으면 나중에 나온
 * 숫자에 맞춰 이야기를 붙이게 된다. 이유를 못 적는 신호는 후보가 아니라
 * 데이터 뒤지기다.
 *
 * ── 신호가 지켜야 할 것 ──────────────────────────────────────────────────
 *
 * **`index`보다 뒤를 보면 안 된다.** 그 하나가 이 파일의 전부다. 시험이
 * 미래 값을 바꿔 가며 점수가 흔들리지 않는지 확인한다.
 */

/**
 * 하루치.
 *
 * `close`와 수급 셋은 `getInvestorFlowDaily`(30일씩)가 주고, 나머지는
 * `getDailyMarketBars`(100일씩)가 준다. **두 TR을 날짜로 합쳐야 채워진다.**
 *
 * 시세 쪽이 `undefined`일 수 있는 이유가 여기 있다 — 수급만 받고 돌리는 호출부가
 * 있고, 그때 0으로 채우면 "시가가 종가와 같았다"는 거짓이 된다.
 */
export interface DailyBar {
  tradingDay: string;
  close: number;
  individual: number;
  foreign: number;
  institution: number;
  open?: number;
  high?: number;
  low?: number;
  /** 거래대금(원). 회전·유동성 계열의 재료 */
  turnover?: number;
  /** 그날 거래량 중 공매도 비중(%) */
  shortRatio?: number;
}

export interface SignalContext {
  /** 날짜 오름차순 전체 계열 */
  history: DailyBar[];
  /** 판정하는 날의 자리. **이 뒤를 보면 안 된다** */
  index: number;
  /**
   * 종목코드. **위약 신호(`makePlaceboSignals`)만 쓴다.**
   *
   * 실신호가 이걸 보면 그 순간 종목 정체성으로 점수를 내는 셈이고, 그건 데이터
   * 뒤지기다 — 표본 안에서는 완벽하고 표본 밖에서는 아무것도 아니다. 위약은
   * 반대로 **종목마다 달라야** 십분위가 뜻을 가지므로 이 값이 필요하다.
   * 없으면 위약은 `undefined`를 낸다(전 종목 같은 점수로 만들지 않는다).
   */
  symbol?: string;
}

/**
 * 이 신호가 **어떤 데이터를 요구하는가.**
 *
 * ── 왜 값으로 들고 있나 (2026-08-12) ─────────────────────────────────────
 *
 * 일봉 저장소(`trading_daily_bars`)에는 시세만 있고 수급·공매도가 없다. 그런데
 * 수급 신호를 그대로 태우면 오류가 아니라 **조용히 `undefined`**가 되고, 날짜 수만
 * 줄어든 표가 정상처럼 찍힌다. 2026-08-10 결함이 정확히 그것이었다.
 *
 * 표시를 값으로 들고 있으면 부른 쪽이 **무엇이 왜 빠졌는지 찍을 수 있다.**
 */
export type SignalDataRequirement = 'price' | 'flow' | 'short';

export interface SignalCandidate {
  key: string;
  label: string;
  /** 왜 이게 우위가 있을 수 있나. **재기 전에 적는다** */
  rationale: string;
  /** 무엇이 있어야 점수가 나오나. 없는 데이터면 부른 쪽이 **밝히고** 뺀다 */
  dataRequirement: SignalDataRequirement;
  /**
   * 가설을 못 박은 날 `YYYY-MM-DD`.
   *
   * 표본 밖 검증은 "이 가설을 **데이터를 보기 전에** 정했다"가 성립할 때만 뜻이
   * 있다. 날짜가 없으면 나중에 정의를 손보고도 "원래 그랬다"고 말할 수 있다.
   */
  frozenAt: string;
  /**
   * 점수가 나오는 **가장 이른 `index`**.
   *
   * "필요한 봉 수"가 아니다 — 하네스가 `index < minHistory`로 거르므로 자리
   * 번호여야 한다. 오늘 하루만 보는 신호는 `0`이고, 5일 누적은 `4`다
   * (index−4 … index를 보므로 index가 4는 돼야 한다).
   *
   * 시험이 이 값을 검사한다: 이 자리에서는 값이 나와야 하고 한 칸 앞에서는
   * `undefined`여야 한다. 어긋나면 하네스가 쓸 수 있는 날을 잘못 센다.
   */
  minHistory: number;
  /** 높을수록 "살 만하다". 잴 수 없으면 undefined — 0으로 채우지 않는다 */
  score(ctx: SignalContext): number | undefined;
}

/** 그날 셋의 절대값 합. 종목 간 비교가 되게 나누는 데 쓴다. */
function tradeScale(bar: DailyBar): number {
  return Math.abs(bar.individual) + Math.abs(bar.foreign) + Math.abs(bar.institution);
}

/** `index`에서 `back`일 전까지의 수익률. 자리가 모자라면 undefined. */
function pastReturn(ctx: SignalContext, back: number): number | undefined {
  const from = ctx.index - back;
  if (from < 0) return undefined;
  const a = ctx.history[from].close;
  const b = ctx.history[ctx.index].close;
  return a > 0 && b > 0 ? b / a - 1 : undefined;
}

/**
 * `from`부터 `to`까지(양끝 포함) 어떤 값의 평균. **하나라도 없으면 undefined다.**
 *
 * 시세 필드는 수급만 받은 호출부에서 비어 있을 수 있다. 없는 것을 빼고 평균 내면
 * 종목마다 다른 개수로 잰 값을 나란히 줄 세우게 된다 — 그게 더 나쁘다.
 */
function windowMean(
  ctx: SignalContext,
  from: number,
  to: number,
  pick: (bar: DailyBar) => number | undefined,
): number | undefined {
  if (from < 0 || to >= ctx.history.length || from > to) return undefined;
  let total = 0;
  for (let i = from; i <= to; i += 1) {
    const value = pick(ctx.history[i]);
    if (value === undefined || !Number.isFinite(value)) return undefined;
    total += value;
  }
  return total / (to - from + 1);
}

/**
 * **그 종목 자기 기준의** 거래대금 급증 배수 — 최근 5일 평균 ÷ 그 앞 20일 평균.
 *
 * 종목 간 절대 거래대금을 비교하면 대형주만 위로 몰린다(그건 크기이지 사건이
 * 아니다). 자기 과거로 나누면 **평소보다 얼마나 몰렸나**가 남고, 그게 사용자가
 * 말한 "자본이 많이 투입되고 빠져나가고를 반복한다"에 해당하는 값이다.
 */
function turnoverSurge(ctx: SignalContext): number | undefined {
  const recent = windowMean(ctx, ctx.index - 4, ctx.index, (b) => b.turnover);
  const base = windowMean(ctx, ctx.index - 24, ctx.index - 5, (b) => b.turnover);
  if (recent === undefined || base === undefined) return undefined;
  // 앞 20일이 통째로 거래정지면 배수를 만들 수 없다. 1로 채우면 "평소였다"는 거짓이다.
  if (!(base > 0) || !(recent >= 0)) return undefined;
  // 배수는 오른쪽 꼬리가 길다(10배가 흔하다). 로그로 줄 세워야 몇 종목이 순위를 삼키지 않는다.
  return Math.log(recent / base);
}

/** 최근 `days`일 순매수 비중의 합. 하루치 잡음을 줄인다. */
function flowSum(
  ctx: SignalContext,
  days: number,
  pick: (bar: DailyBar) => number,
): number | undefined {
  let total = 0;
  for (let i = ctx.index - days + 1; i <= ctx.index; i += 1) {
    if (i < 0) return undefined;
    const scale = tradeScale(ctx.history[i]);
    // 매매가 없던 날은 비중을 만들 수 없다. 0으로 채우면 "중립"이 되어 거짓이다.
    if (scale <= 0) return undefined;
    total += pick(ctx.history[i]) / scale;
  }
  return total;
}

/**
 * 후보 목록.
 *
 * ★ **여기에 넣는 순간 다중검정 부담이 는다.** 후보 하나가 늘면 모든 후보의
 * 문턱이 함께 올라간다. "혹시 몰라서" 넣지 말고, 가설을 적을 수 있는 것만 넣는다.
 */
export const SIGNAL_CANDIDATES: SignalCandidate[] = [
  {
    key: 'foreign1',
    dataRequirement: 'flow',
    frozenAt: '2026-08-04',
    label: '외국인 순매수 비중 (1일)',
    rationale:
      '외국인은 정보·자금이 앞선다고 흔히 이야기된다. 2026-08-04에 이것만 따로 쟀고'
      + ' 네 축 전부 0이었다 — 기준선으로 남겨 둔다.',
    minHistory: 0,
    score: (ctx) => flowSum(ctx, 1, (b) => b.foreign),
  },
  {
    key: 'foreign5',
    dataRequirement: 'flow',
    frozenAt: '2026-08-04',
    label: '외국인 순매수 비중 (5일 누적)',
    rationale:
      '하루치는 잡음이 크다. 며칠 이어진 유입이라면 한 번의 큰 주문보다 뜻이 있을 수 있다.'
      + ' 다만 수급 자기상관이 +0.051로 사실상 0이라 이어지는 일 자체가 드물다.',
    minHistory: 4,
    score: (ctx) => flowSum(ctx, 5, (b) => b.foreign),
  },
  {
    key: 'institution5',
    dataRequirement: 'flow',
    frozenAt: '2026-08-04',
    label: '기관 순매수 비중 (5일 누적)',
    rationale:
      '기관은 외국인과 다른 시점에 움직인다. 자기상관이 −0.100으로 오히려 되돌림 쪽이라'
      + ' 외국인과 부호가 갈릴 수 있다.',
    minHistory: 4,
    score: (ctx) => flowSum(ctx, 5, (b) => b.institution),
  },
  {
    key: 'individualContrarian5',
    dataRequirement: 'flow',
    frozenAt: '2026-08-04',
    label: '개인 순매도 비중 (5일 누적, 역방향)',
    rationale:
      '개인이 많이 산 종목을 피한다는 통념을 그대로 잰다. 부호를 뒤집어 넣었으므로'
      + ' 통념이 맞으면 양(+)이 나와야 한다. 통념을 검증하는 자리다.',
    minHistory: 4,
    score: (ctx) => {
      const sum = flowSum(ctx, 5, (b) => b.individual);
      return sum === undefined ? undefined : -sum;
    },
  },
  {
    key: 'smartMoney5',
    dataRequirement: 'flow',
    frozenAt: '2026-08-04',
    label: '외국인+기관 − 개인 (5일 누적)',
    rationale:
      '"큰손 대 개인"이라는 구도를 한 값으로 만든다. 셋이 서로의 반대편이라'
      + ' 개별로 볼 때보다 신호가 진해질 수 있다.',
    minHistory: 4,
    score: (ctx) => flowSum(ctx, 5, (b) => b.foreign + b.institution - b.individual),
  },
  {
    key: 'momentum20',
    dataRequirement: 'price',
    frozenAt: '2026-08-12',
    label: '20일 모멘텀',
    rationale:
      '오른 것이 더 오른다는 가장 오래된 주장. 이 레포는 아직 일봉 축 모멘텀을'
      + ' 안 쟀다 — 1분봉 MA 교차와는 다른 축이다.',
    minHistory: 20,
    score: (ctx) => pastReturn(ctx, 20),
  },
  {
    key: 'reversal1',
    dataRequirement: 'price',
    frozenAt: '2026-08-12',
    label: '1일 반전 (전일 하락폭)',
    rationale:
      '많이 떨어진 것이 되돌아온다는 주장. 부호를 뒤집어 넣었으므로 통념이 맞으면'
      + ' 양(+)이 나온다. 짧은 축이라 비용이 특히 무겁다.',
    minHistory: 1,
    score: (ctx) => {
      const r = pastReturn(ctx, 1);
      return r === undefined ? undefined : -r;
    },
  },
  {
    key: 'reversal5',
    dataRequirement: 'price',
    frozenAt: '2026-08-12',
    label: '5일 반전',
    rationale: '위와 같은 가설을 조금 긴 축에서. 1일보다 잡음이 적고 비용 부담도 낮다.',
    minHistory: 5,
    score: (ctx) => {
      const r = pastReturn(ctx, 5);
      return r === undefined ? undefined : -r;
    },
  },
  {
    key: 'flowMomentum',
    dataRequirement: 'flow',
    frozenAt: '2026-08-04',
    label: '외국인 수급 × 20일 모멘텀',
    rationale:
      '둘 다 약해도 함께 볼 때 갈릴 수 있다 — "오르는 종목을 외국인이 사고 있다".'
      + ' 곱이라 부호가 같을 때만 커진다.',
    minHistory: 20,
    score: (ctx) => {
      const flow = flowSum(ctx, 5, (b) => b.foreign);
      const momentum = pastReturn(ctx, 20);
      return flow === undefined || momentum === undefined ? undefined : flow * momentum;
    },
  },
  {
    key: 'lowVolatility',
    dataRequirement: 'price',
    frozenAt: '2026-08-12',
    label: '저변동성 (20일 일간 변동 평균의 역)',
    rationale:
      '변동이 작은 종목이 위험 대비 낫다는 주장(저변동성 이상현상). 이 레포에는'
      + ' 반대 방향 실측이 있다 — 고변동 종목 선정이 더 크게 졌다(2026-08-01).',
    minHistory: 20,
    score: (ctx) => {
      let total = 0;
      for (let i = ctx.index - 19; i <= ctx.index; i += 1) {
        if (i < 1) return undefined;
        const a = ctx.history[i - 1].close;
        const b = ctx.history[i].close;
        if (!(a > 0) || !(b > 0)) return undefined;
        total += Math.abs(b / a - 1);
      }
      return total > 0 ? -total / 20 : undefined;
    },
  },
  {
    key: 'turnoverSurge',
    dataRequirement: 'price',
    frozenAt: '2026-08-12',
    label: '거래대금 급증 (자기 20일 대비 최근 5일)',
    rationale:
      '사용자 관찰을 그대로 잰다 — "세력이 아니고서야 자본이 많이 투입되고 빠져나가고를'
      + ' 반복한다". 평소보다 자금이 몰린 종목에서 값이 움직인다면 급증 자체가 축이다.'
      + ' 절대 거래대금이 아니라 **자기 과거 대비**라 대형주 쏠림이 없다.',
    minHistory: 24,
    score: (ctx) => turnoverSurge(ctx),
  },
  {
    key: 'surgeMomentum',
    dataRequirement: 'price',
    frozenAt: '2026-08-12',
    label: '거래대금 급증 × 20일 모멘텀',
    rationale:
      '자금이 몰리는 것만으로는 방향을 모른다 — 사려고 몰릴 수도 팔려고 몰릴 수도 있다.'
      + ' 오르는 중에 몰린 것과 빠지는 중에 몰린 것을 가른다. 곱이라 상위는 "오르며 몰림",'
      + ' 하위는 "빠지며 몰림"이 되어 하네스의 하위 분위가 그대로 거울이 된다.',
    minHistory: 24,
    score: (ctx) => {
      const surge = turnoverSurge(ctx);
      const momentum = pastReturn(ctx, 20);
      return surge === undefined || momentum === undefined ? undefined : surge * momentum;
    },
  },
  {
    key: 'shortRatioLow',
    dataRequirement: 'short',
    frozenAt: '2026-08-06',
    label: '공매도 비중 낮음 (5일 평균, 역방향)',
    rationale:
      '빌려서 파는 쪽은 사는 쪽과 다른 정보를 본다. 공매도가 많이 걸린 종목이 이후 못 간다는'
      + ' 주장이 널리 있어 **부호를 뒤집어** 넣었다 — 통념이 맞으면 양(+)이 나온다.'
      + ' 이 레포는 공매도를 한 번도 안 쟀고, 수급(사는 쪽)과 겹치지 않는 축이다.',
    minHistory: 4,
    score: (ctx) => {
      const avg = windowMean(ctx, ctx.index - 4, ctx.index, (b) => b.shortRatio);
      return avg === undefined ? undefined : -avg;
    },
  },
  {
    key: 'parkinsonVol',
    dataRequirement: 'price',
    frozenAt: '2026-08-12',
    label: '저변동성 · 고저 범위 기준 (20일, 역방향)',
    rationale:
      '`lowVolatility`와 **같은 가설을 다른 자로** 잰다. 종가끼리만 보면 장중에 크게'
      + ' 흔들리고 제자리로 온 날이 "조용한 날"로 잡히는데, 고저 범위는 그것을 잡는다.'
      + ' ★ 둘 중 하나만 살아남으면 그건 더 좋은 자가 아니라 **잡음**이라는 뜻이다.',
    minHistory: 19,
    score: (ctx) => {
      // Parkinson: √( Σ ln(고/저)² / (4·ln2·N) ). 고저가 같은 날(상한가 직행)은 0이라 문제없다.
      let total = 0;
      for (let i = ctx.index - 19; i <= ctx.index; i += 1) {
        if (i < 0) return undefined;
        const { high, low } = ctx.history[i];
        if (high === undefined || low === undefined) return undefined;
        if (!(high > 0) || !(low > 0) || high < low) return undefined;
        total += Math.log(high / low) ** 2;
      }
      return -Math.sqrt(total / (4 * Math.LN2 * 20));
    },
  },
];

/*
 * ── 위약 신호 ────────────────────────────────────────────────────────────
 *
 * **우위가 없는 것이 확실한 신호를 같은 절차에 태운다.** 절차가 위약에서도
 * "좋은 것"을 찾아낸다면, 실신호에서 나온 값도 절차가 만든 것이다.
 *
 * 이 레포는 이미 그 함정에 빠질 뻔했다 — 문턱을 누적으로 올리지 않았다면
 * 850칸 중 하나가 우연히 유의한 것을 "찾았다"고 믿었을 것이다. 위약은 그
 * 문턱이 실제로 맞는지를 **재서** 보여 준다.
 *
 * ★ **결정론적이어야 한다.** 같은 시드면 같은 점수가 나와야 실행을 재현할 수
 * 있고, 시드가 다르면 서로 다른 표본이 되어야 여러 개를 태우는 뜻이 있다.
 * 난수 발생기를 쓰면 둘 다 깨진다 — 그래서 `hash(종목|날짜|시드)`다.
 *
 * ★ **위약은 반증 요구다. 원장의 검정 수에 세지 않는다** — 떨어뜨릴 수만 있고
 * 무언가를 "찾아낼" 수는 없기 때문이다.
 */

/**
 * FNV-1a 32비트 + 뭉침 풀기.
 *
 * 뒤에 붙은 세 줄(avalanche)이 없으면 이웃한 문자열의 해시가 이웃한 값이 되어
 * **날짜가 하루 밀릴 때마다 점수가 조금씩 움직인다.** 그러면 위약에 없어야 할
 * 시계열 구조가 생긴다.
 */
export function hashUnitInterval(text: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  h ^= h >>> 16;
  h = Math.imul(h, 2246822507) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 3266489909) >>> 0;
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** 위약 신호 하나. 시드만 다르고 나머지는 같다. */
export function placeboSignal(seed: number): SignalCandidate {
  return {
    key: `placebo${seed}`,
    dataRequirement: 'price',
    frozenAt: '2026-08-12',
    label: `위약 ${seed} (해시 난수)`,
    rationale:
      '우위가 있을 이유가 **없다.** 그것이 이 신호의 목적이다 — 절차가 이것에서도'
      + ' 무언가를 찾아낸다면 실신호에서 나온 값도 절차가 만든 것이다.'
      + ' hash(종목|거래일|시드)라 결정론적이고, 같은 시드는 언제나 같은 표를 낸다.',
    minHistory: 0,
    score: (ctx) => {
      // 종목을 모르면 전 종목이 같은 점수가 되어 십분위가 뜻을 잃는다. 지어내지 않는다.
      if (ctx.symbol === undefined) return undefined;
      return hashUnitInterval(`${ctx.symbol}|${ctx.history[ctx.index].tradingDay}|${seed}`);
    },
  };
}

/** `seedFrom`부터 `seedTo`까지(양끝 포함). */
export function makePlaceboSignals(seedFrom: number, seedTo: number): SignalCandidate[] {
  const signals: SignalCandidate[] = [];
  for (let seed = seedFrom; seed <= seedTo; seed += 1) signals.push(placeboSignal(seed));
  return signals;
}
