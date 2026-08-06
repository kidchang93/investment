/**
 * 개장 전에 **지정가로 쓸 수 있는 가격이 있는가**를 정한다.
 *
 * ── 왜 이게 따로 필요한가 ────────────────────────────────────────────────
 *
 * 러너를 08:30에 돌리려면 값이 필요한데, 그 시각 KRX는 닫혀 있다. 그런데
 * `getQuote`는 **오류를 내지 않는다** — 전일 종가를 정상 응답처럼 준다
 * (2026-07-27 08:51 실측: 화면이 "249,500원 0.00%"라고 적는 동안 실제로는
 * 259,500원(+4.01%)에 지시되고 있었다).
 *
 * **그 값으로 지정가를 걸면 어제 가격에 주문을 내는 것이다.** 갭이 큰 날일수록
 * 크게 틀리는데, 갭이 큰 날이 바로 우리가 거래하려는 날이다. 조용히 손해 보는
 * 종류의 오류라 값과 **출처를 함께** 들고 다닌다.
 *
 * ── 시각마다 살아 있는 곳이 다르다 ───────────────────────────────────────
 *
 *   08:00~08:50  NXT 프리마켓 — **실제 체결가**. 연속거래라 값이 계속 움직인다
 *   08:50~09:00  KRX 예상체결가 — 체결이 아니라 지시값이지만 09:00 시가에 가깝다
 *   09:00~15:30  KRX 현재가 — 평소의 그것
 *   그 밖         **살아 있는 값이 없다.** 전일 종가뿐이고 그건 지정가 근거가 아니다
 *
 * ★ 08:50~09:00에 NXT는 **닫혀 있다**(08:50 휴장, 09:00:30 재개). 그래서 그
 * 10분은 예상체결가밖에 없다.
 *
 * ── 이 파일이 지키는 것 ──────────────────────────────────────────────────
 *
 * **살아 있는 값이 없으면 `live: false`를 돌려주고, 호출부는 그때 지정가를
 * 만들지 않는다.** 전일 종가로 "일단 걸어 두는" 길을 열지 않는다 — 시험이
 * 그것을 강제한다.
 */

import { KRX_SESSION_MINUTES } from '@invest/shared';

import type { KisExchange } from '../kis/exchanges.js';
import { kstMinutesOfDay } from './session.js';

/**
 * NXT 프리마켓 08:00~08:50.
 *
 * **넥스트레이드 공식 「거래제도 > 시장구조」의 규정값이고 실측이 아니다.**
 * 우리 관측은 08:51부터라 그 앞을 본 적이 없다([[premarket-and-nxt]]).
 * 08:25에 수집기를 띄우면 잰다.
 */
export const NXT_PRE_MARKET_MINUTES = { open: 8 * 60, close: 8 * 60 + 50 } as const;

/**
 * KRX 예상체결가가 **공개되는** 시각 08:50~09:00.
 *
 * 호가 접수는 08:30부터인데 예상체결가는 08:50부터다 — 2025년에 20분에서
 * 10분으로 단축됐다(키움·신한 안내 교차확인). 그래서 **08:30~08:49는 KRX 쪽에
 * 아무 값도 없다.** 우리 실측이 08:51·08:53이라 그 구간을 본 적이 없어,
 * 이 경계는 아직 문서 근거뿐이다.
 */
export const KRX_EXPECTED_PRICE_MINUTES = { open: 8 * 60 + 50, close: 9 * 60 } as const;

/** 값을 어디서 가져와야 하는가. `none`이면 살아 있는 값이 없다. */
export type PriceSourceKind = 'nxtLast' | 'krxExpected' | 'krxLast' | 'none';

export interface PriceSourcePlan {
  kind: PriceSourceKind;
  /** 어느 거래소에 물을지. `none`이면 물을 곳이 없다 */
  exchange: KisExchange | null;
  /** 기록에 남길 한 마디. 나중에 체결가가 이상할 때 원인을 되짚는 유일한 실마리다 */
  note: string;
}

/**
 * 지금 시각에 **어디에 물어야 하는가**. 그물을 타지 않는 순수 함수라 시험이 쉽다.
 *
 * 경계는 전부 **시작 포함 / 끝 제외**다. 08:50은 NXT가 아니라 예상체결가 쪽이고
 * (그 순간 NXT가 휴장한다), 09:00은 예상체결가가 아니라 정규장 쪽이다.
 */
export function planPriceSource(at: Date): PriceSourcePlan {
  const now = kstMinutesOfDay(at);

  if (now >= NXT_PRE_MARKET_MINUTES.open && now < NXT_PRE_MARKET_MINUTES.close) {
    return {
      kind: 'nxtLast',
      exchange: 'NXT',
      note: 'NXT 프리마켓 체결가 (08:00~08:50)',
    };
  }
  if (now >= KRX_EXPECTED_PRICE_MINUTES.open && now < KRX_EXPECTED_PRICE_MINUTES.close) {
    return {
      kind: 'krxExpected',
      exchange: 'KRX',
      note: 'KRX 예상체결가 (08:50~09:00) — 체결이 아니라 지시값이다',
    };
  }
  if (now >= KRX_SESSION_MINUTES.open && now <= KRX_SESSION_MINUTES.close) {
    return { kind: 'krxLast', exchange: 'KRX', note: 'KRX 현재가' };
  }
  /*
   * 08:50 이전의 KRX 동시호가 접수 구간(08:30~08:49)도 여기로 온다. 호가는 받지만
   * 예상체결가를 안 보여주는 구간이라 **우리가 쓸 값이 없다.** NXT를 안 하는
   * 종목이면 그 시각에는 정말로 아무 값도 없다.
   */
  return {
    kind: 'none',
    exchange: null,
    note: '살아 있는 값이 없는 시각이다 — 전일 종가는 지정가 근거가 아니다',
  };
}

export interface ResolvedPrice {
  /** 지정가로 쓸 값. `live`가 false면 **주문에 쓰면 안 된다** */
  price: number;
  kind: PriceSourceKind;
  /**
   * 이 값이 **지금 시장의 값인가**.
   *
   * false인 경우가 둘이다: 물을 곳이 없는 시각이거나, 물었는데 그 시장에 값이
   * 없는 것(NXT 대상 603종목 밖이면 프리마켓에 값이 없다).
   */
  live: boolean;
  note: string;
}

/**
 * 계획대로 물어서 값을 얻는다. 못 얻으면 **0을 `live: false`로** 돌려준다.
 *
 * 전일 종가로 대신 채우지 않는다 — 값이 있는 것처럼 보이는 순간 호출부가
 * 그것으로 주문을 만든다. 여기서 없으면 없는 것이다.
 */
export async function resolveTradablePrice(
  symbol: string,
  at: Date,
  fetch: {
    /** 해당 거래소의 현재가. 값이 없으면 0이나 NaN을 준다 */
    lastPrice: (symbol: string, exchange: KisExchange) => Promise<number>;
    /** KRX 예상체결가. 동시호가 밖에서는 0이다 */
    expectedPrice: (symbol: string) => Promise<number>;
  },
): Promise<ResolvedPrice> {
  const plan = planPriceSource(at);
  if (plan.kind === 'none' || plan.exchange === null) {
    return { price: 0, kind: 'none', live: false, note: plan.note };
  }

  const raw =
    plan.kind === 'krxExpected'
      ? await fetch.expectedPrice(symbol)
      : await fetch.lastPrice(symbol, plan.exchange);

  if (!Number.isFinite(raw) || raw <= 0) {
    return {
      price: 0,
      kind: plan.kind,
      live: false,
      note: `${plan.note} — 이 종목에는 값이 없다`,
    };
  }
  return { price: raw, kind: plan.kind, live: true, note: plan.note };
}
