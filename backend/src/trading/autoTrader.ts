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
import { checkRiskRules, getRiskRules, getTodayUsage } from '../db/riskRules.js';
import {
  getKisDomesticAccountSnapshot,
  getInstrumentIntradayCandles,
  placeKisDomesticOrder,
} from '../kis/rest.js';
import { checkBuyFundamentals } from './fundamentals.js';
import { checkMinHold, describeMinHoldDefer, describeMinHoldSetting } from './minHold.js';
import {
  buyQuantityWithinRules,
  describeBuySizeBound,
  spendableCash,
  type BuySize,
} from './orderSizing.js';
import {
  candleTargets,
  classifyCandles,
  describeCandleSkips,
  type CandleCandidate,
  type CandleSkip,
} from './runCandles.js';
import { getStrategy, type StrategyContext } from './strategy.js';

/**
 * 한 회차에 분봉을 받을 종목 수. 호출 제한을 태우지 않는다.
 *
 * **보유 종목이 이 예산을 먼저 먹는다.** 보유는 잘리지 않지만(잘리면 팔 수 없는
 * 종목이 생긴다 — `runCandles.ts`의 `candleTargets`) 자리는 차지하므로, 이 값이
 * `maxPositions`보다 크지 않으면 **자리가 다 찬 순간 후보가 0이 된다.**
 *
 * 2026-08-03에 실제로 그랬다. `maxPositions`를 8로 올렸는데 이 값이 8이라
 * 보유 1종목에 후보가 7종목이었고, 8자리를 채우면 더는 살 후보를 못 본다.
 *
 * ── 20으로 잡은 근거: 모의 서버 호출 예산 ────────────────────────────────
 *
 * 모의(`vts`)는 초당 1회라 호출 간격이 1,100ms다(`KIS_MIN_CALL_GAP_BY_SERVER`).
 * 한 회차가 쓰는 호출은 대략 이렇다.
 *
 *   시세(멀티) 8 + 잔고 2 + 미체결 매수 1 = 11회 ≈ 12초
 *   분봉 = 보유 + 후보, 최대 20회 ≈ 22초
 *   재무 = 매수 신호 하나당 3회. 신호가 몰리면 여기가 제일 크다
 *
 * 주기 60초는 54회가 한계라 신호가 여럿 나면 넘긴다. 그래서 이 값을 올릴 때
 * **주기도 함께 늘려야 한다** — 지금은 120초로 돌린다(109회).
 */
const MAX_CANDIDATES_PER_RUN = 20;

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
  ): Promise<{
    instruments: Instrument[];
    /**
     * 종목별 총 매도잔량. 주문 크기가 호가를 몇 칸 밀지 재는 데 쓴다 —
     * 멀티시세가 이미 주는 값이라 여기서 넘기면 호가 조회가 따로 안 나간다.
     * 값이 없는 종목은 **키가 없다**(0을 넣지 않는다).
     */
    askDepthByInstrumentId: Map<string, number>;
    note?: string;
  }>;
  /**
   * 보유 종목의 `Instrument`. KIS 잔고는 종목코드만 주는데 전략은 instrumentId로
   * 이야기한다.
   *
   * **후보 목록에서 찾지 않고 따로 받는다.** 후보에서 빠진 보유 종목은 매도
   * 신호가 날 수 없어 갇히기 때문이다. 못 찾은 코드는 그냥 빠진다 —
   * 없는 것을 지어내지 않고 회차 기록에 몇 개를 못 찾았는지 적는다.
   */
  loadHeldInstruments(symbols: string[]): Promise<Instrument[]>;
  /**
   * 아직 채워지지 않은 매수 주문의 종목코드.
   *
   * 잔고만 보면 접수와 체결 사이 몇 분 동안 "아직 아무것도 안 샀다"로 보여
   * 같은 종목을 매 회차 다시 산다 — 2026-08-03에 네 번 샀다. 근거는
   * `pendingBuys.ts`에 있다.
   */
  loadPendingBuySymbols(accountId: string): Promise<string[]>;
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

  /*
   * **예수금이 아니라 정산 기준 현금이다.** 예수금은 D+2 결제 전까지 안 줄어서
   * 오늘 6,862만원을 쓰고도 1억으로 보였다 — 근거는 `spendableCash`에 있다.
   */
  const cash = spendableCash(snapshot);
  /*
   * KIS 잔고는 종목코드(symbol)만 준다. 전략은 instrumentId로 이야기하므로
   * 코드로 종목을 찾아 맞춰준다.
   *
   * **보유 종목은 후보 필터와 무관하게 분봉을 받는다.** 예전에는 후보 앞
   * 8종목만 받고 `positions`도 그 교집합이라, 후보에서 빠진 보유 종목은 매도
   * 신호가 아예 날 수 없었다(`runCandles.ts`의 `candleTargets` 참고).
   */
  const symbolToPosition = new Map(snapshot.positions.map((position) => [position.symbol, position]));
  /*
   * **잔고에 아직 안 잡힌 매수 주문도 자리를 차지한 것으로 본다.** 잔고만 보면
   * 접수와 체결 사이 몇 분이 "아직 아무것도 안 샀다"로 보인다 — 2026-08-03에
   * 경방을 네 회차 연속으로 샀고, 자기 주문이 호가를 밀어 체결가가 8,247 →
   * 8,279원으로 계단을 올라갔다. 근거는 `pendingBuys.ts`.
   *
   * 조회가 실패하면 **빈 목록이 아니라 예외**다. 여기서 조용히 비우면 결함이
   * 그대로 돌아오는데, 러너는 그것을 회차 실패로 알릴 수 있다.
   */
  const pendingBuys = new Set(await deps.loadPendingBuySymbols(config.accountId));
  const heldSymbols = [
    ...new Set([
      ...snapshot.positions.filter((position) => position.quantity > 0).map((position) => position.symbol),
      ...pendingBuys,
    ]),
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

  /*
   * 자리를 차지한 종목. 잔고에 잡힌 것과 **주문만 나가 있는 것**이 함께 들어간다.
   *
   * 주문만 나가 있는 쪽은 `quantity: 0`이다. 자리는 먹지만 팔 수는 없다 —
   * 없는 주식을 파는 주문이 나가면 KIS가 거부한다. 전략은 `sellablePositions`로
   * 매도 후보를 거르고 자리 계산은 이 목록 전체로 한다.
   */
  const positions = candidates
    .map((item) => {
      const held = symbolToPosition.get(item.instrument.symbol);
      if (held) {
        return { instrumentId: item.instrument.id, quantity: held.quantity, averagePrice: held.averagePrice };
      }
      if (pendingBuys.has(item.instrument.symbol)) {
        return { instrumentId: item.instrument.id, quantity: 0, averagePrice: 0 };
      }
      return null;
    })
    .filter((item): item is NonNullable<typeof item> => item !== null);

  /*
   * 자리를 먹고 있는 미체결이 있으면 회차 기록에 적는다. 적지 않으면 `신호 없음`만
   * 쌓이고 왜 안 사는지 알 수 없다 — 이 결함이 그렇게 8분 동안 안 보였다.
   */
  const pendingHeldCount = positions.filter((position) => position.quantity <= 0).length;
  if (pendingHeldCount > 0) {
    runNotes.push(`미체결 매수 ${pendingHeldCount}종목이 자리를 차지하고 있습니다`);
  }

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
    }, picked.askDepthByInstrumentId);
  }
}

/** 최소 보유 판정에 필요한 재료. 회차마다 한 번 모아 신호들이 나눠 쓴다. */
interface MinHoldContext {
  /** 종목코드 → 마지막 매수 접수 시각(epoch ms). 없는 종목은 잴 수 없는 것이다 */
  boughtAtBySymbol: Map<string, number>;
  nowMs: number;
}

/**
 * 이 계좌의 리스크 룰을 읽어 살 수 있는 수량을 정한다.
 *
 * 룰과 오늘 쓴 금액을 여기서 한 번 읽는다. 신호가 난 회차에만 부르므로 회차마다
 * 나가는 조회가 아니다. 판정 자체는 `orderSizing.ts`의 순수 함수가 한다.
 */
async function buyQuantityForAccount(
  accountId: string,
  cash: number,
  price: number,
  /* 이번 회차 멀티시세가 준 총 매도잔량. 못 받은 종목은 undefined다 */
  totalAskQuantity: number | undefined,
): Promise<BuySize> {
  const [rules, usage] = await Promise.all([getRiskRules(accountId), getTodayUsage(accountId)]);
  return buyQuantityWithinRules({
    cash,
    price,
    maxOrderQuantity: rules.maxOrderQuantity,
    maxOrderNotional: rules.maxOrderNotional,
    dailyNotionalLimit: rules.dailyNotionalLimit,
    /*
     * **매수 금액만 뺀다.** 여기는 "얼마나 더 태울 수 있나"를 묻는 자리라
     * 매도까지 세면 팔수록 살 수 없어진다. 한도 판정(`dailyLimitViolations`)이
     * 보는 값과 같은 것을 봐야 둘이 갈리지 않는다.
     */
    usedNotional: usage.buyNotional,
    totalAskQuantity,
  });
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
  /*
   * 이번 회차 멀티시세가 준 종목별 총 매도잔량. 주문 크기가 호가를 몇 칸
   * 밀지를 여기서만 알 수 있다 — 값이 없는 종목은 키가 없다.
   */
  askDepthByInstrumentId: Map<string, number>,
): Promise<void> {
  const { config } = handle.state;
  const candidate = candidates.find((item) => item.instrument.id === signal.instrumentId);
  if (!candidate) return;
  const askDepth = askDepthByInstrumentId.get(signal.instrumentId);

  /*
   * 매수 수량은 **리스크 룰 안에서** 정한다. 예전에는 `floor(cash / price)`라
   * 늘 전액이었고, 1회 100만원·일일 500만원 룰이 걸린 예수금 1억 계좌에서는
   * 신호가 날 때마다 세 잣대에 동시에 걸렸다 — 근거와 실측은 `orderSizing.ts`에
   * 적었다. 그 계좌에서 러너는 주문을 낼 수 없는 구조였다.
   *
   * 매도는 줄이지 않는다. 보유한 만큼 판다 — 팔다 남기면 그 종목에 갇히고,
   * 여기서 산 수량이 이미 한도 안이라 매도도 한도 안이다.
   */
  const sizing =
    signal.side === 'buy'
      ? await buyQuantityForAccount(config.accountId, cash, candidate.price, askDepth)
      : undefined;
  const quantity =
    sizing !== undefined
      ? sizing.quantity
      : (positions.find((position) => position.instrumentId === signal.instrumentId)?.quantity ?? 0);

  if (quantity <= 0) {
    await recordAutoTraderRun({
      accountId: config.accountId,
      status: 'running',
      message:
        sizing !== undefined
          ? `${candidate.instrument.name} 매수 보류 · ${describeBuySizeBound(sizing.boundBy)}가 0주입니다`
            + ` · 현금 ${cash.toLocaleString()}원 · 1주 ${candidate.price.toLocaleString()}원`
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
      /*
       * 수량을 무엇이 정했는지와 **그때 호가 잔량의 몇 %였는지**를 남긴다.
       * 잔량 상한 10%는 아직 잰 값이 아니라 출발점이다(`orderSizing.ts`).
       * 실측으로 바꾸려면 이 비율이 체결가 괴리와 짝지어 쌓여 있어야 한다.
       */
      + (sizing ? ` · ${describeBuySizeBound(sizing.boundBy)}` : '')
      + (sizing?.askDepthShare !== undefined
        ? ` · 매도잔량의 ${(sizing.askDepthShare * 100).toFixed(1)}%`
        : '')
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
