/**
 * **적정가 산출** — KIS 재무 · 차트 · 뉴스 셋을 합쳐 한 종목의 적정 범위를 낸다.
 *
 * ── 왜 (2026-09-03) ──────────────────────────────────────────────────────
 *
 * 사용자가 정했다 — *"분석가는 KIS와 차트분석 및 웹 뉴스 이 세가지를 분석해서
 * 적정가를 슬랙으로 5분마다 메세지 보내줘."*
 *
 * ★ **적정가가 있으면 판단이 숫자가 된다.** 지금 판단자는 "좋아 보인다"를 글로
 *   쓰는데, 적정가가 있으면 *"적정가 대비 −12%"*가 되고 그건 종목끼리 비교된다.
 *   그리고 **나중에 채점할 수 있다** — 30일 뒤 실제 주가와 대조하면
 *   "이 적정가가 값어치가 있었나"를 답할 수 있다.
 *
 * ── ★★ 이것은 예측이 아니라 기준선이다 ──────────────────────────────────
 *
 * 여기서 내는 값은 **"이 종목이 얼마가 될 것이다"가 아니다.** 그건 아무도 모른다.
 * 이것이 답하는 것은 **"지금 값이 그 종목의 최근 궤적 대비 어디쯤인가"**뿐이다.
 *
 * 그래서 세 축을 **평균 내지 않고 나란히 낸다** — 셋이 갈리면 그 자체가 정보다
 * (예: 차트는 싸다는데 재무는 비싸다면, 이익이 꺾이는 중일 수 있다).
 *
 * ── 세 축 ────────────────────────────────────────────────────────────────
 *
 * **① 차트** — 이동평균 회귀. 60일 이동평균을 중심으로 최근 변동폭만큼의 띠.
 *    *"이 종목은 보통 이 범위에서 논다"*를 21년 일봉 저장소로 잰다.
 *
 * **② 재무** — BPS·EPS에 **그 종목 자신의 과거 배수**를 곱한다. 업종 평균이나
 *    시장 배수를 쓰지 않는다 — 종목마다 정상 배수가 다르고, 남의 배수를 들이대면
 *    "은행주는 늘 싸다" 같은 결론만 나온다.
 *
 * **③ 뉴스** — 여기서는 **계산하지 않는다.** 뉴스는 숫자가 아니라 해석이고,
 *    해석은 판단자가 한다. 이 모듈은 **관련 뉴스를 붙여 주기만** 한다.
 *
 * ★ 순수 계산이라 DB도 네트워크도 안 탄다 — 시험에 그대로 태울 수 있다.
 */

/**
 * ── 종목 갈래 ────────────────────────────────────────────────────────────
 *
 * 사용자가 짚었다 (2026-09-03) — *"적정가 분석 시 여러 종목별로 카테고리 나눠서
 * 적정가 산정해줘. 지금은 무슨 기준으로 한지 모르겠어."*
 *
 * 맞다. 그전에는 **ETF와 개별주식을 같은 방식으로** 쟀다. 그래서 KODEX 200에
 * "재무 없음"이 붙고, 금 ETF에 PBR을 물으려 하고, 결과만 보면 무엇을 근거로
 * 했는지 알 수 없었다.
 *
 * ★ **갈래마다 적정가의 뜻이 다르다.** 개별주식은 "회사 가치 대비"이고 지수
 *   ETF는 "그 지수의 최근 궤적 대비"다. 같은 −10%라도 뜻이 다르다.
 */
export type AssetKind =
  /** 개별 주식 — 재무 배수가 뜻을 갖는다 */
  | 'stock'
  /** 광범위 지수 ETF — 재무가 없다. 궤적 대비로만 잰다 */
  | 'indexEtf'
  /** 섹터·테마 ETF (고배당·리츠 등) — 지수 ETF와 같은 방식이되 기초자산이 좁다 */
  | 'sectorEtf'
  /** 원자재·실물 (금·원유) — 재무가 아예 성립하지 않는다 */
  | 'commodityEtf'
  /** 레버리지·인버스 — 변동성 끌림이 있어 장기 궤적 비교 자체가 위험하다 */
  | 'leveraged';

export const ASSET_KIND_LABEL: Record<AssetKind, string> = {
  stock: '개별주식',
  indexEtf: '지수 ETF',
  sectorEtf: '섹터·테마 ETF',
  commodityEtf: '원자재·실물',
  leveraged: '레버리지·인버스',
};

/** 갈래마다 **무엇으로 적정가를 내는지** — 사람이 읽을 한 줄 */
export const ASSET_KIND_METHOD: Record<AssetKind, string> = {
  stock: '차트(6개월 분포) + 재무(BPS·EPS × 그 종목 과거 배수)',
  indexEtf: '차트(6개월 분포)만 — 지수에는 재무가 없다',
  sectorEtf: '차트(6개월 분포)만 — 기초자산이 여럿이라 재무를 합칠 수 없다',
  commodityEtf: '차트(6개월 분포)만 — 실물은 재무가 성립하지 않는다',
  leveraged: '차트만 · ★ 변동성 끌림 때문에 이 값을 믿지 말 것',
};

/**
 * 종목을 갈래로 나눈다. **이름과 자산유형으로만** 판정한다 — 기초자산 구성
 * 데이터가 이 레포에 없다.
 *
 * ★ 어림이라는 것을 알고 쓴다. `universe.ts`가 레버리지를 이름으로 거르는 것과
 *   같은 방식이고, 같은 한계를 갖는다(이름에 표시가 없는 것은 못 거른다).
 */
export function classifyAsset(name: string, assetType: string | undefined): AssetKind {
  if (assetType !== 'etf' && assetType !== 'etn') return 'stock';
  // ★ 레버리지·인버스를 **가장 먼저** 본다. "KODEX 200선물인버스2X"는 지수 이름을
  //   달고 있어서 지수 ETF로 새기 쉽다.
  if (/레버리지|인버스|단일종목|\dX/.test(name)) return 'leveraged';
  if (/금현물|골드|은현물|실버|원유|WTI|천연가스|구리|농산물|커피|옥수수|콩/.test(name)) return 'commodityEtf';
  // 광범위 지수 — 나라·시장 전체를 담는 것
  if (/200$|200[^선물]|코스닥150|KRX100|S&P\s?500|나스닥100|다우존스|MSCI|코스피/.test(name)) return 'indexEtf';
  return 'sectorEtf';
}

/** 하루 봉 하나. 저장소·KIS 어느 쪽에서 와도 이 모양이면 된다 */
export interface Bar {
  tradingDay: string;
  close: number;
  high: number;
  low: number;
}

export interface FinancialInput {
  /** 주당순자산 */
  bps?: number;
  /** 주당순이익 (연환산) */
  eps?: number;
  /** 자기자본이익률 % */
  roe?: number;
}

/** 한 축의 결과. **못 내면 `null`이고 왜 못 냈는지 적는다** */
export interface Band {
  low: number;
  mid: number;
  high: number;
  basis: string;
}

export interface FairValue {
  symbol: string;
  /** 어느 갈래인가. **적정가의 뜻이 갈래마다 다르다** */
  kind: AssetKind;
  price: number;
  /** ① 차트 축 */
  chart: Band | null;
  /** ② 재무 축 */
  fundamental: Band | null;
  /**
   * 지금 값이 어디쯤인가. 두 축 중 **낼 수 있는 것들의 중앙값** 대비.
   * `-0.12`면 12% 싸다는 뜻이다.
   */
  gap: number | null;
  /** 못 낸 축이 있으면 그 사유. **빈 배열이 아니면 판단자가 알아야 한다** */
  missing: string[];
}

/** 표본이 이만큼은 있어야 차트 축을 낸다 */
const MIN_BARS = 60;
/** 중심으로 삼을 이동평균 길이(거래일) */
const MA_DAYS = 60;
/**
 * 띠를 정할 때 볼 과거 구간(거래일). 약 6개월.
 *
 * ★ 처음에 **일간 변동성 × √60 × 2**로 폭을 냈다가 버렸다 — KODEX 200이
 *   13,775~218,832원이 나왔다(2026-09-03). 거의 모든 값이 그 안에 들어 아무것도
 *   판정하지 못한다. 원인은 정규분포 가정이다: 이 시장은 하루 ±6%가 나오고
 *   (8/19 −6.26% · 8/20 +6.32%) 그것을 √60으로 늘리면 폭이 지수 자체만큼 커진다.
 *
 * ★ **그래서 실측 분포를 쓴다.** 이론적 폭이 아니라 **최근 6개월 종가가 실제로
 *   어디에 있었나**의 백분위다. "이 종목은 보통 이 범위에서 논다"는 물음에
 *   가정 없이 답한다.
 */
const BAND_DAYS = 126;
/** 띠의 아래·위 백분위. 25~75면 절반이 그 안이라 "정상 범위"의 뜻이 분명하다 */
const BAND_LOW_Q = 0.25;
const BAND_HIGH_Q = 0.75;

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/**
 * ① 차트 축 — **최근 6개월 종가가 실제로 있었던 범위**(25~75 백분위)와 60일 이동평균.
 *
 * 답하는 물음은 하나다: *"이 종목은 보통 어느 값에서 놀았나."*
 *
 * ★ 이론적 변동성 폭을 쓰지 않는다(위 `BAND_DAYS` 주석 참고) — 정규분포를
 *   가정하는 순간 이 시장에서는 띠가 지수만큼 넓어져 아무것도 못 가른다.
 *
 * ★ 표본이 모자라면 **짐작하지 않고 `null`**이다. 상장 직후 종목이 그렇다.
 *
 * ★ **추세가 있으면 이 축은 늘 "비싸다"고 말한다.** 오르는 종목은 지금 값이
 *   과거 분포 위에 있는 것이 당연하다 — 그래서 이 값 하나로 팔지 않는다.
 *   재무 축과 나란히 놓고 판단자가 읽는 이유가 이것이다.
 */
export function chartBand(bars: Bar[]): Band | null {
  if (bars.length < MIN_BARS) return null;
  const closes = bars.map((b) => b.close).filter((c) => c > 0);
  if (closes.length < MIN_BARS) return null;

  const ma = mean(closes.slice(-MA_DAYS));
  const window = closes.slice(-BAND_DAYS);
  if (window.length < MIN_BARS) return null;
  const sorted = [...window].sort((a, b) => a - b);
  const at = (q: number): number => sorted[Math.floor((sorted.length - 1) * q)];
  const low = at(BAND_LOW_Q);
  const high = at(BAND_HIGH_Q);
  if (!(low > 0) || !(high > low)) return null;
  return {
    low: Math.round(low),
    mid: Math.round(ma),
    high: Math.round(high),
    basis: `최근 ${window.length}일 종가 25~75분위 · 60일선 ${Math.round(ma).toLocaleString('ko-KR')}원`,
  };
}

/**
 * ② 재무 축 — **그 종목 자신의 과거 배수**로 BPS·EPS를 되돌린다.
 *
 * ★ 업종 평균 PER을 쓰지 않는다. 종목마다 정상 배수가 다르고, 남의 배수를
 *   들이대면 "은행주는 늘 싸다"는 결론만 나온다 — 그건 적정가가 아니라 업종 특성이다.
 *
 * ★ **과거 배수는 호출부가 준다**(`pastPbr`·`pastPer`). 이 함수는 계산만 한다.
 *   구하지 못하면 그 축은 `null`이고, 짐작으로 12배 같은 값을 넣지 않는다.
 */
export function fundamentalBand(
  fin: FinancialInput,
  pastPbr: { low: number; mid: number; high: number } | null,
  pastPer: { low: number; mid: number; high: number } | null,
): Band | null {
  const parts: Array<{ low: number; mid: number; high: number; label: string }> = [];
  if (fin.bps !== undefined && fin.bps > 0 && pastPbr) {
    parts.push({
      low: fin.bps * pastPbr.low,
      mid: fin.bps * pastPbr.mid,
      high: fin.bps * pastPbr.high,
      label: `BPS ${Math.round(fin.bps).toLocaleString('ko-KR')} × PBR ${pastPbr.low.toFixed(2)}~${pastPbr.high.toFixed(2)}`,
    });
  }
  if (fin.eps !== undefined && fin.eps > 0 && pastPer) {
    parts.push({
      low: fin.eps * pastPer.low,
      mid: fin.eps * pastPer.mid,
      high: fin.eps * pastPer.high,
      label: `EPS ${Math.round(fin.eps).toLocaleString('ko-KR')} × PER ${pastPer.low.toFixed(1)}~${pastPer.high.toFixed(1)}`,
    });
  }
  if (parts.length === 0) return null;
  return {
    low: Math.round(mean(parts.map((p) => p.low))),
    mid: Math.round(mean(parts.map((p) => p.mid))),
    high: Math.round(mean(parts.map((p) => p.high))),
    basis: parts.map((p) => p.label).join(' · '),
  };
}

/**
 * 두 축을 모아 한 종목의 판정을 만든다.
 *
 * ★ **평균 내지 않고 나란히 둔다.** 셋이 갈리면 그 자체가 정보다 — 차트는
 *   싸다는데 재무는 비싸면 이익이 꺾이는 중일 수 있다. `gap`은 **낼 수 있는
 *   축들의 중앙값** 대비이고, 축이 하나면 그것 하나로 낸다.
 *
 * ★ 축을 하나도 못 내면 `gap`이 `null`이다. **0으로 채우지 않는다** —
 *   "적정가와 같다"와 "모른다"는 다른 사실이다.
 */
export function combine(
  symbol: string,
  kind: AssetKind,
  price: number,
  chart: Band | null,
  fundamental: Band | null,
  missing: string[],
): FairValue {
  const mids = [chart?.mid, fundamental?.mid].filter((v): v is number => typeof v === 'number' && v > 0);
  const gap = mids.length > 0 && price > 0 ? price / mean(mids) - 1 : null;
  return { symbol, kind, price, chart, fundamental, gap, missing };
}

/**
 * 사람이 읽을 한 줄. 슬랙과 판단자가 같은 문장을 본다.
 *
 * ★ **부호를 말로도 적는다.** `-12.3%`만 보면 "적정가가 12% 낮다"로 읽는 사람이
 *   있다. 실제 뜻은 "지금 값이 적정가보다 12% 싸다"이다.
 */
export function describe(fv: FairValue, name: string): string {
  if (fv.gap === null) {
    return `${name} ${fv.price.toLocaleString('ko-KR')}원 — 적정가를 못 냈다(${fv.missing.join(', ') || '자료 부족'})`;
  }
  const pct = (fv.gap * 100).toFixed(1);
  const word = fv.gap < -0.02 ? '싸다' : fv.gap > 0.02 ? '비싸다' : '비슷하다';
  const bands = [
    fv.chart ? `차트 ${fv.chart.low.toLocaleString('ko-KR')}~${fv.chart.high.toLocaleString('ko-KR')}` : null,
    fv.fundamental ? `재무 ${fv.fundamental.low.toLocaleString('ko-KR')}~${fv.fundamental.high.toLocaleString('ko-KR')}` : null,
  ].filter(Boolean).join(' · ');
  return `${name} ${fv.price.toLocaleString('ko-KR')}원 · 적정가 대비 ${pct}% (${word}) · ${bands}`;
}
