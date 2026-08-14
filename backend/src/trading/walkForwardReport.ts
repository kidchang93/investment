/**
 * Walk-forward **판정문**을 만든다. 계산은 `walkForward.ts`가 하고 여기는 말만 붙인다.
 *
 * ── 왜 스크립트가 아니라 모듈인가 (2026-08-13) ───────────────────────────
 *
 * 2026-08-13에 드러난 결함 셋이 전부 **판정문이 말하지 않아서** 생긴 것이다.
 *
 * | 안 찍혀 있던 것 | 그래서 무슨 일이 났나 |
 * |------|------|
 * | 고른 칸의 **축 구성** | 안티셀렉션 −46.01을 "학습 순위에 정보가 있다"로 읽었다. 15창이 전부 h=1이었고 −159.28% 중 −136.08%가 비용 상수였다 |
 * | **표본이 어느 해에 있나** | 판정 t −1.38이 진입 743건 위에서 나왔는데 그 743건이 전부 2011~2013이었다 |
 * | 학습 비용 ≠ 판정 비용 | 학습만 싸게 잡으면 못 넘을 칸이 순위에 오른다. 값으로 안 들고 다니면 아무도 모른다 |
 * | **생존편향의 크기** | `survivorshipExposed: true` 불리언 하나로는 아무도 크기를 모른다 |
 *
 * 스크립트 안 헬퍼로 두면 시험이 못 덮는다. 판정문은 **결론을 사람에게 넘기는
 * 마지막 자리**라 여기가 틀리면 계산이 맞아도 결론이 틀린다 — 그래서 순수 함수로
 * 빼고 시험으로 덮는다(`riskRuleBlockers`·`settledRealized`와 같은 이유다).
 *
 * ── ★ t와 손익분기표는 다른 질문의 답이다 ────────────────────────────────
 *
 * `t`는 **"정보가 있나"**, 손익분기표는 **"돈이 되나"**의 답이다. 둘을 한 표에
 * 섞으면 "유의하니까 돈이 된다"로 읽힌다. 손익분기표는 **비용 0 결과로만** 만들고
 * (`buildBreakEvenTable`이 아니면 던진다), 거기에는 t를 한 칸도 넣지 않는다.
 *
 * 이 모듈은 DB도 KIS도 부르지 않는다.
 */

import type { Panel } from './panel.js';
import {
  clusterMeanSe,
  meanOf,
  type HorizonMix,
  type WalkForwardResult,
} from './walkForward.js';

/** 거래일 기준 1년. `walkForward.ts`와 같은 값이어야 표가 맞는다 */
const TRADING_DAYS_PER_YEAR = 252;

/* ── 서식 ────────────────────────────────────────────────────────────── */

export function pct(value: number, digits = 3): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(digits)}%`;
}

export function signed(value: number, digits = 2): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(digits)}`;
}

function count(value: number): string {
  return value.toLocaleString('ko-KR');
}

/* ── 생존편향의 크기 ─────────────────────────────────────────────────── */

/**
 * **표본이 얼마나 살아남은 것들뿐인가.**
 *
 * 종목 자격을 오늘 마스터로 고르면 과거 어느 시점에 존재했다가 사라진 종목이
 * 통째로 빠진다. `survivorshipExposed: true`라는 불리언은 그 사실을 말하지만
 * **크기를 말하지 않는다.** 연도별 종목 수가 단조증가하고 계열이 중간에 끝난
 * 종목이 0이면, 그 패널에는 상장폐지가 **한 건도 없다**는 뜻이다.
 */
export interface SurvivorshipScan {
  /** 그해에 봉이 하나라도 있는 종목 수 */
  byYear: Array<{ year: number; symbols: number }>;
  /** 연도별 종목 수가 한 번도 안 줄었나 */
  monotone: boolean;
  /** 줄어든 첫 자리(있으면). 단조가 아니면 어디서 깨졌는지 말한다 */
  firstDrop: { year: number; from: number; to: number } | undefined;
  /** `cutoff` 이전에 마지막 봉이 있는 종목 수 = **계열이 끝난 종목** */
  endedBefore: number;
  cutoff: string;
  total: number;
}

export function scanSurvivorship(panel: Panel, cutoff: string): SurvivorshipScan {
  const symbolsPerYear = new Map<number, number>();
  let endedBefore = 0;

  for (let s = 0; s < panel.symbols.length; s += 1) {
    const n = panel.barCount[s];
    if (n === 0) continue;
    const dayOfBar = panel.dayIndexOfBar[s];
    const seen = new Set<number>();
    for (let i = 0; i < n; i += 1) {
      const day = panel.days[dayOfBar[i]];
      if (day === undefined) continue;
      seen.add(Number(day.slice(0, 4)));
    }
    for (const year of seen) symbolsPerYear.set(year, (symbolsPerYear.get(year) ?? 0) + 1);
    const lastDay = panel.days[dayOfBar[n - 1]];
    if (lastDay !== undefined && lastDay < cutoff) endedBefore += 1;
  }

  const byYear = [...symbolsPerYear.keys()]
    .sort((a, b) => a - b)
    .map((year) => ({ year, symbols: symbolsPerYear.get(year) ?? 0 }));

  let firstDrop: SurvivorshipScan['firstDrop'];
  for (let i = 1; i < byYear.length; i += 1) {
    if (byYear[i].symbols < byYear[i - 1].symbols) {
      firstDrop = { year: byYear[i].year, from: byYear[i - 1].symbols, to: byYear[i].symbols };
      break;
    }
  }

  return {
    byYear,
    monotone: firstDrop === undefined,
    firstDrop,
    endedBefore,
    cutoff,
    total: panel.symbols.length,
  };
}

/**
 * ★ **빠진 상장폐지의 크기.** 패널 자체로는 못 재는 값이라 밖에서 들여온다.
 *
 * `scanSurvivorship`은 "이 패널 안에 계열이 끝난 종목이 몇이냐"만 답한다. 0이
 * 나와도 그게 **얼마만큼 빠진 것인지**는 말하지 못한다 — 없는 종목은 세어지지
 * 않기 때문이다. 그 크기는 바깥 명단이 있어야 알 수 있다.
 *
 * ★ **값은 잰 날과 출처를 함께 들고 다닌다.** 명단은 낡는다 — 지금은 2026-08-13에
 * 받은 것이고, 봉 테이블이 채워지면 `missingSymbols`가 줄어야 한다. 시점 없이
 * 숫자만 두면 조용히 틀린 값이 된다(`docs/CODE_STYLE.md`「측정 결과」).
 */
export interface DelistingGap {
  /** 어디서 받았나 */
  source: string;
  /** 목록을 언제 받았나 `YYYY-MM-DD` */
  fetchedOn: string;
  /**
   * **이 크기를 언제 쟀나** `YYYY-MM-DD`. 목록을 받은 날과 다르다 —
   * 봉이 들어오면 같은 목록에서도 답이 바뀐다.
   */
  measuredOn: string;
  /** 명단 전체 줄 수 */
  totalRows: number;
  /** KOSPI/KOSDAQ 폐지 기록 중 **계열이 실제로 끊긴** 코드 수 (`covered + missing`) */
  realExits: number;
  /** 그중 우리 봉 테이블에 **종목코드조차 없는** 종목 수 — 아직 빠진 편향 */
  missingSymbols: number;
  /** 그중 봉이 들어왔고 계열도 끝난 종목 수 — **표본에 실제로 반영된 퇴장** */
  coveredSymbols: number;
  /**
   * 폐지 기록에 있으나 **봉이 이어지는** 코드 수. 퇴장이 아니다 —
   * 코스닥→코스피 이전상장·스팩소멸합병이 KIND에 폐지로 기록되는데
   * 그 종목들은 오늘도 거래된다.
   */
  continuingSymbols: number;
  /** **아직 빠진** 종목의 사유 상위. KIND 원문 그대로다 */
  reasons: Array<{ label: string; count: number }>;
  /** 연도별 누락률(0~1). 옛날일수록 크다 */
  missingShareByYear: Array<{ year: number; share: number }>;
  /** 기간 전체 누락률(0~1) */
  overallMissingShare: number;
}

/*
 * ── 왜 상수가 아닌가 (2026-08-14) ────────────────────────────────────────
 *
 * 여기 `KIND_DELISTING_GAP`이 손으로 박혀 있었다(2026-08-13에 잰 값,
 * `missingSymbols: 840` · `barsCollected: false`). 그날 밤 폐지 종목 봉 803개가
 * 들어왔는데 **판정문 맨 위는 계속 "840종목이 종목코드조차 없다"고 적었다.**
 * 맨 위에 찍는 문장이라 읽는 사람이 "편향이 그대로 남았다"고 믿게 된다.
 *
 * 크기는 **잴 때마다 달라진다.** 그래서 상수를 지우고 DB에서 잰다 —
 * `db/delistings.ts`의 `measureDelistingGap()`이 그 자리다. 이 모듈은 순수
 * 계산만 하므로(DB도 KIS도 안 본다) 부른 쪽이 값을 넣어 준다.
 *
 * ★ **폐지일자는 효력일이고 마지막 봉은 그 직전 거래일이다**(5건 실측). 즉 빠진
 * 종목에는 **정리매매 구간이 통째로 들어 있다** — 가격이 무너지는 자리다.
 * `reversal1`·`reversal5`의 상위분위(많이 떨어진 것을 사는 자리)가 정확히 거기라,
 * 누락이 남아 있는 동안 reversal 계열의 우위는 **상한**으로 읽어야 한다.
 */

/**
 * ★ **매 실행 첫 줄에 찍는다.** 판정문 맨 아래 각주가 아니라 맨 위여야 한다 —
 * 아래에 두면 결과를 다 읽은 뒤에 "그런데 이 표본은…"을 만나게 된다.
 *
 * `gap`을 주면 **빠진 크기까지** 적는다. 안 주면 이 패널 안에서 잰 것만 적는다 —
 * 크기를 모르는 채로 "상장폐지가 없다"만 적으면 그게 작은 일처럼 읽힌다.
 */
export function describeSurvivorship(scan: SurvivorshipScan, gap?: DelistingGap): string[] {
  const lines: string[] = [];
  if (scan.byYear.length === 0) {
    lines.push('연도별 봉 보유 종목 수 — 잴 봉이 없다');
    return lines;
  }
  const first = scan.byYear[0];
  const last = scan.byYear[scan.byYear.length - 1];
  const shape = scan.monotone
    ? '단조증가'
    : `${scan.firstDrop?.year}에 ${count(scan.firstDrop?.from ?? 0)}→${count(scan.firstDrop?.to ?? 0)}로 줄었다`;
  lines.push(
    `연도별 봉 보유 종목 수 (${first.year} ${count(first.symbols)}`
    + ` → ${last.year} ${count(last.symbols)}, ${shape})`,
  );
  lines.push(
    `${scan.cutoff.slice(0, 4)}년 이전에 계열이 끝난 종목`
    + ` ${count(scan.endedBefore)}/${count(scan.total)}`,
  );
  if (scan.endedBefore === 0 && scan.monotone) {
    lines.push('★ 이 패널에는 상장폐지가 없다 — reversal 계열의 우위는 상한이다');
  } else if (gap) {
    // 얼마나 빠졌는지는 아래 `describeDelistingGap`이 잰 값으로 말한다.
    // 여기서 "여전히 빠져 있다"를 덧붙이면 크기를 모르는 채로 겁만 준다.
    lines.push(`★ 계열이 끝난 종목이 ${count(scan.endedBefore)}개 있다 — 상장폐지가 들어와 있다`);
  } else {
    lines.push(
      `★ 계열이 끝난 종목이 ${count(scan.endedBefore)}개 있다 —`
      + ' 상장폐지가 일부 들어와 있다. 그래도 오늘 마스터에 없는 종목은 여전히 빠져 있다',
    );
  }
  if (gap) lines.push(...describeDelistingGap(gap));
  lines.push(`  연도별: ${scan.byYear.map((y) => `${y.year} ${count(y.symbols)}`).join(' · ')}`);
  return lines;
}

/** 빠진 크기를 말로 옮긴다. **숫자에 출처와 잰 날을 붙인다.** */
export function describeDelistingGap(gap: DelistingGap): string[] {
  const share = (value: number): string => `${(value * 100).toFixed(1)}%`;
  const lines = [
    `  ${gap.source}(${gap.fetchedOn} 받음, ${count(gap.totalRows)}건) · 이 크기는 ${gap.measuredOn}에 쟀다:`
    + ` KOSPI/KOSDAQ에서 계열이 끊긴 ${count(gap.realExits)}종목 중`
    + ` **${count(gap.coveredSymbols)}종목이 표본에 들어왔고 ${count(gap.missingSymbols)}종목은`
    + ' 아직 봉 테이블에 종목코드조차 없다**',
    `    ★ 폐지 기록에 있으나 봉이 이어지는 코드 ${count(gap.continuingSymbols)}개는 퇴장이 아니다`
    + ' — 이전상장·스팩소멸합병이 KIND에 폐지로 기록되고 그 종목들은 오늘도 거래된다.',
  ];
  if (gap.reasons.length > 0) {
    lines.push(`    아직 빠진 것의 사유 ${gap.reasons.map((r) => `${r.label} ${count(r.count)}`).join(' · ')}`);
  }
  /*
   * 연도가 20개를 넘으면 한 줄이 안 읽힌다. **자른 것을 밝히고** 균등하게 고른다 —
   * 앞쪽만 자르면 누락률이 큰 옛날만 보이고 좋아진 뒤가 안 보인다.
   */
  const years = gap.missingShareByYear;
  const step = Math.max(1, Math.ceil(years.length / 6));
  const shown = years.filter((_, i) => i % step === 0 || i === years.length - 1);
  lines.push(
    `    연도별 누락률 ${shown.map((y) => `${y.year} ${share(y.share)}`).join(' · ')}`
    + (shown.length < years.length ? ` (${years.length}년 중 ${shown.length}년만 적었다)` : '')
    + ` · 전체 ${share(gap.overallMissingShare)}`,
  );
  if (gap.missingSymbols > 0) {
    lines.push(
      '    ★ 폐지일은 **효력일**이고 마지막 봉은 그 직전 거래일이다(5건 실측) —'
      + ' 빠진 종목에는 **정리매매 구간(가격이 무너지는 자리)이 통째로** 들어 있다.',
      '      reversal 계열의 상위분위가 정확히 그 자리를 산다.',
      `    ★ 아직 ${share(gap.overallMissingShare)}가 빠져 있다 — 여기서 나온 reversal 계열의 우위는`
      + ' 여전히 **상한**이다. npx tsx src/scripts/collectDelistedBars.ts',
    );
  } else {
    lines.push(
      '    알려진 퇴장은 전부 들어왔다. ★ 그래도 **KIND 목록 밖은 크기조차 모른다** —'
      + ' ETF·우선주 폐지는 이 목록에 없다.',
    );
  }
  return lines;
}

/* ── 손익분기표 — "돈이 되나" ────────────────────────────────────────── */

export interface BreakEvenCost {
  costPct: number;
  /** 왕복 1회당 순우위(%) */
  netPerRoundTripPct: number;
  /** 그것을 연으로 환산한 값(%) */
  netAnnualPct: number;
  /** 점추정으로 비용을 넘나 */
  beats: boolean;
  /** **해군집 95% 하한으로도** 넘나. 여기까지 넘어야 "넘었다"고 쓸 만하다 */
  beatsAtCiLow: boolean;
}

export interface BreakEvenRow {
  horizon: number;
  entries: number;
  /** 한 자리를 1년 내내 굴렸을 때의 왕복 횟수 */
  roundTripsPerYear: number;
  /** 왕복 1회당 총우위(%). **비용 0** */
  grossPerRoundTripPct: number;
  /** 그것의 연 환산(%) */
  grossAnnualPct: number;
  /** 왕복 1회당 총우위의 95% 신뢰구간. **해 군집 표준오차**다 */
  ciLowPct: number;
  ciHighPct: number;
  /** CI를 만든 해 군집 수. 셋 미만이면 못 잰 것이라 CI가 점추정과 같다 */
  yearClusters: number;
  costs: BreakEvenCost[];
}

/**
 * 축별 손익분기표.
 *
 * ★ **비용 0 결과로만 만든다.** 이미 비용을 뺀 값에 또 비용을 견주면 두 번 빼는
 * 셈이라, 아예 던진다. ★ **축이 고정된 결과여야 한다** — 축이 섞이면 `252/h`를
 * 어느 h로 쓸지 정할 수 없고, 왕복 1회당 값의 크기 자체가 다르다.
 */
export function buildBreakEvenTable(
  results: WalkForwardResult[],
  costs: number[],
): BreakEvenRow[] {
  const rows: BreakEvenRow[] = [];
  for (const result of results) {
    if (result.selectionCostPct !== 0 || result.evalCostPct !== 0) {
      throw new Error(
        `손익분기표는 비용 0 결과로만 만든다 (${result.procedure}:`
        + ` 학습 ${result.selectionCostPct}% · 판정 ${result.evalCostPct}%)`,
      );
    }
    if (result.fixHorizon === undefined) {
      throw new Error(`손익분기표는 축 고정 결과로만 만든다 (${result.procedure})`);
    }
    const horizon = result.fixHorizon;
    const gross = result.oosEntryExcess.length === 0 ? 0 : meanOf(result.oosEntryExcess);
    const { se, clusters } = clusterMeanSe(result.oosEntryExcess, result.oosYearCluster);
    const roundTripsPerYear = TRADING_DAYS_PER_YEAR / horizon;
    rows.push({
      horizon,
      entries: result.oosEntryExcess.length,
      roundTripsPerYear,
      grossPerRoundTripPct: gross,
      grossAnnualPct: gross * roundTripsPerYear,
      ciLowPct: gross - 1.96 * se,
      ciHighPct: gross + 1.96 * se,
      yearClusters: clusters,
      costs: costs.map((costPct) => {
        const net = gross - costPct;
        return {
          costPct,
          netPerRoundTripPct: net,
          netAnnualPct: net * roundTripsPerYear,
          beats: net > 0,
          beatsAtCiLow: gross - 1.96 * se > costPct,
        };
      }),
    });
  }
  return rows;
}

/** 비용을 넘는 축이 하나라도 있나. **점추정 기준** */
export function anyAxisBeatsCost(rows: BreakEvenRow[]): boolean {
  return rows.some((row) => row.costs.some((c) => c.beats));
}

export function describeBreakEvenTable(rows: BreakEvenRow[]): string[] {
  const lines: string[] = [];
  lines.push('손익분기표 — "돈이 되나"의 답이다. **여기에 t는 없다**');
  lines.push('  (총우위는 비용 0. CI는 해 군집 표준오차 기준 95%)');
  if (rows.length === 0) {
    lines.push('  잴 축이 없다.');
    return lines;
  }
  const costs = rows[0].costs.map((c) => c.costPct);
  lines.push(
    '   축    진입     왕복/년   총우위/왕복        총 연알파   95%CI(왕복당)          '
    + costs.map((c) => `${c.toFixed(2)}% 대비`.padStart(16)).join(''),
  );
  for (const row of rows) {
    const ci = row.yearClusters < 3
      ? '—(해 군집 3개 미만)'
      : `[${pct(row.ciLowPct)}, ${pct(row.ciHighPct)}]`;
    lines.push(
      `  ${String(row.horizon).padStart(2)}일`
      + `${count(row.entries).padStart(8)}`
      + `${row.roundTripsPerYear.toFixed(1).padStart(10)}`
      + `${pct(row.grossPerRoundTripPct).padStart(13)}`
      + `${pct(row.grossAnnualPct, 2).padStart(17)}`
      + `   ${ci.padEnd(22)}`
      + row.costs
        .map((c) => `${`${pct(c.netPerRoundTripPct)}/${pct(c.netAnnualPct, 1)}`.padStart(16)}`)
        .join(''),
    );
  }
  const beaten = rows.flatMap((row) => row.costs.filter((c) => c.beats).map((c) => ({ row, c })));
  if (beaten.length === 0) {
    lines.push('  → ★ 비용을 넘는 축이 **하나도 없다.** 정보가 있어도 그 정보로는 돈이 안 된다.');
  } else {
    const ciSafe = beaten.filter((b) => b.c.beatsAtCiLow);
    lines.push(
      `  → 점추정으로 비용을 넘는 칸 ${beaten.length}개`
      + ` (해군집 95% 하한으로도 넘는 칸 ${ciSafe.length}개)`,
    );
    lines.push('    ★ 넘었다고 확정이 아니다. 이 표는 생존편향이 남은 패널 위의 값이다.');
  }
  return lines;
}

/* ── 판정문 ──────────────────────────────────────────────────────────── */

/** 고른 칸의 축 구성. `{1일: 15창/3,836진입}` 꼴로 읽는다 */
export function describeHorizonMix(result: WalkForwardResult): string {
  return formatHorizonMix(result.selectedHorizons);
}

/** 축 구성 하나를 말로 옮긴다. 참여한 쪽과 쉰 쪽에 같은 서식을 쓴다 */
export function formatHorizonMix(mix: HorizonMix[]): string {
  if (mix.length === 0) return '—(고른 칸이 없다)';
  return mix.map((m) => `${m.horizon}일 ${m.windows}창/${count(m.entries)}진입`).join(' · ');
}

/**
 * 고른 칸의 **신호** 구성.
 *
 * ★ 축을 고정하면 축 구성만으로는 두 절차가 갈렸는지 알 수 없다 —
 * `runEvalLegMirror`와 `runBottomLegProcedure`가 같은 축에서 **다른 신호**를 고르는
 * 것이 "거울이 아니다"의 증거다. 그 차이가 보이려면 신호 이름이 있어야 한다.
 */
export function describeSelectedSignals(result: WalkForwardResult): string {
  const counts = new Map<string, number>();
  for (const window of result.windows) {
    const key = window.selected === 'cash' ? '현금' : window.selected.signalKey;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  if (counts.size === 0) return '—(창이 없다)';
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([key, windows]) => `${key} ${windows}창`)
    .join(' · ');
}

/** 표본이 어느 해에 얼마나 있나. **반쪽이 비어 있는 것을 부호로만 말하면 안 보인다** */
export function describeYearSpan(result: WalkForwardResult): string {
  if (result.oosYearCluster.length === 0) return '—(표본 없음)';
  const perYear = new Map<number, number>();
  for (let i = 0; i < result.oosYearCluster.length; i += 1) {
    const year = result.oosYearCluster[i];
    perYear.set(year, (perYear.get(year) ?? 0) + 1);
  }
  const years = [...perYear.keys()].sort((a, b) => a - b);
  return `${years[0]}~${years[years.length - 1]} · 해 ${years.length}개`;
}

/**
 * 표본 밖 결과 판정문.
 *
 * ★ **학습 비용과 판정 비용이 다르면 반드시 찍는다.** 그것을 안 적으면 표가
 * "이 비용에서 이만큼 났다"로 읽히는데, 실제로는 **더 싼 비용으로 고른 칸**을
 * 비싼 비용으로 채점한 값이다.
 */
export function describeVerdict(result: WalkForwardResult): string[] {
  const lines: string[] = [];
  lines.push(
    `  축 ${result.fixHorizon === undefined ? '자유(칸이 고른다)' : `고정 ${result.fixHorizon}일`}`
    + ` · 학습 비용 ${result.selectionCostPct.toFixed(2)}%`
    + ` · 판정 비용 ${result.evalCostPct.toFixed(2)}%`
    + ` · 다리 학습 ${result.selectionLeg}/평가 ${result.evalLeg}`,
  );
  if (result.costsDiffer) {
    lines.push(
      '  ★ 학습 비용과 판정 비용이 **다르다.** 이 값은 더 싼 비용으로 고른 칸을'
      + ' 비싼 비용으로 채점한 것이다 — 순위에 오를 수 없는 칸이 올라 있을 수 있다.',
    );
  }
  if (result.selectionLeg !== result.evalLeg) {
    lines.push('  ★ 선택은 본절차와 같고 **평가 다리만 뒤집었다**(거울). 부호가 갈려야 한다.');
  }
  lines.push(
    `  진입 ${count(result.oosEntryExcess.length)}건`
    + ` · 현금 창 ${result.cashWindows}/${result.windows.length}`
    + ` · 강제청산 ${count(result.truncatedExits)}건`,
  );
  lines.push(`  고른 칸의 축 ${describeHorizonMix(result)}`);
  lines.push(`  고른 칸의 신호 ${describeSelectedSignals(result)}`);
  lines.push(`  표본이 있는 해 ${describeYearSpan(result)}`);
  if (result.oosEntryExcess.length === 0) {
    lines.push('  → 표본 밖 진입이 0건이다. 잴 것이 없다.');
    return lines;
  }
  lines.push(
    `  진입별 순초과 평균 ${pct(meanOf(result.oosEntryExcess))}`
    + ` · 연 알파 ${pct(result.alphaAnnual)} · 연 IR ${result.irAnnual.toFixed(2)}`,
  );
  lines.push(
    `  t  순진 ${signed(result.tNaive)}`
    + ` · NW ${signed(result.tNeweyWest)}`
    + ` · 블록부트 ${signed(result.tBlockBootstrap)}`
    + ` · 비겹침 ${signed(result.tNonOverlap)}`,
  );
  lines.push(
    `     달군집 ${signed(result.tMonthCluster)}`
    + ` · 해군집 ${signed(result.tYearCluster)}`
    + `  →  ★ 판정 t ${signed(result.verdictT)} (여섯 중 |t| 최소)`,
  );
  lines.push(
    `  10%절사 ${pct(result.trimmed10)}/일`
    + ` · 상위1% 날 몫 ${result.top1PctDayShare === undefined ? '—(합이 0 근처라 물을 수 없다)' : `${(result.top1PctDayShare * 100).toFixed(0)}%`}`
    + ` · 시장 베타 ${result.marketBeta.toFixed(2)}`,
  );
  const half = (sign: number): string => (sign > 0 ? '+' : sign < 0 ? '−' : '0(표본 없음)');
  lines.push(
    `  앞 반쪽(2011~2018) ${half(result.halfSigns[0])}`
    + ` · 뒤 반쪽(2019~) ${half(result.halfSigns[1])}`
    + ` · 선택 교체율 ${(result.selectionTurnover * 100).toFixed(0)}%`,
  );
  lines.push(
    `  한 종목 최대 자리 몫 ${result.topSymbolShare === undefined ? '—(안 쟀다)' : `${(result.topSymbolShare * 100).toFixed(1)}%`}`
    + ` · 100만원으로 1주도 못 사는 자리 ${result.unbuyableAt1M === undefined ? '—(안 쟀다)' : `${(result.unbuyableAt1M * 100).toFixed(2)}%`}`,
  );
  return lines;
}

/**
 * 기권 채점.
 *
 * ★ **기권은 "안 한 매매"라서 원장에 흔적이 없다.** 반사실을 함께 재지 않으면
 * "쉬어서 다행이었다"를 확인할 길이 없고, 실제로는 우연히 쉰 것일 수 있다.
 */
export function describeAbstainSkill(result: WalkForwardResult): string[] {
  const lines: string[] = [];
  if (result.abstainedEntries === 0) {
    lines.push('  기권한 창이 없다 — 채점할 것이 없다.');
    return lines;
  }
  lines.push(
    `  기권 ${result.cashWindows}창 · 버린 진입 ${count(result.abstainedEntries)}건`
    + ` (판정 비용 ${result.evalCostPct.toFixed(2)}%)`,
  );
  if (result.abstainAvoidedPct === undefined) {
    lines.push('  → 한쪽 표본이 세 건 미만이라 두 집단을 견줄 수 없다. **0으로 채우지 않는다.**');
    return lines;
  }
  lines.push(
    `  참여 평균 ${pct(meanOf(result.oosEntryExcess))}`
    + ` · 기권 반사실 평균 ${pct(meanOf(result.abstainedExcess))}`
    + ` → 피한 값 ${pct(result.abstainAvoidedPct)}p (진입 가중 · 왕복 1회당)`,
  );
  /*
   * ★ **두 집단의 축을 나란히 찍는다.** 이게 없으면 "왕복 1회당 +0.600%p를
   * 피했다"가 실력처럼 읽힌다 — 실측에서 참여는 3일 축, 쉰 창의 반사실은 20일
   * 축이었다. 20일을 한 번 도는 것과 3일을 한 번 도는 것은 크기가 다르다.
   */
  lines.push(`  참여한 창의 축 ${formatHorizonMix(result.selectedHorizons)}`);
  lines.push(`  쉰 창이 골랐을 축 ${formatHorizonMix(result.abstainedHorizons)}`);
  /*
   * ★ **축만 견준다.** 서식 문자열을 통째로 비교하면 창·진입 수까지 들어가
   * 언제나 다르다고 나온다 — 늘 뜨는 경고는 안 읽힌다(시험이 그걸 잡았다).
   */
  const axesOf = (mix: HorizonMix[]): string => mix.map((m) => m.horizon).join(',');
  if (axesOf(result.selectedHorizons) !== axesOf(result.abstainedHorizons)) {
    lines.push(
      '  ★ 두 집단이 **다른 축**이다. 위 "피한 값"은 왕복 1회당이라 크기가 다른 것을'
      + ' 견준 값이다 — 아래 t는 그래서 하루당으로 환산해 낸다.',
    );
  }
  /*
   * ★ **크기와 유의성의 표본 단위가 다르다.** 피한 값은 진입 가중이지만, 기권
   * 판단은 **창마다 한 번**이라 시도 횟수는 창 수다. 여기를 진입으로 세면
   * 겹치는 관측을 독립으로 세어 t가 부푼다 — 실측에서 7.94 대 0.35였다.
   */
  const { taken, abstained } = result.abstainSkillWindows;
  if (result.abstainSkillT === undefined) {
    lines.push(
      `  ★ 기권 실력 t —(못 잰다). 표본 단위는 **창**인데 참여 ${taken}창 ·`
      + ` 기권 ${abstained}창이라 한쪽이 셋 미만이다. **0으로 채우지 않는다.**`,
    );
    lines.push('  → 피한 값이 양수여도 그것이 실력인지 우연인지는 이 표본으로 답할 수 없다.');
    return lines;
  }
  lines.push(
    `  ★ 기권 실력 t ${signed(result.abstainSkillT)}`
    + ` — 표본 단위는 **창**이고 값은 **하루당 환산**이다`
    + ` (참여 ${taken}창 대 기권 ${abstained}창).`,
  );
  lines.push(
    '    진입으로 세면 겹치는 관측을 독립으로 세어 t가 부푼다. 판단은 창마다 한 번 내렸다.',
  );
  lines.push(
    Math.abs(result.abstainSkillT) < 2
      ? '  → 이 표본에서 기권은 **우연과 구별되지 않는다.** 피한 값이 양수여도 실력의 증거가 아니다.'
      : '  → 두 집단이 갈린다. 다만 창 수가 적어 Welch t가 넓게 흔들린다.',
  );
  return lines;
}

/* ── 위약 귀무분포 ───────────────────────────────────────────────────── */

export interface PlaceboSummary {
  families: number;
  /** |판정 t|의 95분위 */
  absT95: number;
  /** |판정 t|의 최대 */
  absTMax: number;
}

/** `values`의 `q`분위(0~1). 선형 보간 없이 자리로 고른다 — 표본이 작아 보간이 의미 없다 */
export function percentile(values: number[], q: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[index];
}

export function summarizePlacebo(verdictTs: number[]): PlaceboSummary {
  const abs = verdictTs.map((t) => Math.abs(t));
  return {
    families: verdictTs.length,
    absT95: percentile(abs, 0.95),
    absTMax: abs.reduce((a, t) => Math.max(a, t), 0),
  };
}
