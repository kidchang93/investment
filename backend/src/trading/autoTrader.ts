/**
 * 자동매매 러너.
 *
 * 정해진 주기로 깨어나 전략에게 물어보고, 통과하면 주문을 낸다.
 * 전략은 "무엇을 살지"만 정하고, "내도 되는지"는 전부 여기와 리스크 룰이 본다.
 *
 * 안전에 대해 분명히 해 둘 것:
 *
 * - 기본 모드는 `dry_run`이다. 주문 내용을 만들어 기록만 하고 KIS로 보내지 않는다.
 *   검증되지 않은 자동매매를 실계좌에 바로 붙이지 않기 위해서다.
 * - `live`라도 서버 게이트(`KIS_LIVE_ORDER_ENABLED`)와 리스크 룰을 그대로 통과해야
 *   한다. 러너는 그 위에 얹히는 것이지 우회로가 아니다.
 * - 목표 도달·손실 한도·연속 실패에서 스스로 멈춘다. 멈춘 이유는 기록에 남는다.
 *
 * 목표 수익률은 약속이 아니라 정지 조건이다. 어떤 전략도 수익을 보장하지 못한다.
 */

import type {
  AutoTraderConfig,
  AutoTraderState,
  AutoTraderStatus,
  Candle,
  Instrument,
  StrategySignal,
} from '@invest/shared';

import { randomUUID } from 'node:crypto';

import { getKisAccount, type KisAccountConfig } from '../config.js';
import { recordAutoTraderRun } from '../db/autoTrader.js';
import {
  claimClientOrderId,
  completeClaimedOrder,
  getLastBuySubmittedAt,
} from '../db/brokerOrders.js';
import { checkRiskRules } from '../db/riskRules.js';
import {
  getKisDomesticAccountSnapshot,
  getInstrumentIntradayCandles,
  placeKisDomesticOrder,
} from '../kis/rest.js';
import { checkBuyFundamentals } from './fundamentals.js';
import { checkMinHold, describeMinHoldDefer, describeMinHoldSetting } from './minHold.js';
import {
  candleTargets,
  classifyCandles,
  describeCandleSkips,
  type CandleCandidate,
  type CandleSkip,
} from './runCandles.js';
import { getStrategy, type StrategyContext } from './strategy.js';

/**
 * 후보 종목의 분봉을 받는 데 쓸 호출 예산. 호출 제한을 태우지 않는다.
 *
 * **보유 종목은 이 예산 밖이다.** 자르면 팔 수 없는 종목이 생긴다 — 근거는
 * `runCandles.ts`의 `candleTargets` 주석에 있다. 한 회차 호출 수는
 * `max(이 값, 보유 종목 수)`다.
 */
const MAX_CANDIDATES_PER_RUN = 8;

/** 이만큼 연속으로 실패하면 멈춘다. 같은 오류로 무한히 주문을 시도하지 않게 한다. */
const MAX_CONSECUTIVE_ERRORS = 3;

export interface AutoTraderDeps {
  /**
   * 후보 종목을 고르는 함수. 테스트에서 갈아끼운다.
   * 비어 있을 때는 왜 비었는지(`note`)를 함께 준다 — 그대로 실행 기록에 남는다.
   */
  loadCandidates(
    accountId: string,
    cash: number,
  ): Promise<{ instruments: Instrument[]; note?: string }>;
  /**
   * 보유 종목의 `Instrument`. KIS 잔고는 종목코드만 주는데 전략은 instrumentId로
   * 이야기한다.
   *
   * **후보 목록에서 찾지 않고 따로 받는다.** 후보에서 빠진 보유 종목은 매도
   * 신호가 날 수 없어 갇히기 때문이다. 못 찾은 코드는 그냥 빠진다 —
   * 없는 것을 지어내지 않고 회차 기록에 몇 개를 못 찾았는지 적는다.
   */
  loadHeldInstruments(symbols: string[]): Promise<Instrument[]>;
}

interface RunnerHandle {
  timer: NodeJS.Timeout | null;
  state: AutoTraderState;
  consecutiveErrors: number;
  busy: boolean;
}

const runners = new Map<string, RunnerHandle>();

export function getAutoTraderState(accountId: string): AutoTraderState | null {
  return runners.get(accountId)?.state ?? null;
}

export function listAutoTraderStates(): AutoTraderState[] {
  return [...runners.values()].map((handle) => handle.state);
}

/** 러너를 세우고 이유를 남긴다. 이미 멈춰 있으면 아무것도 하지 않는다. */
export async function stopAutoTrader(
  accountId: string,
  status: AutoTraderStatus,
  reason: string,
): Promise<AutoTraderState | null> {
  const handle = runners.get(accountId);
  if (!handle || handle.state.status === 'stopped') return handle?.state ?? null;
  if (handle.timer) clearInterval(handle.timer);
  handle.timer = null;
  handle.state.status = status;
  handle.state.stopReason = reason;
  handle.state.stoppedAt = Date.now();
  await recordAutoTraderRun({
    accountId,
    status,
    message: `정지: ${reason}`,
    equity: handle.state.currentEquity,
  });
  return handle.state;
}

export async function startAutoTrader(
  config: AutoTraderConfig,
  deps: AutoTraderDeps,
): Promise<AutoTraderState> {
  await stopAutoTrader(config.accountId, 'stopped', '새 설정으로 다시 시작');

  const strategy = getStrategy(config.strategy);
  if (!strategy) throw new Error(`알 수 없는 전략입니다: ${config.strategy}`);
  if (config.targetEquity <= config.stopEquity) {
    throw new Error('목표 금액은 중단 금액보다 커야 합니다.');
  }

  const account = getKisAccount(config.accountId);
  if (!account) throw new Error(`등록되지 않은 계좌입니다: ${config.accountId}`);
  const snapshot = await getKisDomesticAccountSnapshot(account);
  if (!snapshot.configured) throw new Error('계좌를 조회할 수 없어 시작하지 않았습니다.');
  const startEquity = snapshot.totalEvaluation ?? snapshot.cashBalance ?? 0;

  const state: AutoTraderState = {
    config,
    status: 'running',
    startEquity,
    currentEquity: startEquity,
    startedAt: Date.now(),
    recentRuns: [],
    // 이 값은 서버 라우트가 DB 조회 결과로 덮어쓴다. 러너 자체는 로그를 안 읽는다.
    recentRunsHasMore: false,
  };
  const handle: RunnerHandle = { timer: null, state, consecutiveErrors: 0, busy: false };
  runners.set(config.accountId, handle);

  await recordAutoTraderRun({
    accountId: config.accountId,
    status: 'running',
    message:
      `시작 · ${strategy.label} · ${config.mode === 'dry_run' ? '모의 실행(주문 전송 안 함)' : '실주문'}` +
      ` · 목표 ${config.targetEquity.toLocaleString()}원 · 중단 ${config.stopEquity.toLocaleString()}원` +
      // 매도를 미루는 설정이라 어떤 값으로 돌았는지가 기록에 남아야 한다.
      ` · ${describeMinHoldSetting(config.minHoldMinutes)}`,
    equity: startEquity,
  });

  handle.timer = setInterval(() => {
    void tick(config.accountId, deps);
  }, Math.max(10, config.intervalSeconds) * 1000);

  // 첫 회차는 기다리지 않고 바로 돈다.
  void tick(config.accountId, deps);
  return state;
}

/**
 * 한 회차.
 *
 * 이전 회차가 아직 돌고 있으면 건너뛴다. KIS 조회가 느릴 때 회차가 겹쳐
 * 같은 신호로 주문이 두 번 나가는 것을 막는다.
 */
async function tick(accountId: string, deps: AutoTraderDeps): Promise<void> {
  const handle = runners.get(accountId);
  if (!handle || handle.state.status !== 'running' || handle.busy) return;
  handle.busy = true;
  try {
    await runOnce(handle, deps);
    handle.consecutiveErrors = 0;
  } catch (e) {
    handle.consecutiveErrors += 1;
    const message = e instanceof Error ? e.message : String(e);
    await recordAutoTraderRun({
      accountId,
      status: 'running',
      message: `회차 실패(${handle.consecutiveErrors}/${MAX_CONSECUTIVE_ERRORS}): ${message}`,
      equity: handle.state.currentEquity,
    });
    if (handle.consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
      await stopAutoTrader(accountId, 'error', `연속 ${MAX_CONSECUTIVE_ERRORS}회 실패`);
    }
  } finally {
    handle.busy = false;
  }
}

async function runOnce(handle: RunnerHandle, deps: AutoTraderDeps): Promise<void> {
  const { config } = handle.state;
  const strategy = getStrategy(config.strategy);
  if (!strategy) throw new Error(`알 수 없는 전략입니다: ${config.strategy}`);

  const account = getKisAccount(config.accountId);
  if (!account) throw new Error(`등록되지 않은 계좌입니다: ${config.accountId}`);
  const snapshot = await getKisDomesticAccountSnapshot(account);
  const equity = snapshot.totalEvaluation ?? snapshot.cashBalance ?? 0;
  handle.state.currentEquity = equity;

  // 목표·한도는 주문을 내기 전에 본다. 이미 도달했는데 한 번 더 사는 일이 없도록.
  if (equity >= config.targetEquity) {
    await stopAutoTrader(config.accountId, 'target_reached', `목표 ${config.targetEquity.toLocaleString()}원 도달`);
    return;
  }
  if (equity <= config.stopEquity) {
    await stopAutoTrader(config.accountId, 'stopped_out', `중단선 ${config.stopEquity.toLocaleString()}원 도달`);
    return;
  }

  const cash = snapshot.cashBalance ?? 0;
  /*
   * KIS 잔고는 종목코드(symbol)만 준다. 전략은 instrumentId로 이야기하므로
   * 코드로 종목을 찾아 맞춰준다.
   *
   * **보유 종목은 후보 필터와 무관하게 분봉을 받는다.** 예전에는 후보 앞
   * 8종목만 받고 `positions`도 그 교집합이라, 후보에서 빠진 보유 종목은 매도
   * 신호가 아예 날 수 없었다(`runCandles.ts`의 `candleTargets` 참고).
   */
  const symbolToPosition = new Map(snapshot.positions.map((position) => [position.symbol, position]));
  const heldSymbols = [
    ...new Set(snapshot.positions.filter((position) => position.quantity > 0).map((position) => position.symbol)),
  ];

  const picked = await deps.loadCandidates(config.accountId, cash);
  const heldInstruments = await deps.loadHeldInstruments(heldSymbols);
  const heldIds = new Set(heldInstruments.map((instrument) => instrument.id));
  const targets = candleTargets(heldInstruments, picked.instruments, MAX_CANDIDATES_PER_RUN);
  // 이 회차의 시각. 분봉 날짜 검사와 최소 보유 판정이 같은 시각을 본다.
  const runAt = new Date();
  const loaded = await loadCandles(targets, heldIds, runAt);
  const candidates = loaded.candidates;

  /*
   * 못 본 것을 회차 기록에 남긴다. `신호 없음`과 `볼 수가 없었다`는 다른 사실이다.
   * 종목 마스터에 없는 보유 종목도 여기 센다 — 그 종목은 러너가 팔 수 없다.
   */
  const runNotes: string[] = [];
  const unresolvedHeld = heldSymbols.length - heldInstruments.length;
  if (unresolvedHeld > 0) {
    runNotes.push(`보유 ${unresolvedHeld}종목은 종목 정보를 찾지 못해 판단에서 빠졌습니다`);
  }
  const skipNote = describeCandleSkips(loaded.skipped);
  if (skipNote) runNotes.push(skipNote);

  if (candidates.length === 0) {
    const parts = [picked.note, ...runNotes].filter((part): part is string => Boolean(part));
    await recordAutoTraderRun({
      accountId: config.accountId,
      status: 'running',
      message:
        parts.length > 0 ? `후보 없음 · ${parts.join(' · ')}` : '후보 없음 · 분봉을 받은 종목이 없습니다',
      equity,
    });
    return;
  }

  const positions = candidates
    .map((item) => {
      const held = symbolToPosition.get(item.instrument.symbol);
      return held
        ? { instrumentId: item.instrument.id, quantity: held.quantity, averagePrice: held.averagePrice }
        : null;
    })
    .filter((item): item is NonNullable<typeof item> => item !== null);

  const context: StrategyContext = { candidates, positions, maxPositions: config.maxPositions };
  const signals = strategy.decide(context);
  if (signals.length === 0) {
    /*
     * 보유 종목은 살 대상이 아니므로 후보 수에 섞지 않는다. 섞으면 `후보 8종목`이
     * 실제로는 "살 수 있는 것 0 + 보유 8"인 회차와 구별되지 않는다.
     */
    const heldCount = candidates.filter((item) => heldIds.has(item.instrument.id)).length;
    const scope =
      heldCount > 0
        ? `후보 ${candidates.length - heldCount}종목 · 보유 ${heldCount}종목`
        : `후보 ${candidates.length}종목`;
    await recordAutoTraderRun({
      accountId: config.accountId,
      status: 'running',
      message: [`신호 없음 · ${scope}`, ...runNotes].join(' · '),
      equity,
    });
    return;
  }

  // 신호가 났어도 못 본 종목이 있으면 그 사실은 따로 남긴다. 아래 기록은 신호별이다.
  if (runNotes.length > 0) {
    await recordAutoTraderRun({
      accountId: config.accountId,
      status: 'running',
      message: runNotes.join(' · '),
      equity,
    });
  }

  /*
   * 최소 보유 시간에 쓸 매수 시각. **매도 신호가 있을 때만 조회한다** — 끈 상태
   * (0분)이거나 매수만 난 회차에 DB를 한 번 더 칠 이유가 없다.
   *
   * 조회가 실패하면 **막지 않고 판다.** 모를 때 막힌 쪽에 두는 이 레포의 다른
   * 안전장치들과 반대 방향인데, 이유는 `minHold.ts`의 ★ 절에 있다 — 못 파는 쪽이
   * 훨씬 위험하다. 대신 이번 회차에 최소 보유가 적용되지 않았다는 사실을 남긴다.
   */
  let boughtAtBySymbol = new Map<string, number>();
  if (config.minHoldMinutes > 0 && signals.some((signal) => signal.side === 'sell')) {
    try {
      boughtAtBySymbol = await getLastBuySubmittedAt(config.accountId, heldSymbols);
    } catch (e) {
      await recordAutoTraderRun({
        accountId: config.accountId,
        status: 'running',
        message:
          '매수 시각을 조회하지 못해 이번 회차에는 최소 보유 시간을 적용하지 않았습니다'
          + ` · ${e instanceof Error ? e.message : String(e)}`,
        equity,
      });
    }
  }

  for (const signal of signals) {
    await executeSignal(handle, signal, candidates, positions, cash, equity, account, {
      boughtAtBySymbol,
      nowMs: runAt.getTime(),
    });
  }
}

/** 최소 보유 판정에 필요한 재료. 회차마다 한 번 모아 신호들이 나눠 쓴다. */
interface MinHoldContext {
  /** 종목코드 → 마지막 매수 접수 시각(epoch ms). 없는 종목은 잴 수 없는 것이다 */
  boughtAtBySymbol: Map<string, number>;
  nowMs: number;
}

async function executeSignal(
  handle: RunnerHandle,
  signal: StrategySignal,
  candidates: StrategyContext['candidates'],
  positions: Array<{ instrumentId: string; quantity: number; averagePrice: number }>,
  cash: number,
  equity: number,
  account: KisAccountConfig,
  minHold: MinHoldContext,
): Promise<void> {
  const { config } = handle.state;
  const candidate = candidates.find((item) => item.instrument.id === signal.instrumentId);
  if (!candidate) return;

  const quantity =
    signal.side === 'buy'
      ? Math.floor(cash / candidate.price)
      : (positions.find((position) => position.instrumentId === signal.instrumentId)?.quantity ?? 0);

  if (quantity <= 0) {
    await recordAutoTraderRun({
      accountId: config.accountId,
      status: 'running',
      message:
        signal.side === 'buy'
          ? `${candidate.instrument.name} 매수 보류 · 현금 ${cash.toLocaleString()}원으로 1주(${candidate.price.toLocaleString()}원)를 살 수 없음`
          : `${candidate.instrument.name} 매도 보류 · 보유 수량 없음`,
      instrumentId: signal.instrumentId,
      side: signal.side,
      equity,
    });
    return;
  }

  /*
   * 최소 보유 시간. **매도에만 걸고, 산 지 얼마나 됐는지 모르면 막지 않는다.**
   * 판정은 `minHold.ts`의 순수 함수가 하고 여기서는 기록만 남긴다.
   *
   * `신호 없음`이 아니라 **보류**로 남는다 — "볼 것을 다 보고 낼 신호가 없었다"와
   * "냈는데 미뤘다"는 다른 사실이다. 수량 확인 뒤에 두는 것은, 팔 것 자체가 없으면
   * 그 사실이 더 구체적이기 때문이다.
   */
  const holdDecision = checkMinHold({
    side: signal.side,
    minHoldMinutes: config.minHoldMinutes,
    boughtAtMs: minHold.boughtAtBySymbol.get(candidate.instrument.symbol),
    nowMs: minHold.nowMs,
  });
  if (holdDecision.defer) {
    await recordAutoTraderRun({
      accountId: config.accountId,
      status: 'running',
      message:
        `${candidate.instrument.name} 매도 보류 · ${describeMinHoldDefer(holdDecision, config.minHoldMinutes)}`
        + ` · ${signal.reason}`,
      instrumentId: signal.instrumentId,
      side: signal.side,
      quantity,
      price: candidate.price,
      equity,
    });
    return;
  }

  /*
   * 매수 신호면 재무를 확인한다. 신호가 난 종목 하나만 본다 — 후보 전체를
   * 미리 확인하면 KIS 호출이 72회 더 나가는데 걸러지는 건 순손실 한둘이다.
   *
   * 매도는 확인하지 않는다. 재무가 나쁘다고 팔지 못하게 하면 손실 난 종목에
   * 갇힌다.
   */
  let fundamentalsNote = '';
  if (signal.side === 'buy') {
    const fundamentals = await checkBuyFundamentals(candidate.instrument);
    fundamentalsNote = fundamentals.note;
    if (!fundamentals.allowed) {
      await recordAutoTraderRun({
        accountId: config.accountId,
        status: 'running',
        message:
          `${candidate.instrument.name} 매수 차단 · ${fundamentals.reason}`
          + ` · ${fundamentals.note}`,
        instrumentId: signal.instrumentId,
        side: signal.side,
        quantity,
        price: candidate.price,
        equity,
      });
      return;
    }
  }

  /*
   * 시장가로 낸다. 신호가 난 순간의 가격에 붙어야 해서 지정가로는 체결을 놓친다.
   * 다만 리스크 룰에서 시장가를 막아뒀다면 그 판정이 이긴다.
   *
   * 여기 넘기는 `candidate.price`가 곧 금액 한도를 재는 잣대이므로 **주문 기록에도
   * 같은 값을 남긴다**(`estimatedPrice`). 남기지 않으면 이 주문이 일일 금액 한도에
   * 0원으로 쌓이는데, 러너는 늘 시장가라 한도가 영영 차지 않는다.
   */
  const verdict = await checkRiskRules({
    accountId: config.accountId,
    symbol: candidate.instrument.symbol,
    side: signal.side,
    orderType: 'market',
    quantity,
    price: candidate.price,
  });
  if (!verdict.allowed) {
    await recordAutoTraderRun({
      accountId: config.accountId,
      status: 'running',
      message: `${candidate.instrument.name} ${signal.side === 'buy' ? '매수' : '매도'} 차단 · ${verdict.violations.join(' / ')}`,
      instrumentId: signal.instrumentId,
      side: signal.side,
      quantity,
      price: candidate.price,
      equity,
    });
    return;
  }

  if (config.mode === 'dry_run') {
    await recordAutoTraderRun({
      accountId: config.accountId,
      status: 'running',
      message:
        `[모의 실행] ${candidate.instrument.name} ${signal.side === 'buy' ? '매수' : '매도'} ${quantity}주`
        + ` · ${signal.reason}`
        + (fundamentalsNote ? ` · ${fundamentalsNote}` : ''),
      instrumentId: signal.instrumentId,
      side: signal.side,
      quantity,
      price: candidate.price,
      equity,
    });
    return;
  }

  /*
   * 멱등성 키를 먼저 선점한다. 회차 겹침은 busy 플래그로 막지만, 그것만으로는
   * KIS 호출이 타임아웃 뒤 재시도되는 경우를 막지 못한다. 잡지 못했다면 이미
   * 나간 주문이므로 보내지 않는다.
   *
   * 선점이 DB 오류로 실패하면 중복인지 알 수 없으니 보내지 않는다 — 자동매매는
   * 사람이 지켜보지 않는 상태로 도는 만큼 모르면 멈추는 쪽이 안전하다.
   */
  const clientOrderId = randomUUID();
  const claimed = await claimClientOrderId(config.accountId, clientOrderId, 'place');
  if (!claimed) {
    await recordAutoTraderRun({
      accountId: config.accountId,
      status: 'running',
      message: `${candidate.instrument.name} 주문 건너뜀 · 같은 주문 키가 이미 처리됨`,
      instrumentId: signal.instrumentId,
      side: signal.side,
      equity,
    });
    return;
  }

  let result;
  try {
    result = await placeKisDomesticOrder(account, {
      symbol: candidate.instrument.symbol,
      side: signal.side,
      orderType: 'market',
      quantity,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await completeClaimedOrder(clientOrderId, {
      status: 'rejected',
      message,
      side: signal.side,
      symbol: candidate.instrument.symbol,
      orderType: 'market',
      quantity,
      estimatedPrice: candidate.price,
    });
    throw e;
  }
  await completeClaimedOrder(clientOrderId, {
    status: 'submitted',
    message: result.message,
    side: signal.side,
    symbol: candidate.instrument.symbol,
    orderType: 'market',
    quantity,
    estimatedPrice: candidate.price,
    orderNo: result.orderNo,
    orderBranchNo: result.orderBranchNo,
  });
  await recordAutoTraderRun({
    accountId: config.accountId,
    status: 'running',
    message:
      `${candidate.instrument.name} ${signal.side === 'buy' ? '매수' : '매도'} ${quantity}주 접수`
      + ` · 주문번호 ${result.orderNo || '-'} · ${signal.reason}`
      // 실제로 나간 주문일수록 왜 샀는지가 남아야 한다. 나중에 채점할 근거다.
      + (fundamentalsNote ? ` · ${fundamentalsNote}` : ''),
    instrumentId: signal.instrumentId,
    side: signal.side,
    quantity,
    price: candidate.price,
    equity,
  });
}

interface LoadedCandles {
  candidates: StrategyContext['candidates'];
  /** 분봉을 쥐지 못해 이번 회차 판단에서 빠진 종목 */
  skipped: CandleSkip[];
}

/**
 * 종목마다 분봉을 받아 온다. 한 종목이 실패해도 나머지로 계속 판단한다.
 *
 * **마지막 봉이 오늘(KST) 것이 아니면 뺀다.** 그 날짜에 봉이 없으면 KIS가 이전
 * 거래일 것을 정상 응답으로 채워 주기 때문이다 — 그대로 쓰면 어제 15:30 종가로
 * 신호가 나고 주문 수량이 정해진다. 판정과 근거는 `runCandles.ts`에 있다.
 *
 * 뺀 것은 `신호 없음`이 아니라 **제외**로 돌려준다. 둘은 다른 사실이고, 실행
 * 기록에 사유가 남아야 한다.
 */
async function loadCandles(
  targets: Instrument[],
  heldIds: Set<string>,
  now: Date,
): Promise<LoadedCandles> {
  const loaded = await Promise.all(
    targets.map(async (instrument) => {
      const held = heldIds.has(instrument.id);
      // 실패를 빈 배열로 넘기지 않는다. null이 "못 받았다"는 사실을 들고 간다.
      let candles: Candle[] | null;
      try {
        candles = (await getInstrumentIntradayCandles(instrument)).candles;
      } catch {
        candles = null;
      }
      return classifyCandles(instrument, candles, held, now);
    }),
  );
  return {
    candidates: loaded
      .map((item) => item.candidate)
      .filter((item): item is CandleCandidate => item !== undefined),
    skipped: loaded.map((item) => item.skip).filter((item): item is CandleSkip => item !== undefined),
  };
}
