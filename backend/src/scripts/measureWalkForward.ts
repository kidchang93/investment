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
 * ── ★ 2026-08-13에 두 블록으로 갈랐다 ───────────────────────────────────
 *
 * 그 전에는 한 실행이 "정보가 있나"와 "돈이 되나"를 **동시에** 물었고, 그래서
 * 판정 t −1.38이 **표본의 절반 위에서** 나왔다:
 *
 *   - 기권(`abstainIfNegative`) + 비용 0.54% → 15창 중 12창이 현금.
 *     진입 743건이 **전부 2011~2013**이고 2019년 이후 표본이 0이었다.
 *   - 위약 20종이 전부 진입 0건 → 경험적 귀무분포가 아예 작동하지 않았다.
 *   - 축이 자유라 `netIR`의 `√(252/h)`가 비용 상수에 곱해져 **h=1을 못 박았다.**
 *     안티셀렉션 −46.01의 연알파 −159.28% 중 −136.08%가 비용이었다.
 *
 * | 블록 | 묻는 것 | 어떻게 | 원장 |
 * |------|------|------|------|
 * | A | **정보가 있나** | 비용 0 · 기권 없음 · **축 고정** · 위약 귀무분포 | 쓴다(축 1개 = 1칸) |
 * | B | **비용을 넘나** | 기권 없음 · 비용 여럿 · **t를 쓰지 않는다** | ★ **안 쓴다**(추정이지 검정이 아니다) |
 *
 * ── 이 스크립트가 지키는 것 ──────────────────────────────────────────────
 *
 * - **DB만 본다. KIS를 부르지 않는다.** 수집이 도는 중에도 안전하다.
 * - **주문을 내지 않는다.** 조회·계산뿐이다.
 * - ★ **`--show-training` 없이는 학습 순위를 아예 안 찍는다.** 찍히면 사람이
 *   그것을 결론으로 읽는다 — 학습 1위는 "표본 안에서 제일 좋아 보인 것"일 뿐이다.
 * - ★ **생존편향의 크기를 맨 위에 찍는다.** 불리언 하나로는 아무도 크기를 모른다.
 *
 *   npx tsx --max-old-space-size=4096 src/scripts/measureWalkForward.ts \
 *     --dataset dailybars-20260812 --procedure expanding|rolling \
 *     [--axes 1,3,5,10,20] [--eval-costs 0.30,0.43,0.54] [--block-b] \
 *     [--placebo-families 50] [--placebo-axis 5] [--anti] [--mirror] \
 *     [--abstain-score] [--cost 0.54] [--show-training] [--dry-run] \
 *     [--annotate-legacy]
 */

import { closeDb, pool } from '../db/client.js';
import { getDailyBars, type DailyBar as StoredBar } from '../db/dailyBars.js';
import {
  HARNESS_CELL_UNIT,
  WALKFORWARD_BLOCK_A_UNIT,
  WALKFORWARD_RUN_UNIT,
  annotateWalkforwardDependencyNote,
  cumulativeCellCount,
  cumulativeMeasuredCells,
  recordSignalMeasurements,
} from '../db/signalMeasurements.js';
import { bonferroniThreshold } from '../trading/signalHarness.js';
import {
  DEFAULT_ADJUSTMENT_SCAN,
  buildPanel,
  buildUniverseMask,
  type Panel,
  type UniverseMask,
} from '../trading/panel.js';
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
  runBlockA,
  runBottomLegProcedure,
  runEvalLegMirror,
  runWalkForward,
  type BlockASpec,
  type CellSeries,
  type WalkForwardResult,
  type WalkForwardSpec,
} from '../trading/walkForward.js';
import {
  KIND_DELISTING_GAP,
  anyAxisBeatsCost,
  buildBreakEvenTable,
  describeAbstainSkill,
  describeBreakEvenTable,
  describeHorizonMix,
  describeSelectedSignals,
  describeSurvivorship,
  describeVerdict,
  pct,
  scanSurvivorship,
  signed,
  summarizePlacebo,
} from '../trading/walkForwardReport.js';

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
 * 여기서는 **0.54%**를 기본으로 쓴다 — 진입·청산이 둘 다 **시가**라 개장 스프레드가
 * 장중보다 넓고, 실주문 슬리피지 실측(0.33%)이 가정(0.1%)의 세 배였기 때문이다.
 *
 * ★ **블록 A는 이 값을 안 쓴다.** 비용 0이 블록 A의 정의다.
 */
const DEFAULT_ROUND_TRIP_PCT = 0.54;

/**
 * 손익분기표·블록 B가 견줄 비용들.
 *
 * 참값을 모른다. `docs/USER_FINDINGS.md:1500-1512`의 Roll 추정(분봉 자기공분산)이
 * 왕복 0.541~0.545%를 냈는데, 같은 문서 1561행이 **"실제가 1틱에 가까우면 왕복
 * 0.302%"**라고 유보를 달았고 2026-08-11 ETF 호가 실측은 스프레드 0.018~0.121%였다.
 * 그래서 폭 전체를 세로로 늘어놓고 **어디서 부호가 바뀌는지**를 본다.
 */
const DEFAULT_EVAL_COSTS = [0.3, 0.43, 0.54];

/** 검증 창이 시작하는 날. 2011부터 해마다 하나씩 열다섯 개. */
const VALIDATION_STARTS = Array.from({ length: 15 }, (_, i) => `${2011 + i}0101`);

/** 학습과 검증 사이에 비우는 거래일. ★ 전 축 고정 */
const EMBARGO_DAYS = 60;

/**
 * 생존편향을 재는 기준일. 이 날 이전에 계열이 끝난 종목이 **상장폐지의 대리**다.
 * 하나도 없으면 이 패널에 폐지가 안 들어 있다는 뜻이다.
 */
const SURVIVORSHIP_CUTOFF = '20250101';

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
  /** 블록 A가 돌 축들 */
  axes: number[];
  /** 손익분기표·블록 B가 견줄 비용들 */
  evalCosts: number[];
  /** 블록 B(비용을 넣고 실제로 다시 고르기)까지 돌린다 */
  blockB: boolean;
  /** 위약 가족 수. 한 가족이 실신호와 같은 크기다 */
  placeboFamilies: number;
  /** 위약도 축을 고정할까. `null`이면 축 자유 */
  placeboAxis: number | null;
  anti: boolean;
  mirror: boolean;
  abstainScore: boolean;
  /** 기권 채점 실행에 쓸 왕복 비용(%) */
  abstainCost: number;
  family2: boolean;
  showTraining: boolean;
  dryRun: boolean;
  annotateLegacy: boolean;
  limitSymbols: number | null;
}

function parseNumberList(raw: string, label: string): number[] {
  const values = raw.split(',').map((part) => Number(part.trim()));
  if (values.length === 0 || values.some((v) => !Number.isFinite(v))) {
    throw new Error(`${label}는 쉼표로 이은 숫자여야 합니다: ${raw}`);
  }
  return values;
}

function parseOptions(argv: string[]): Options {
  const options: Options = {
    dataset: 'dailybars-20260812',
    procedure: 'expanding',
    axes: [...HORIZONS],
    evalCosts: [...DEFAULT_EVAL_COSTS],
    blockB: false,
    // ★ 위약이 곧 블록 A의 판정 기준이다. 기본으로 돈다 — 끄려면 0을 준다.
    placeboFamilies: 50,
    placeboAxis: null,
    anti: false,
    mirror: false,
    abstainScore: false,
    abstainCost: DEFAULT_ROUND_TRIP_PCT,
    family2: false,
    showTraining: false,
    dryRun: false,
    annotateLegacy: false,
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
      case '--axes': {
        const axes = parseNumberList(next(), '--axes');
        const unknown = axes.filter((h) => !HORIZONS.includes(h));
        if (unknown.length > 0) {
          throw new Error(`계열을 안 만든 축입니다: ${unknown.join(',')} (가능: ${HORIZONS.join(',')})`);
        }
        options.axes = axes;
        break;
      }
      case '--eval-costs':
        options.evalCosts = parseNumberList(next(), '--eval-costs');
        break;
      case '--block-b':
        options.blockB = true;
        break;
      case '--placebo-families':
        options.placeboFamilies = Number(next());
        break;
      case '--placebo-axis': {
        const value = Number(next());
        if (!HORIZONS.includes(value)) {
          throw new Error(`--placebo-axis는 ${HORIZONS.join(',')} 중 하나여야 합니다: ${value}`);
        }
        options.placeboAxis = value;
        break;
      }
      case '--anti':
        options.anti = true;
        break;
      case '--mirror':
        options.mirror = true;
        break;
      case '--abstain-score':
        options.abstainScore = true;
        break;
      case '--cost': {
        const value = Number(next());
        if (!Number.isFinite(value) || value < 0) {
          throw new Error('--cost는 0 이상의 숫자여야 합니다(단위 %)');
        }
        options.abstainCost = value;
        break;
      }
      case '--family2':
        options.family2 = true;
        break;
      case '--show-training':
        options.showTraining = true;
        break;
      case '--dry-run':
        // 원장에 안 쓴다. 실행 시간을 재거나 표만 보고 싶을 때.
        options.dryRun = true;
        break;
      case '--annotate-legacy':
        // ★ 옛 walk-forward 줄 2개의 note에 "독립 검정 아님"을 덧붙인다. 줄은 안 늘어난다.
        options.annotateLegacy = true;
        break;
      case '--limit-symbols':
        // ★ 시간을 재려고 줄일 때만. 시장을 대표하지 않으므로 판정에 쓰지 않는다.
        options.limitSymbols = Number(next());
        break;
      default:
        throw new Error(`모르는 인자입니다: ${arg}`);
    }
  }
  if (!Number.isInteger(options.placeboFamilies) || options.placeboFamilies < 0) {
    throw new Error('--placebo-families는 0 이상의 정수여야 합니다');
  }
  if (options.axes.length === 0) throw new Error('--axes가 비었습니다');
  return options;
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
 *
 * ── ★ `is_active`로 거르지 않는다 (2026-08-14) ───────────────────────────
 *
 * 여기 `AND is_active = true`가 있었다. 그러면 **폐지 종목이 통째로 빠진다** —
 * 봉을 애써 받아 놔도 유니버스에 못 들어오므로 생존편향이 그대로 남는다.
 * 조건을 뺐을 때 실제로 무엇이 들어오는지 세어 보고 지웠다(2026-08-14 실측,
 * 국내 주식 KOSPI/KOSDAQ 중 봉이 있는 종목):
 *
 *   is_active=false · 최근 봉 없음   803종목  ← 폐지. 이것이 들어와야 한다
 *   is_active=true  · 최근 봉 없음     3종목  ← 마스터가 안 지워진 것
 *   is_active=false · 최근 봉 있음     0종목  ← 없다. 그래서 문을 열어도 안 번진다
 *
 * ★ **`is_active`는 폐지 여부의 답이 아니다.** 코스닥→코스피 이전상장이 KIND에
 * 폐지로 기록되는데 그 종목들은 오늘도 거래된다(신세계푸드·LG유플러스·엘앤에프…).
 * 폐지 목록 1,287건 중 131건이 마스터에 살아 있고, 사유 글로도 갈리지 않는다
 * (그중 66건은 사유가 이전상장이 아니다). **계열이 실제로 끊겼는지는 봉이 말한다** —
 * 그래서 여기서는 자격만 보고, 끊긴 자리 판정은 `scanAdjustmentBreaks`가 한다.
 */
async function loadEligibleSymbols(): Promise<{
  symbols: Set<string>;
  preferred: number;
  inactive: number;
}> {
  const { rows } = await pool.query<{ symbol: string; preferred: boolean; is_active: boolean }>(
    `SELECT symbol, (right(symbol, 1) <> '0' OR name ~ '우[A-Z]?$') AS preferred, is_active
     FROM instruments
     WHERE country = 'KR' AND asset_type = 'stock' AND market IN ('KOSPI', 'KOSDAQ')
     ORDER BY symbol`,
  );
  const usable = rows.filter((r) => !r.preferred);
  return {
    symbols: new Set(usable.map((r) => r.symbol)),
    preferred: rows.length - usable.length,
    inactive: usable.filter((r) => !r.is_active).length,
  };
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
  verbose = true,
): CellSeries[] {
  const cells: CellSeries[] = [];
  const startedAt = Date.now();
  for (let i = 0; i < signals.length; i += 1) {
    cells.push(
      ...buildCellSeriesSet(
        panel, signals[i], HORIZONS, universe, 'nextOpen', BUCKETS, UNIVERSE.minNamesPerDay,
      ),
    );
    if (verbose && ((i + 1) % 5 === 0 || i === signals.length - 1)) {
      console.log(
        `  ${label} ${i + 1}/${signals.length}종 · 칸 ${cells.length}`
        + ` · ${elapsed(startedAt)} · 힙 ${heapMb()}MB`,
      );
    }
  }
  return cells;
}

/**
 * 위약 한 가족을 같은 절차로 돌린다.
 *
 * ★ **축 자유가 기본이다.** 절차가 축까지 고르는 것이 실제 절차이므로, 그 절차의
 * 귀무분포를 만들려면 위약도 축을 고르게 둬야 한다. 대신 가족마다 **어느 축을
 * 골랐는지**를 찍는다 — 위약이 전부 같은 축을 고르면 그 귀무분포는 그 축의
 * 이야기라, 다른 축의 실신호와 견줄 때 그 사실을 알고 봐야 한다.
 * `--placebo-axis`로 축을 맞춰 견줄 수도 있다.
 */
function runPlacebo(
  base: Omit<BlockASpec, 'fixHorizon'>,
  cells: CellSeries[],
  axis: number | null,
): WalkForwardResult {
  if (axis !== null) {
    return runBlockA({ ...base, cellSeries: cells, signalsByKey: undefined, fixHorizon: axis });
  }
  return runWalkForward({
    ...base,
    cellSeries: cells,
    signalsByKey: undefined,
    costRoundTripPct: 0,
    selectionCostPct: 0,
    evalCostPct: 0,
    selection: { rule: 'top1', objective: 'netIR', abstainIfNegative: false },
  });
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const startedAt = Date.now();

  console.log('walk-forward 측정 · DB만 본다 (KIS 호출 0회) · 주문을 내지 않는다');
  console.log(
    `데이터셋 ${options.dataset} · 절차 ${options.procedure}`
    + ` · 블록 A 단위 ${WALKFORWARD_BLOCK_A_UNIT}`,
  );
  console.log(
    `진입 basis nextOpen(익일 시가) · 블록 A 비용 0(학습·판정 모두)`
    + ` · 손익분기 비용 ${options.evalCosts.map((c) => `${c.toFixed(2)}%`).join('/')}`,
  );

  if (options.annotateLegacy) {
    const updated = await annotateWalkforwardDependencyNote();
    console.log(
      `\n★ 옛 ${WALKFORWARD_RUN_UNIT} 줄 ${updated}개의 note에`
      + ' "확장·이동 선택 15/15 동일 → 독립 검정 아님"을 덧붙였다 (줄 수는 안 늘었다).',
    );
  }

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
  // ★ 이 수가 0이면 폐지 종목이 유니버스에 없다는 뜻이다 — 그때 나온 값은 생존편향 위에 있다.
  console.log(`  그중 마스터에 비활성인 종목 ${eligible.inactive}종 — 폐지 계열이 유니버스에 들어와 있다.`);

  const panelStartedAt = Date.now();
  const loaded = await loadPanel(targets);
  const { panel } = loaded;
  console.log(
    `패널 ${panel.symbols.length}종목 × ${panel.days.length}거래일`
    + ` · 봉 ${loaded.barCount.toLocaleString('ko-KR')} · ${elapsed(panelStartedAt)} · 힙 ${heapMb()}MB`,
  );
  console.log(`기간 ${panel.days[0]} ~ ${panel.days[panel.days.length - 1]}`);

  /*
   * ★ **생존편향의 크기를 여기서 찍는다.** 결과 아래 각주로 두면 다 읽은 뒤에
   * "그런데 이 표본은…"을 만나게 된다. `survivorshipExposed: true` 불리언만으로는
   * 아무도 크기를 모른다.
   */
  console.log(`\n${'━'.repeat(78)}`);
  console.log('★ 이 표본이 무엇인가 — 생존편향의 크기');
  console.log('━'.repeat(78));
  const survivorship = describeSurvivorship(
    scanSurvivorship(panel, SURVIVORSHIP_CUTOFF),
    KIND_DELISTING_GAP,
  );
  for (const line of survivorship) console.log(line);

  // ── 유니버스 ───────────────────────────────────────────────────────────
  const maskStartedAt = Date.now();
  const universe = buildUniverseMask(panel, {
    ...UNIVERSE,
    scoreGateSignals: usable,
    eligibleSymbols: new Set(targets),
  });
  const { adjustment } = universe;
  console.log(`\n유니버스 · ${elapsed(maskStartedAt)} · 힙 ${heapMb()}MB`);
  console.log(
    `  수정주가 파탄 ${adjustment.breaks.length}건 · 걸린 종목 ${adjustment.brokenSymbols}개`
    + ` → 그 앞 ${adjustment.droppedBars.toLocaleString('ko-KR')}봉`
    + ` (전체의 ${(adjustment.droppedShare * 100).toFixed(2)}%) 버림`,
  );
  /*
   * ★ 면제는 **판정을 바꾸는 손잡이**라 크기를 함께 적는다. 이 수가 크면
   * 그만큼 "파탄이 아니라 폐지 손실"이라고 부른 것이고, 잘못 넓히면 진짜
   * 수정주가 파탄이 계열에 섞여 들어온다.
   */
  console.log(
    `  ★ 그중 정리매매로 보고 면제한 것 ${adjustment.exemptedBreaks.length}건`
    + ` · 종목 ${adjustment.exemptedSymbols}개 — 계열이 끝난 종목의 마지막`
    + ` ${DEFAULT_ADJUSTMENT_SCAN.finalRunExemptBars}봉이다. 그 봉은 버리지 않는다(폐지 손실).`,
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

  /** 블록 A 공통 부분. 비용 셋(`costRoundTripPct`·학습·판정)은 `runBlockA`가 0으로 박는다 */
  const blockABase: Omit<BlockASpec, 'fixHorizon'> = {
    panel,
    cellSeries,
    universe,
    trainMode: options.procedure,
    rollingYears: 10,
    validationStarts: VALIDATION_STARTS,
    embargoDays: EMBARGO_DAYS,
    selection: { rule: 'top1', objective: 'netIR', abstainIfNegative: false },
    buckets: BUCKETS,
    minNamesPerDay: UNIVERSE.minNamesPerDay,
    signalsByKey: new Map(usable.map((s) => [s.key, s])),
    survivorshipExposed: true,
    cashPerPosition: 1_000_000,
  };

  // ── 블록 A ─────────────────────────────────────────────────────────────
  console.log(`\n${'━'.repeat(78)}`);
  console.log('블록 A — **정보가 있나** (비용 0 · 기권 없음 · 축 고정)');
  console.log('━'.repeat(78));
  const blockAStartedAt = Date.now();
  const blockA = options.axes.map((horizon) => runBlockA({ ...blockABase, fixHorizon: horizon }));
  console.log(`축 ${options.axes.length}개 · ${elapsed(blockAStartedAt)} · 힙 ${heapMb()}MB`);

  console.log(`\n창 ${blockA[0]?.windows.length ?? 0}개 · embargo ${EMBARGO_DAYS}거래일 (전 축 고정)`);
  for (const result of blockA) {
    console.log(`\n  축 ${result.fixHorizon}일 — 고른 것`);
    console.log('    학습                     검증                     고른 것          진입');
    for (const window of result.windows) {
      const chosen = window.selected === 'cash'
        ? '현금(고를 칸이 없다)'
        : `${window.selected.signalKey} ${window.selected.horizon}일`;
      console.log(
        `    ${window.trainFrom}~${window.trainTo}  ${window.validFrom}~${window.validTo}`
        + `  ${chosen.padEnd(22)}${String(window.oosEntries).padStart(6)}`,
      );
    }
  }

  if (options.showTraining) {
    console.log('\n★ 학습 순위 — **이것은 결론이 아니다.** 표본 안에서 제일 좋아 보인 것일 뿐이다.');
    for (const result of blockA) {
      console.log(`  축 ${result.fixHorizon}일`);
      for (const window of result.windows) {
        const top = window.ranked.slice(0, 5)
          .map((r) => `${r.signalKey}${r.horizon} ${r.trainNetIR.toFixed(2)}`)
          .join(' · ');
        console.log(`    ${window.validFrom}  ${top}`);
      }
    }
  } else {
    console.log('\n(학습 순위는 안 찍는다 — 찍히면 결론으로 읽힌다. 보려면 --show-training)');
  }

  // ── 손익분기표와 판정문 ────────────────────────────────────────────────
  const breakEven = buildBreakEvenTable(blockA, options.evalCosts);
  const beatsSomething = anyAxisBeatsCost(breakEven);

  const verdictLines: string[] = [];
  for (const result of blockA) {
    verdictLines.push('');
    verdictLines.push(`── 축 ${result.fixHorizon}일 ${'─'.repeat(60)}`);
    verdictLines.push(...describeVerdict(result));
  }

  /*
   * ★ **비용을 넘는 축이 하나도 없으면 표를 먼저 찍는다.** t는 "정보가 있나"의
   * 답이고 이 표가 "돈이 되나"의 답이다. 순서를 바꾸면 유의한 t를 먼저 읽고
   * "그러니까 된다"로 넘어간다.
   */
  console.log(`\n${'━'.repeat(78)}`);
  if (!beatsSomething) {
    for (const line of describeBreakEvenTable(breakEven)) console.log(line);
    console.log('\n아래 t는 **"정보가 있나"의 답일 뿐이다.** 위 표가 이미 "돈은 안 된다"고 말했다.');
    for (const line of verdictLines) console.log(line);
  } else {
    console.log('표본 밖 결과 (블록 A · 비용 0)');
    for (const line of verdictLines) console.log(line);
    console.log('');
    for (const line of describeBreakEvenTable(breakEven)) console.log(line);
  }

  // ── 반증 ───────────────────────────────────────────────────────────────
  const antiByAxis: WalkForwardResult[] = [];
  const mirrorByAxis: WalkForwardResult[] = [];
  const bottomLegByAxis: WalkForwardResult[] = [];
  const placeboTs: number[] = [];

  if (options.anti) {
    console.log(`\n${'━'.repeat(78)}`);
    console.log('★ 안티셀렉션 — 학습 **최하위**를 고른다 (반증 전용, 검정 수에 안 센다)');
    console.log('  ★ 축 고정 + 비용 0에서 돈다. 비용을 넣으면 학습 순위가 아니라 비용 상수를 잰다.');
    for (const horizon of options.axes) {
      const result = runAntiSelection({
        ...blockABase,
        fixHorizon: horizon,
        costRoundTripPct: 0,
        selectionCostPct: 0,
        evalCostPct: 0,
        // 반증에는 쏠림을 안 잰다 — 점수판을 다시 세우는 값이고, 여기서 묻는 것이 아니다.
        signalsByKey: undefined,
        selection: { rule: 'top1', objective: 'netIR', abstainIfNegative: false },
      });
      antiByAxis.push(result);
      console.log(`\n  ── 축 ${horizon}일`);
      for (const line of describeVerdict(result)) console.log(`  ${line}`);
    }
    console.log('\n  → 학습 순위에 정보가 있으면 이 값은 **크기가 비슷한 음수**여야 한다.');
    console.log('    0 근처면 학습 순위가 표본 밖으로 아무것도 안 넘긴다는 뜻이다.');
    console.log('    ★ 축 구성을 반드시 함께 읽어라 — 한 축에 몰려 있으면 그것은 그 축의 이야기다.');
  }

  if (options.mirror) {
    console.log(`\n${'━'.repeat(78)}`);
    console.log('★ 거울 — **선택은 본절차와 같고 평가 다리만 뒤집는다** (반증 전용)');
    for (const horizon of options.axes) {
      const spec: WalkForwardSpec = {
        ...blockABase,
        fixHorizon: horizon,
        costRoundTripPct: 0,
        selectionCostPct: 0,
        evalCostPct: 0,
        signalsByKey: undefined,
        selection: { rule: 'top1', objective: 'netIR', abstainIfNegative: false },
      };
      const mirror = runEvalLegMirror(spec);
      mirrorByAxis.push(mirror);
      console.log(`\n  ── 축 ${horizon}일 · 거울(평가 다리만 뒤집음)`);
      for (const line of describeVerdict(mirror)) console.log(`  ${line}`);

      const bottom = runBottomLegProcedure(spec);
      bottomLegByAxis.push(bottom);
      console.log(`  ── 축 ${horizon}일 · **하위분위 전략** (거울이 아니다 — 다른 칸을 고른다)`);
      console.log(
        `     고른 칸의 축 ${describeHorizonMix(bottom)}`
        + ` · 신호 ${describeSelectedSignals(bottom)}`,
      );
      console.log(`     (본절차·거울이 고른 신호 ${describeSelectedSignals(mirror)})`);
      console.log(
        `     진입 ${bottom.oosEntryExcess.length.toLocaleString('ko-KR')}건`
        + ` · 연 알파 ${pct(bottom.alphaAnnual)} · 판정 t ${signed(bottom.verdictT)}`,
      );
      const sameCell = mirror.windows.every((w, i) => {
        const other = bottom.windows[i]?.selected;
        if (w.selected === 'cash' || other === 'cash' || other === undefined) {
          return w.selected === other;
        }
        return w.selected.signalKey === other.signalKey && w.selected.horizon === other.horizon;
      });
      console.log(
        `     두 절차가 같은 칸을 골랐나: ${sameCell ? '그렇다' : '**아니다**'}`
        + ' — 다르면 이것은 거울이 아니라 다른 전략이다.',
      );
    }
    console.log('\n  → 거울은 부호가 갈려야 한다. 같은 부호면 표본이 통째로 가진 성질이다.');
    console.log('    하위분위 전략은 **다른 질문의 답**이라 부호 비교에 쓰지 않는다.');
  }

  if (options.placeboFamilies > 0) {
    console.log(`\n${'━'.repeat(78)}`);
    console.log('★ 위약 — 우위가 **없는 것이 확실한** 신호로 같은 절차를 돌린다 (반증 전용)');
    console.log(
      `  가족 ${options.placeboFamilies}개 × ${usable.length}종`
      + ` · 축 ${options.placeboAxis === null ? '자유(칸이 고른다)' : `고정 ${options.placeboAxis}일`}`,
    );
    const placeboStartedAt = Date.now();
    for (let f = 0; f < options.placeboFamilies; f += 1) {
      const signals = makePlaceboSignals(f * usable.length + 1, (f + 1) * usable.length);
      const cells = buildCells(panel, universe, signals, `위약 가족 ${f + 1}`, false);
      const result = runPlacebo(blockABase, cells, options.placeboAxis);
      placeboTs.push(result.verdictT);
      console.log(
        `  가족 ${String(f + 1).padStart(2)} · 판정 t ${signed(result.verdictT)}`
        + ` · 연 알파 ${pct(result.alphaAnnual)}`
        + ` · 진입 ${result.oosEntryExcess.length.toLocaleString('ko-KR')}건`
        + ` · 축 ${describeHorizonMix(result)}`,
      );
    }
    const summary = summarizePlacebo(placeboTs);
    console.log(
      `\n  → 위약 ${summary.families}가족 · |판정 t| 95분위 ${summary.absT95.toFixed(2)}`
      + ` · 최대 ${summary.absTMax.toFixed(2)} · ${elapsed(placeboStartedAt)}`,
    );
    console.log('    실신호의 판정 t가 이보다 크지 않으면, 나온 값은 절차가 만든 것이다.');
  } else {
    console.log('\n(위약을 안 돌렸다 — 경험적 귀무분포가 없으면 블록 A 판정은 보류다)');
  }

  // ── 블록 B ─────────────────────────────────────────────────────────────
  if (options.blockB) {
    console.log(`\n${'━'.repeat(78)}`);
    console.log('블록 B — **비용을 넘나** (기권 없음 · 비용을 학습·판정 양쪽에)');
    console.log('  ★ 여기에 t를 안 찍는다. 이건 추정이지 검정이 아니다 — **원장에도 안 쓴다.**');
    console.log('   비용    축    진입      현금창   왕복당 순우위       연 알파   고른 칸의 축');
    for (const cost of options.evalCosts) {
      for (const horizon of options.axes) {
        const result = runWalkForward({
          ...blockABase,
          fixHorizon: horizon,
          costRoundTripPct: cost,
          signalsByKey: undefined,
          selection: { rule: 'top1', objective: 'netIR', abstainIfNegative: false },
        });
        const perEntry = result.oosEntryExcess.length === 0 ? 0 : meanOf(result.oosEntryExcess);
        console.log(
          `  ${cost.toFixed(2)}%`
          + `${String(horizon).padStart(6)}일`
          + `${result.oosEntryExcess.length.toLocaleString('ko-KR').padStart(9)}`
          + `${`${result.cashWindows}/${result.windows.length}`.padStart(9)}`
          + `${pct(perEntry).padStart(16)}`
          + `${pct(result.alphaAnnual, 2).padStart(14)}`
          + `   ${describeHorizonMix(result)}`,
        );
      }
    }
  }

  // ── 기권 채점 ──────────────────────────────────────────────────────────
  let abstainScored: WalkForwardResult | null = null;
  if (options.abstainScore) {
    console.log(`\n${'━'.repeat(78)}`);
    console.log(
      `★ 기권 채점 — 기권을 켠 절차(축 자유 · 비용 ${options.abstainCost.toFixed(2)}%)를 돌리고`
      + ' **쉰 창의 반사실**까지 잰다',
    );
    abstainScored = runWalkForward({
      ...blockABase,
      fixHorizon: undefined,
      costRoundTripPct: options.abstainCost,
      collectAbstained: true,
      signalsByKey: undefined,
      selection: { rule: 'top1', objective: 'netIR', abstainIfNegative: true },
    });
    for (const line of describeAbstainSkill(abstainScored)) console.log(line);
  }

  // ── 원장 ───────────────────────────────────────────────────────────────
  /*
   * ★ **반증 요구는 세지 않는다 — 떨어뜨릴 수만 있다.**
   *
   * 거울(`runEvalLegMirror`)·안티셀렉션(`runAntiSelection`)·위약·하위분위 전략은
   * 후보를 **떨어뜨릴 수만 있고** 무언가를 찾아낼 수 없다. 다중검정 부담은
   * "우연히 좋아 보일 기회를 몇 번 줬나"인데 반증은 그 기회를 주지 않는다.
   * 그래서 `runCellCount`에 **0으로 들어간다.** 값만 줄에 남긴다.
   *
   * ★ **블록 B도 안 쓴다.** 비용을 넣고 다시 고른 것은 추정이지 검정이 아니다.
   */
  const cellsThisRun = options.axes.length;
  const priorCells = await cumulativeMeasuredCells(options.dataset, WALKFORWARD_BLOCK_A_UNIT);
  const threshold = bonferroniThreshold(priorCells + cellsThisRun);
  const legacyCells = await cumulativeCellCount();
  const legacyRuns = await cumulativeCellCount(options.dataset, WALKFORWARD_RUN_UNIT);
  console.log(`\n${'━'.repeat(78)}`);
  console.log(
    `이 데이터셋·단위(${WALKFORWARD_BLOCK_A_UNIT})로 지금까지 ${priorCells}칸`
    + ` → 이번 ${cellsThisRun}칸(축 고정)을 더해 ${priorCells + cellsThisRun}칸`
    + ` · 본페로니 문턱 |t| > ${threshold.toFixed(2)}`,
  );
  console.log(
    `(같은 데이터셋의 옛 단위 ${WALKFORWARD_RUN_UNIT} ${legacyRuns}줄과`
    + ` 옛 데이터셋 ${HARNESS_CELL_UNIT} 누적 ${legacyCells}칸은 여기 분모에 넣지 않는다 —`
    + ' 재는 단위가 다르다. 그 2줄은 확장·이동이 15/15창 같은 칸을 골라 독립 검정도 아니었다)',
  );

  const placeboBar = placeboTs.length > 0 ? summarizePlacebo(placeboTs).absT95 : undefined;
  console.log('\n판정 (블록 A · 축마다 하나씩)');
  const passesByAxis = blockA.map((result) => {
    const overBonferroni = Math.abs(result.verdictT) > threshold;
    const overPlacebo = placeboBar === undefined ? false : Math.abs(result.verdictT) > placeboBar;
    const positive = result.alphaAnnual > 0;
    const passes = overBonferroni && overPlacebo && positive;
    console.log(
      `  축 ${String(result.fixHorizon).padStart(2)}일`
      + ` · 판정 t ${signed(result.verdictT)}`
      + ` · 본페로니 ${threshold.toFixed(2)} ${overBonferroni ? '넘음' : '못 넘음'}`
      + ` · 위약 95분위 ${placeboBar === undefined ? '—(안 돌렸다 → 보류)' : `${placeboBar.toFixed(2)} ${overPlacebo ? '넘음' : '못 넘음'}`}`
      + ` · 연 알파 ${pct(result.alphaAnnual)}`
      + `  →  ${passes ? '★ 넘었다' : '넘지 못했다'}`,
    );
    return passes;
  });
  if (!passesByAxis.some(Boolean)) {
    console.log('→ 이 절차가 이 21년에서 **비용 전에도** 문턱을 넘는 정보를 못 찾았다. 그것도 답이다.');
  } else {
    console.log('★ 넘었다고 확정이 아니다. 반증 셋과 손익분기표를 함께 읽어라.');
    console.log('  비용을 넘는지는 **위 손익분기표**가 답한다 — 판정 t는 그 질문에 답하지 않는다.');
  }
  console.log('★ 그리고 표본은 **오늘 살아 있는 종목만**이다 — 맨 위 생존편향 크기를 다시 봐라.');

  if (options.dryRun) {
    console.log('\n--dry-run이라 원장에 안 남긴다.');
  } else {
    const oosYears = VALIDATION_STARTS.length;
    await recordSignalMeasurements(blockA.map((result, index) => ({
      measuredAt: Date.now(),
      signalKey: `walkforward-blockA:${options.procedure}:h${result.fixHorizon}`,
      rationale:
        '축을 고정하고 비용 0으로 "학습 순위가 표본 밖으로 무언가를 넘기나"만 묻는다.'
        + ' 비용을 넣은 채 축을 자유롭게 두면 netIR의 √(252/h)가 h와 무관한 비용 상수에'
        + ' 곱해져 짧은 축을 못 박고, 기권을 켜면 표본의 절반이 비어 버린다.'
        + ' 돈이 되는지는 이 줄이 아니라 손익분기표가 답한다.',
      horizonDays: result.fixHorizon ?? 0,
      periodKey: `walkforward-blockA:${options.procedure}:h${result.fixHorizon}`,
      periodFrom: panel.days[0],
      periodTo: panel.days[panel.days.length - 1],
      universe:
        `krx-stock-nonpreferred-${panel.symbols.length}`
        + `/bars>=120/active55of60/turnover>=1e8&top80%/scoregate${usable.length}/names>=200`,
      symbolsCount: panel.symbols.length,
      daysCount: result.oosEntryExcess.length,
      samples: result.oosEntryExcess.length,
      spreadMean: result.oosEntryExcess.length === 0 ? 0 : meanOf(result.oosEntryExcess),
      spreadMedian: result.oosDaily.length === 0 ? 0 : meanOf(result.oosDaily),
      tStat: result.tNaive,
      alpha: result.alphaAnnual,
      alphaT: result.verdictT,
      beta: result.marketBeta,
      // ★ 축 하나가 한 칸이다. 반증(안티·거울·위약)은 여기 안 들어간다.
      runCellCount: 1,
      bonferroniT: threshold,
      survived: passesByAxis[index],
      note:
        `블록A · 축 고정 ${result.fixHorizon}일 · 비용 0(학습·판정) · 기권 없음`
        + ` · 창 ${result.windows.length} · 현금 창 ${result.cashWindows}`
        + ` · 고른 칸 ${describeHorizonMix(result)}`
        + ` · 후보 ${usable.length}종 · 계열 ${cellSeries.length}칸`
        + ` · 유니버스 날 ${universe.usableDays}`
        + ` · 위약 ${placeboTs.length}가족`
        + (placeboBar === undefined ? '(안 돌림)' : ` |t|95% ${placeboBar.toFixed(2)}`),
      verdictBasis: 'walkforward-blockA',
      datasetKey: options.dataset,
      testUnit: WALKFORWARD_BLOCK_A_UNIT,
      entryBasis: 'nextOpen',
      costRoundTrip: 0,
      oosYears,
      tNeweyWest: result.tNeweyWest,
      tBlockBoot: result.tBlockBootstrap,
      tNonOverlap: result.tNonOverlap,
      verdictT: result.verdictT,
      selectionTurnover: result.selectionTurnover,
      half1Sign: result.halfSigns[0],
      half2Sign: result.halfSigns[1],
      antiT: antiByAxis[index]?.verdictT,
      mirrorT: mirrorByAxis[index]?.verdictT,
      placeboMaxT: placeboTs.length > 0
        ? placeboTs.reduce((a, t) => Math.max(a, Math.abs(t)), 0)
        : undefined,
      survivorshipExposed: true,
      truncatedExits: result.truncatedExits,
      abstainSkillT: abstainScored?.abstainSkillT,
    })));
    console.log(`\n원장에 ${blockA.length}줄(축 ${blockA.length}칸) 남겼다 — 다음 실행은 문턱이 그만큼 오른다.`);
    console.log('★ 반증(안티셀렉션·거울·위약)과 블록 B는 값으로만 남고 검정 수에는 안 센다.');
  }

  console.log(`\n전체 ${elapsed(startedAt)} · 최대 힙 ${heapMb()}MB`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
