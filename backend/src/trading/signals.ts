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

/** 하루치. `getInvestorFlowDaily`가 주는 것과 같은 모양이다. */
export interface DailyBar {
  tradingDay: string;
  close: number;
  individual: number;
  foreign: number;
  institution: number;
}

export interface SignalContext {
  /** 날짜 오름차순 전체 계열 */
  history: DailyBar[];
  /** 판정하는 날의 자리. **이 뒤를 보면 안 된다** */
  index: number;
}

export interface SignalCandidate {
  key: string;
  label: string;
  /** 왜 이게 우위가 있을 수 있나. **재기 전에 적는다** */
  rationale: string;
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
    label: '외국인 순매수 비중 (1일)',
    rationale:
      '외국인은 정보·자금이 앞선다고 흔히 이야기된다. 2026-08-04에 이것만 따로 쟀고'
      + ' 네 축 전부 0이었다 — 기준선으로 남겨 둔다.',
    minHistory: 0,
    score: (ctx) => flowSum(ctx, 1, (b) => b.foreign),
  },
  {
    key: 'foreign5',
    label: '외국인 순매수 비중 (5일 누적)',
    rationale:
      '하루치는 잡음이 크다. 며칠 이어진 유입이라면 한 번의 큰 주문보다 뜻이 있을 수 있다.'
      + ' 다만 수급 자기상관이 +0.051로 사실상 0이라 이어지는 일 자체가 드물다.',
    minHistory: 4,
    score: (ctx) => flowSum(ctx, 5, (b) => b.foreign),
  },
  {
    key: 'institution5',
    label: '기관 순매수 비중 (5일 누적)',
    rationale:
      '기관은 외국인과 다른 시점에 움직인다. 자기상관이 −0.100으로 오히려 되돌림 쪽이라'
      + ' 외국인과 부호가 갈릴 수 있다.',
    minHistory: 4,
    score: (ctx) => flowSum(ctx, 5, (b) => b.institution),
  },
  {
    key: 'individualContrarian5',
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
    label: '외국인+기관 − 개인 (5일 누적)',
    rationale:
      '"큰손 대 개인"이라는 구도를 한 값으로 만든다. 셋이 서로의 반대편이라'
      + ' 개별로 볼 때보다 신호가 진해질 수 있다.',
    minHistory: 4,
    score: (ctx) => flowSum(ctx, 5, (b) => b.foreign + b.institution - b.individual),
  },
  {
    key: 'momentum20',
    label: '20일 모멘텀',
    rationale:
      '오른 것이 더 오른다는 가장 오래된 주장. 이 레포는 아직 일봉 축 모멘텀을'
      + ' 안 쟀다 — 1분봉 MA 교차와는 다른 축이다.',
    minHistory: 20,
    score: (ctx) => pastReturn(ctx, 20),
  },
  {
    key: 'reversal1',
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
];
