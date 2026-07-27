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
import { claimClientOrderId, completeClaimedOrder } from '../db/brokerOrders.js';
import { checkRiskRules } from '../db/riskRules.js';
import {
  getKisDomesticAccountSnapshot,
  getInstrumentIntradayCandles,
  placeKisDomesticOrder,
} from '../kis/rest.js';
import { checkBuyFundamentals } from './fundamentals.js';
import { getStrategy, type StrategyContext } from './strategy.js';

/** 러너가 한 회차에 KIS를 때리는 횟수를 묶어두는 상한. 호출 제한을 태우지 않는다. */
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
      ` · 목표 ${config.targetEquity.toLocaleString()}원 · 중단 ${config.stopEquity.toLocaleString()}원`,
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
   * 후보 목록에서 같은 코드를 찾아 맞춰준다. 후보에 없는 보유 종목은 이번 회차에
   * 판단 대상이 아니다 — 분봉을 못 받았다는 뜻이라 신호를 낼 근거가 없다.
   */
  const symbolToPosition = new Map(snapshot.positions.map((position) => [position.symbol, position]));

  const picked = await deps.loadCandidates(config.accountId, cash);
  const candidates = await loadCandles(picked.instruments.slice(0, MAX_CANDIDATES_PER_RUN));
  if (candidates.length === 0) {
    await recordAutoTraderRun({
      accountId: config.accountId,
      status: 'running',
      message: picked.note
        ? `후보 없음 · ${picked.note}`
        : '후보 종목의 분봉을 받지 못했습니다.',
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
    await recordAutoTraderRun({
      accountId: config.accountId,
      status: 'running',
      message: `신호 없음 · 후보 ${candidates.length}종목`,
      equity,
    });
    return;
  }

  for (const signal of signals) {
    await executeSignal(handle, signal, candidates, positions, cash, equity, account);
  }
}

async function executeSignal(
  handle: RunnerHandle,
  signal: StrategySignal,
  candidates: StrategyContext['candidates'],
  positions: Array<{ instrumentId: string; quantity: number; averagePrice: number }>,
  cash: number,
  equity: number,
  account: KisAccountConfig,
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

/** 후보마다 분봉을 받아 온다. 한 종목이 실패해도 나머지로 계속 판단한다. */
async function loadCandles(instruments: Instrument[]): Promise<StrategyContext['candidates']> {
  const loaded = await Promise.all(
    instruments.map(async (instrument) => {
      try {
        const response = await getInstrumentIntradayCandles(instrument);
        const candles: Candle[] = response.candles;
        const last = candles[candles.length - 1];
        if (!last) return null;
        return { instrument, candles, price: last.close };
      } catch {
        return null;
      }
    }),
  );
  return loaded.filter((item): item is NonNullable<typeof item> => item !== null);
}
