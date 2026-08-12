/**
 * 21년 일봉으로 **walk-forward 측정**을 돌린다.
 *
 * ── 무엇이 다른가 ────────────────────────────────────────────────────────
 *
 * `measureSignalHarness.ts`는 **한 구간을 재고 그 구간에서 판정**했다. 그러면
 * 후보를 고른 데이터와 판정한 데이터가 같아서, 850칸을 재는 동안 언젠가는
 * 우연히 유의한 것이 나온다. 여기서는 **찾는 곳과 재는 곳을 시간으로 가른다** —
 * 2005~2010에서 찾아 2011에 검증, 창을 밀며 열다섯 번.
 *
 * ★ `measureSignalHarness.ts`는 **그대로 둔다.** 옛 `dataset_key`의 기록이다.
 *
 * ── 이 스크립트가 지키는 것 ──────────────────────────────────────────────
 *
 * - **DB만 본다. KIS를 부르지 않는다.** 수집이 도는 중에도 안전하다.
 * - **주문을 내지 않는다.** 조회·계산뿐이다.
 * - ★ **`--show-training` 없이는 학습 순위를 아예 안 찍는다.** 찍히면 사람이
 *   그것을 결론으로 읽는다 — 학습 1위는 "표본 안에서 제일 좋아 보인 것"일 뿐이다.
 *
 *   npx tsx --max-old-space-size=4096 src/scripts/measureWalkForward.ts \
 *     --dataset dailybars-20260812 --procedure expanding|rolling \
 *     [--placebo 20] [--anti] [--mirror] [--family2] [--show-training] [--dry-run]
 */

import { closeDb, pool } from '../db/client.js';
import { getDailyBars, type DailyBar as StoredBar } from '../db/dailyBars.js';
import {
  HARNESS_CELL_UNIT,
  cumulativeCellCount,
  recordSignalMeasurements,
} from '../db/signalMeasurements.js';
import { bonferroniThreshold } from '../trading/signalHarness.js';
import { buildPanel, buildUniverseMask, type Panel, type UniverseMask } from '../trading/panel.js';
import {
  SIGNAL_CANDIDATES,
  makePlaceboSignals,
  type SignalCandidate,
} from '../trading/signals.js';
import {
  buildCellSeriesSet,
  excludeUnusableSignals,
  meanOf,
  runAntiSelection,
  runMirror,
  runWalkForward,
  type CellSeries,
  type WalkForwardResult,
  type WalkForwardSpec,
} from '../trading/walkForward.js';

/** 재는 단위. 창 15개가 **한 검정**이다 — 칸 하나가 아니다. */
const WALKFORWARD_UNIT = 'walkforward-run';

/**
 * 잴 보유 기간(거래일).
 *
 * 60일 축을 안 넣은 이유는 embargo가 60거래일이기 때문이다 — 학습 마지막 날의
 * 청산이 검증 첫날에 닿아 경계가 새어 나간다. 사용자가 정한 보유 지평도
 * **1~2주**라 20일이 위쪽 끝이다.
 */
const HORIZONS = [1, 3, 5, 10, 20];

/**
 * 왕복 비용(%).
 *
 * 레포의 `ROUND_TRIP_COST_RATE`는 0.43%(수수료 0.03 + 거래세 0.20 + 슬리피지 0.20)다.
 * 여기서는 **0.54%**를 쓴다 — 진입·청산이 둘 다 **시가**라 개장 스프레드가 장중보다
 * 넓고, 실주문 슬리피지 실측(0.33%)이 가정(0.1%)의 세 배였기 때문이다.
 *
 * ★ **학습과 검증에 같은 값이 들어간다.** 학습만 싸게 잡으면 비용을 못 넘는 칸이
 * 순위에 올라온다.
 */
const DEFAULT_ROUND_TRIP_PCT = 0.54;

/*
 * ★ 비용은 판정을 좌우하므로 CLI로 열어 둔다 — 상수로 박아 두면 민감도를 못 잰다.
 *
 * 근거의 폭을 알고 써라. `docs/USER_FINDINGS.md:1500-1512`의 Roll 추정(분봉 자기공분산)이
 * 스프레드 0.311~0.315%를 냈고 왕복 0.541~0.545%가 거기서 나왔다. 그런데 같은 문서
 * 1561행이 **"실제가 1틱에 가까우면 왕복 0.302%"**라고 유보를 달아 뒀고,
 * 2026-08-11 ETF 호가 실측은 스프레드가 0.018~0.121%였다 — Roll 추정보다 훨씬 좁다.
 * 즉 참값은 0.30~0.55% 어딘가이고, 그 폭이 결론을 바꾸는지는 재 봐야 안다.
 */
const ROUND_TRIP_PCT = (() => {
  const i = process.argv.indexOf('--cost');
  if (i < 0) return DEFAULT_ROUND_TRIP_PCT;
  const v = Number(process.argv[i + 1]);
  if (!Number.isFinite(v) || v < 0) throw new Error('--cost는 0 이상의 숫자여야 합니다(단위 %)');
  return v;
})();

/** 검증 창이 시작하는 날. 2011부터 해마다 하나씩 열다섯 개. */
const VALIDATION_STARTS = Array.from({ length: 15 }, (_, i) => `${2011 + i}0101`);

/** 학습과 검증 사이에 비우는 거래일. ★ 전 축 고정 */
const EMBARGO_DAYS = 60;

/** 유니버스 문턱. 전부 as-of-date다 (종목 자격만 오늘 마스터다) */
const UNIVERSE = {
  minBars: 120,
  activityWindow: 60,
  minActiveDays: 55,
  turnoverWindow: 20,
  minTurnover: 100_000_000,
  turnoverBottomFraction: 0.2,
  minNamesPerDay: 200,
};

const BUCKETS = 10;

interface Options {
  dataset: string;
  procedure: 'expanding' | 'rolling';
  placebo: number;
  anti: boolean;
  mirror: boolean;
  family2: boolean;
  showTraining: boolean;
  dryRun: boolean;
  limitSymbols: number | null;
}

function parseOptions(argv: string[]): Options {
  const options: Options = {
    dataset: 'dailybars-20260812',
    procedure: 'expanding',
    placebo: 0,
    anti: false,
    mirror: false,
    family2: false,
    showTraining: false,
    dryRun: false,
    limitSymbols: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = (): string => argv[(index += 1)] ?? '';
    switch (arg) {
      case '--dataset':
        options.dataset = next();
        break;
      case '--procedure': {
        const value = next();
        if (value !== 'expanding' && value !== 'rolling') {
          throw new Error(`--procedure는 expanding 또는 rolling이어야 합니다: ${value}`);
        }
        options.procedure = value;
        break;
      }
      case '--placebo':
        options.placebo = Number(next());
        break;
      case '--anti':
        options.anti = true;
        break;
      case '--mirror':
        options.mirror = true;
        break;
      case '--family2':
        options.family2 = true;
        break;
      case '--show-training':
        options.showTraining = true;
        break;
      case '--cost':
        // ★ 위 ROUND_TRIP_PCT가 읽는다. 여기서는 인자를 소비만 한다(모르는 인자 검사 통과용).
        next();
        break;
      case '--dry-run':
        // 원장에 안 쓴다. 실행 시간을 재거나 표만 보고 싶을 때.
        options.dryRun = true;
        break;
      case '--limit-symbols':
        // ★ 시간을 재려고 줄일 때만. 시장을 대표하지 않으므로 판정에 쓰지 않는다.
        options.limitSymbols = Number(next());
        break;
      default:
        throw new Error(`모르는 인자입니다: ${arg}`);
    }
  }
  if (!Number.isInteger(options.placebo) || options.placebo < 0) {
    throw new Error('--placebo는 0 이상의 정수여야 합니다');
  }
  return options;
}

function pct(value: number): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(3)}%`;
}

function signed(value: number): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}`;
}

function heapMb(): number {
  return Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
}

function elapsed(from: number): string {
  return `${((Date.now() - from) / 1000).toFixed(1)}초`;
}

/**
 * 종목 자격. **오늘 마스터 기준이라 as-of-date가 아니다.**
 *
 * 우선주는 **두 방식 중 하나라도 우선주라고 하면 뺀다** — 코드 끝자리와 이름이
 * 갈리는 종목이 실제로 있다(`verifyDailyBars` 7항목). 어느 쪽이 맞는지 모르는 채로
 * 한쪽만 믿으면 보통주 표본에 우선주가 섞인다.
 */
async function loadEligibleSymbols(): Promise<{ symbols: Set<string>; preferred: number }> {
  const { rows } = await pool.query<{ symbol: string; preferred: boolean }>(
    `SELECT symbol, (right(symbol, 1) <> '0' OR name ~ '우[A-Z]?$') AS preferred
     FROM instruments
     WHERE country = 'KR' AND asset_type = 'stock' AND market IN ('KOSPI', 'KOSDAQ')
       AND is_active = true
     ORDER BY symbol`,
  );
  const symbols = new Set(rows.filter((r) => !r.preferred).map((r) => r.symbol));
  return { symbols, preferred: rows.length - symbols.size };
}

/** 저장소에 실제로 봉이 있는 종목. 수집이 도는 중이면 이 수가 계속 는다. */
async function loadStoredSymbols(): Promise<string[]> {
  const { rows } = await pool.query<{ symbol: string }>(
    `SELECT DISTINCT symbol FROM trading_daily_bars ORDER BY symbol`,
  );
  return rows.map((r) => r.symbol);
}

interface LoadedPanel {
  panel: Panel;
  symbolCount: number;
  barCount: number;
}

/**
 * DB → 패널.
 *
 * 종목 하나씩 받아 `Map`에 쌓고 패널을 세운 뒤 `Map`을 놓는다. 잠깐 두 벌이
 * 살아 있지만(객체 5.6M + 타입배열 330MB), 패널이 서고 나면 객체 쪽은 GC가
 * 걷어 간다. 그래서 `--max-old-space-size=4096`이 필요하다.
 */
async function loadPanel(symbols: string[]): Promise<LoadedPanel> {
  const barsBySymbol = new Map<string, StoredBar[]>();
  let barCount = 0;
  for (const symbol of symbols) {
    const bars = await getDailyBars(symbol);
    if (bars.length === 0) continue;
    barsBySymbol.set(symbol, bars);
    barCount += bars.length;
  }
  const panel = buildPanel(barsBySymbol);
  barsBySymbol.clear();
  return { panel, symbolCount: panel.symbols.length, barCount };
}

/** 계열을 만든다. 신호 하나에 점수판 하나(≈165MB)라 하나씩 세우고 놓는다. */
function buildCells(
  panel: Panel,
  universe: UniverseMask,
  signals: SignalCandidate[],
  label: string,
): CellSeries[] {
  const cells: CellSeries[] = [];
  const startedAt = Date.now();
  for (let i = 0; i < signals.length; i += 1) {
    cells.push(
      ...buildCellSeriesSet(
        panel, signals[i], HORIZONS, universe, 'nextOpen', BUCKETS, UNIVERSE.minNamesPerDay,
      ),
    );
    if ((i + 1) % 5 === 0 || i === signals.length - 1) {
      console.log(
        `  ${label} ${i + 1}/${signals.length}종 · 칸 ${cells.length}`
        + ` · ${elapsed(startedAt)} · 힙 ${heapMb()}MB`,
      );
    }
  }
  return cells;
}

function describeVerdict(result: WalkForwardResult): string[] {
  const lines: string[] = [];
  lines.push(
    `  진입 ${result.oosEntryExcess.length.toLocaleString('ko-KR')}건`
    + ` · 현금 창 ${result.cashWindows}/${result.windows.length}`
    + ` · 강제청산 ${result.truncatedExits.toLocaleString('ko-KR')}건`,
  );
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
    + ` · 비겹침 ${signed(result.tNonOverlap)}`
    + `  →  ★ 판정 t ${signed(result.verdictT)}`,
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

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const startedAt = Date.now();

  console.log('walk-forward 측정 · DB만 본다 (KIS 호출 0회) · 주문을 내지 않는다');
  console.log(`데이터셋 ${options.dataset} · 절차 ${options.procedure} · 재는 단위 ${WALKFORWARD_UNIT}`);
  console.log(`진입 basis nextOpen(익일 시가) · 왕복 비용 ${ROUND_TRIP_PCT}% (학습·검증 같은 값)`);

  // ── 후보 고르기 ────────────────────────────────────────────────────────
  const family1 = SIGNAL_CANDIDATES.filter((s) => s.dataRequirement === 'price');
  /*
   * ★ **`--family2`는 수급·공매도 계열이다.** 일봉 저장소에 그 데이터가 없어서
   * 전부 빠지는데, **빠졌다는 사실을 찍는 것**이 이 플래그의 목적이다 —
   * 2026-08-10에 그것들이 조용히 `undefined`로 흘러 날짜 수만 줄었다.
   */
  const candidates = options.family2 ? SIGNAL_CANDIDATES : family1;
  const { usable, excluded } = excludeUnusableSignals(
    candidates,
    new Set<'price' | 'flow' | 'short'>(['price']),
  );
  console.log(`\n후보 ${usable.length}종 × 축 ${HORIZONS.length}개 = ${usable.length * HORIZONS.length}칸`);
  for (const signal of usable) {
    console.log(`  쓴다  ${signal.key.padEnd(16)} (가설 고정 ${signal.frozenAt})`);
  }
  for (const item of excluded) {
    console.log(`  뺀다  ${item.signal.key.padEnd(16)} — ${item.reason}`);
  }
  if (excluded.length > 0 && !options.family2) {
    console.log('  (일봉 전용 실행이라 자동으로 빠졌다. `--family2`로 목록을 넓혀도 결과는 같다)');
  }
  if (usable.length === 0) {
    console.log('\n쓸 수 있는 후보가 없다. 여기서 멈춘다.');
    return;
  }

  // ── 패널 ───────────────────────────────────────────────────────────────
  const eligible = await loadEligibleSymbols();
  const stored = await loadStoredSymbols();
  let targets = stored.filter((symbol) => eligible.symbols.has(symbol));
  if (options.limitSymbols !== null) {
    console.log('\n★ --limit-symbols는 시간을 재려고 줄이는 것이다. 시장을 대표하지 않으므로 판정에 쓰지 않는다.');
    targets = targets.slice(0, options.limitSymbols);
  }
  console.log(
    `\n저장소 ${stored.length}종목 → 자격(국내 주식·KOSPI/KOSDAQ·우선주 제외) ${targets.length}종목`
    + ` (우선주 ${eligible.preferred}종 제외)`,
  );

  const panelStartedAt = Date.now();
  const loaded = await loadPanel(targets);
  const { panel } = loaded;
  console.log(
    `패널 ${panel.symbols.length}종목 × ${panel.days.length}거래일`
    + ` · 봉 ${loaded.barCount.toLocaleString('ko-KR')} · ${elapsed(panelStartedAt)} · 힙 ${heapMb()}MB`,
  );
  console.log(`기간 ${panel.days[0]} ~ ${panel.days[panel.days.length - 1]}`);

  // ── 유니버스 ───────────────────────────────────────────────────────────
  const maskStartedAt = Date.now();
  const universe = buildUniverseMask(panel, {
    ...UNIVERSE,
    scoreGateSignals: usable,
    eligibleSymbols: new Set(targets),
  });
  const { adjustment } = universe;
  console.log(
    `\n유니버스 · ${elapsed(maskStartedAt)} · 힙 ${heapMb()}MB`,
  );
  console.log(
    `  수정주가 파탄 ${adjustment.breaks.length}건 · 걸린 종목 ${adjustment.brokenSymbols}개`
    + ` → 그 앞 ${adjustment.droppedBars.toLocaleString('ko-KR')}봉`
    + ` (전체의 ${(adjustment.droppedShare * 100).toFixed(2)}%) 버림`,
  );
  console.log(
    `  쓸 수 있는 날 ${universe.usableDays.toLocaleString('ko-KR')}`
    + ` · 종목이 모자라 버린 날 ${universe.thinDays.toLocaleString('ko-KR')}`
    + ` · 날짜별 종목 수 중앙 ${universe.namesMedian} · 최소 ${universe.namesMin}`,
  );
  console.log(
    '  걸린 문턱: 봉 ≥ 120 · 최근 60일 중 거래일 ≥ 55 · 20일 평균 거래대금 ≥ 1억이고 하위 20% 밖'
    + ` · 후보 ${usable.length}종이 전부 유한한 점수를 내는 종목만 · 그날 ≥ ${UNIVERSE.minNamesPerDay}종목`,
  );
  if (universe.usableDays === 0) {
    console.log('\n쓸 수 있는 날이 없다. 문턱이 데이터보다 빡빡하다 — 여기서 멈춘다.');
    return;
  }

  // ── 계열 ───────────────────────────────────────────────────────────────
  console.log('\n계열 만들기 (셀당 한 번 훑는다)');
  const cellSeries = buildCells(panel, universe, usable, '실신호');

  const spec: WalkForwardSpec = {
    panel,
    cellSeries,
    universe,
    trainMode: options.procedure,
    rollingYears: 10,
    validationStarts: VALIDATION_STARTS,
    embargoDays: EMBARGO_DAYS,
    selection: { rule: 'top1', objective: 'netIR', abstainIfNegative: true },
    costRoundTripPct: ROUND_TRIP_PCT,
    buckets: BUCKETS,
    minNamesPerDay: UNIVERSE.minNamesPerDay,
    signalsByKey: new Map(usable.map((s) => [s.key, s])),
    survivorshipExposed: true,
    cashPerPosition: 1_000_000,
  };

  const runStartedAt = Date.now();
  const main = runWalkForward(spec);
  console.log(`\n본 절차 (${main.procedure}) · ${elapsed(runStartedAt)}`);

  // ── 창 ─────────────────────────────────────────────────────────────────
  console.log(`\n창 ${main.windows.length}개 · embargo ${EMBARGO_DAYS}거래일 (전 축 고정)`);
  console.log('  학습                     검증                     고른 것          진입');
  for (const window of main.windows) {
    const chosen = window.selected === 'cash'
      ? '현금(학습이 음수)'
      : `${window.selected.signalKey} ${window.selected.horizon}일`;
    console.log(
      `  ${window.trainFrom}~${window.trainTo}  ${window.validFrom}~${window.validTo}`
      + `  ${chosen.padEnd(22)}${String(window.oosEntries).padStart(6)}`,
    );
  }
  if (options.showTraining) {
    console.log('\n★ 학습 순위 — **이것은 결론이 아니다.** 표본 안에서 제일 좋아 보인 것일 뿐이다.');
    for (const window of main.windows) {
      const top = window.ranked.slice(0, 5)
        .map((r) => `${r.signalKey}${r.horizon} ${r.trainNetIR.toFixed(2)}`)
        .join(' · ');
      console.log(`  ${window.validFrom}  ${top}`);
    }
  } else {
    console.log('\n(학습 순위는 안 찍는다 — 찍히면 결론으로 읽힌다. 보려면 --show-training)');
  }

  // ── 판정 ───────────────────────────────────────────────────────────────
  console.log(`\n${'━'.repeat(78)}`);
  console.log('표본 밖 결과');
  console.log('━'.repeat(78));
  for (const line of describeVerdict(main)) console.log(line);

  // ── 반증 ───────────────────────────────────────────────────────────────
  let anti: WalkForwardResult | null = null;
  let mirror: WalkForwardResult | null = null;
  const placeboTs: number[] = [];

  if (options.anti) {
    anti = runAntiSelection(spec);
    console.log('\n★ 안티셀렉션 — 학습 **최하위**를 고른다 (반증 전용, 검정 수에 안 센다)');
    for (const line of describeVerdict(anti)) console.log(line);
    console.log('  → 학습 순위에 정보가 있으면 이 값은 **크기가 비슷한 음수**여야 한다.');
    console.log('    0 근처면 학습 순위가 표본 밖으로 아무것도 안 넘긴다는 뜻이다.');
  }

  if (options.mirror) {
    mirror = runMirror(spec);
    console.log('\n★ 거울 — 하위분위를 산다 (반증 전용, 검정 수에 안 센다)');
    for (const line of describeVerdict(mirror)) console.log(line);
    console.log('  → 진짜 우위면 부호가 갈린다. 둘이 같은 부호면 표본이 통째로 가진 성질이다.');
  }

  if (options.placebo > 0) {
    const familySize = usable.length;
    const families = Math.floor(options.placebo / familySize);
    console.log(
      `\n★ 위약 — 우위가 **없는 것이 확실한** 신호로 같은 절차를 돌린다 (반증 전용)`,
    );
    if (families === 0) {
      console.log(
        `  위약 ${options.placebo}종은 한 가족(${familySize}종)에 못 미친다.`
        + ' 실신호와 같은 크기로 맞춰야 견줄 수 있다 — 건너뛴다.',
      );
    } else {
      const used = families * familySize;
      if (used < options.placebo) {
        console.log(`  ${options.placebo}종 중 ${used}종만 쓴다 — 가족 크기(${familySize})의 배수로 맞춘다.`);
      }
      for (let f = 0; f < families; f += 1) {
        const signals = makePlaceboSignals(f * familySize + 1, (f + 1) * familySize);
        const cells = buildCells(panel, universe, signals, `위약 가족 ${f + 1}`);
        const result = runWalkForward({ ...spec, cellSeries: cells, signalsByKey: undefined });
        placeboTs.push(result.verdictT);
        console.log(
          `  가족 ${f + 1} (시드 ${f * familySize + 1}~${(f + 1) * familySize})`
          + ` · 판정 t ${signed(result.verdictT)}`
          + ` · 연 알파 ${pct(result.alphaAnnual)}`
          + ` · 진입 ${result.oosEntryExcess.length.toLocaleString('ko-KR')}건`
          + ` · 현금 창 ${result.cashWindows}/${result.windows.length}`,
        );
      }
      const worst = placeboTs.reduce((a, t) => (Math.abs(t) > Math.abs(a) ? t : a), 0);
      console.log(`  → 위약이 낸 가장 큰 |판정 t| ${Math.abs(worst).toFixed(2)}`);
      console.log('    실신호의 판정 t가 이보다 크지 않으면, 나온 값은 절차가 만든 것이다.');
    }
  }

  // ── 원장 ───────────────────────────────────────────────────────────────
  const priorRuns = await cumulativeCellCount(options.dataset, WALKFORWARD_UNIT);
  const threshold = bonferroniThreshold(priorRuns + 1);
  const legacyCells = await cumulativeCellCount();
  console.log(`\n${'━'.repeat(78)}`);
  console.log(
    `이 데이터셋·단위로 지금까지 ${priorRuns}번 쟀다 → 이번을 더해 ${priorRuns + 1}번`
    + ` · 본페로니 문턱 |t| > ${threshold.toFixed(2)}`,
  );
  console.log(
    `(옛 데이터셋 ${HARNESS_CELL_UNIT} 누적 ${legacyCells}칸은 여기 분모에 넣지 않는다 —`
    + ' 데이터도 단위도 진입 basis도 다르다)',
  );
  const passes = Math.abs(main.verdictT) > threshold && main.alphaAnnual > 0;
  console.log(
    `\n판정: ${passes ? '★ 문턱을 넘었다' : '넘지 못했다'}`
    + ` (판정 t ${signed(main.verdictT)} vs 문턱 ${threshold.toFixed(2)})`,
  );
  if (!passes) {
    console.log('→ 이 절차가 이 21년에서 비용을 넘는 우위를 못 찾았다. 그것도 답이다.');
  } else {
    console.log('★ 넘었다고 확정이 아니다. 반증 셋(안티셀렉션·거울·위약)을 함께 읽어라.');
    console.log('  그리고 표본은 **오늘 살아 있는 종목만**이다 — 생존편향이 남아 있다.');
  }

  if (options.dryRun) {
    console.log('\n--dry-run이라 원장에 안 남긴다.');
  } else {
    const oosYears = (VALIDATION_STARTS.length * 252) / 252;
    await recordSignalMeasurements([
      {
        measuredAt: Date.now(),
        signalKey: `walkforward:${options.procedure}`,
        rationale:
          '후보 7종(가설 고정 2026-08-12)을 학습 구간에서 순위 매겨 1위 하나만 검증 구간에 태운다.'
          + ' 찾는 곳과 재는 곳을 시간으로 가르면, 표본 안에서 좋아 보이는 것이 표본 밖으로'
          + ' 넘어가는지를 절차 자체로 물을 수 있다.',
        horizonDays: 0,
        periodKey: `walkforward:${options.procedure}`,
        periodFrom: panel.days[0],
        periodTo: panel.days[panel.days.length - 1],
        universe:
          `krx-stock-nonpreferred-${panel.symbols.length}`
          + `/bars>=120/active55of60/turnover>=1e8&top80%/scoregate${usable.length}/names>=200`,
        symbolsCount: panel.symbols.length,
        daysCount: main.oosEntryExcess.length,
        samples: main.oosEntryExcess.length,
        spreadMean: meanOf(main.oosEntryExcess),
        spreadMedian: meanOf(main.oosDaily),
        tStat: main.tNaive,
        alpha: main.alphaAnnual,
        alphaT: main.verdictT,
        beta: main.marketBeta,
        runCellCount: 1,
        bonferroniT: threshold,
        survived: passes,
        note:
          `창 ${main.windows.length} · 현금 창 ${main.cashWindows} · 축 ${HORIZONS.join('/')}`
          + ` · 후보 ${usable.length}종 · 계열 ${cellSeries.length}칸`
          + ` · 유니버스 날 ${universe.usableDays}`
          + ` · 수정주가 파탄으로 버린 봉 ${adjustment.droppedBars}`,
        verdictBasis: 'walkforward-oos',
        datasetKey: options.dataset,
        testUnit: WALKFORWARD_UNIT,
        entryBasis: 'nextOpen',
        costRoundTrip: ROUND_TRIP_PCT,
        oosYears,
        tNeweyWest: main.tNeweyWest,
        tBlockBoot: main.tBlockBootstrap,
        tNonOverlap: main.tNonOverlap,
        verdictT: main.verdictT,
        selectionTurnover: main.selectionTurnover,
        half1Sign: main.halfSigns[0],
        half2Sign: main.halfSigns[1],
        antiT: anti?.verdictT,
        mirrorT: mirror?.verdictT,
        placeboMaxT: placeboTs.length > 0
          ? placeboTs.reduce((a, t) => Math.max(a, Math.abs(t)), 0)
          : undefined,
        survivorshipExposed: true,
        truncatedExits: main.truncatedExits,
      },
    ]);
    console.log('\n원장에 1줄 남겼다 — 이 데이터셋·단위의 다음 실행은 문턱이 그만큼 오른다.');
    console.log('★ 반증(안티셀렉션·거울·위약)은 값으로만 남고 검정 수에는 안 센다.');
  }

  console.log(`\n전체 ${elapsed(startedAt)} · 최대 힙 ${heapMb()}MB`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
