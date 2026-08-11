/**
 * 주문을 **어느 거래소로 보낼지** (`EXCG_ID_DVSN_CD`).
 *
 * ★ 조회의 거래소(`exchanges.ts`, `FID_COND_MRKT_DIV_CODE`)와 **다른 필드다.**
 * 값도 다르다 — 조회는 `J`/`NX`/`UN`, 주문은 `KRX`/`NXT`/`SOR`. 섞으면
 * 주문이 엉뚱한 곳으로 가거나 거절된다.
 *
 * ── 확인된 것과 아닌 것 ──────────────────────────────────────────────────
 *
 * `KRX`  이 레포가 실주문으로 확인했다. 지금까지 모든 주문이 이 값이었다
 * `NXT`  **문서 근거만 있다** (개발자센터, 2026-07-29 판독). 보내 본 적 없다
 * `SOR`  같은 문서에 있다. 무엇으로 라우팅되는지 확인 안 했다 — 쓰지 않는다
 *
 * ── ★ 모의투자로는 NXT를 시험할 수 없다 ──────────────────────────────────
 *
 * 개발자센터가 *"미입력시 KRX로 진행되며, **모의투자는 KRX만 가능**"*이라고
 * 적는다. 즉 `APP_ENV=vts`에서는 이 값을 `NXT`로 바꿔도 **검증이 되지 않는다.**
 * 거절되면 "NXT를 못 쓴다"인지 "모의라서 안 되는 것"인지 구분이 안 되고,
 * 접수되면 그건 KRX로 간 것일 수 있다.
 *
 * 그래서 `assertVenueUsable`이 **모의 서버에서 KRX 아닌 값을 아예 막는다.**
 * 검증되지 않은 주문 경로가 조용히 열려 있는 것이 이 레포가 가장 피하는 것이다.
 */

import { config } from '../config.js';

/** 주문을 보낼 거래소. `SOR`은 뜻을 확인하지 못해 넣지 않았다. */
export type OrderVenue = 'KRX' | 'NXT';

/** 지금까지 모든 주문이 쓴 값. 생략하면 이것이다 — 기존 동작이 그대로여야 한다. */
export const DEFAULT_ORDER_VENUE: OrderVenue = 'KRX';

/**
 * 이 거래소로 지금 주문을 보내도 되는가. 안 되면 **보내기 전에** 던진다.
 *
 * 던지는 자리가 중요하다 — 보낸 뒤에 거절을 읽으면 이미 그 서버에 흔적이 남고,
 * 무엇 때문에 거절인지도 흐려진다(`CLAUDE.md` 7-1과 같은 이유다).
 */
export function assertVenueUsable(venue: OrderVenue): void {
  if (venue === DEFAULT_ORDER_VENUE) return;
  if (config.env !== 'prod') {
    throw new Error(
      `주문을 보내지 않았습니다: 모의투자(APP_ENV=vts)는 KRX만 받습니다 — ${venue}로는 검증이 되지 않습니다.`
      + ' 실전 계좌에서만 확인할 수 있습니다.',
    );
  }
}

/**
 * NXT 프리마켓·애프터마켓에는 **시장가가 없다.**
 *
 * 넥스트레이드 공식 「호가유형」 표: 시장가·스톱지정가·중간가는 **메인마켓 전용**이고
 * 프리/애프터는 지정가 계열(지정가·최유리·최우선)만 받는다. 우리 러너는 지금까지
 * **늘 시장가**였으므로, 이 검사가 없으면 프리마켓 주문이 전부 거절된다.
 *
 * ★ 규정 근거이고 실측이 아니다. 실전에서 한 번 내 보면 이 주석을 고칠 수 있다.
 *
 * **시각을 여기서 읽지 않는다.** 장 시간표는 매매 계층(`trading/preOpenPrice.ts`)이
 * 들고 있고, `kis/`가 그것을 다시 물으면 표가 두 곳으로 갈린다. 부르는 쪽이
 * "지금 연장 세션인가"를 넘긴다.
 */
export function venueAcceptsMarketOrder(venue: OrderVenue, inExtendedSession: boolean): boolean {
  if (venue === 'KRX') return true;
  return !inExtendedSession;
}

/**
 * 이 거래소가 **스톱지정가(`22`)를 받는가.**
 *
 * 서로 다른 두 출처가 같은 말을 한다 — 개발자센터 `ORD_DVSN` 표는 `21`~`24`
 * (중간가·스톱지정가)를 KRX·NXT에만 달아 뒀고, 미래에셋은 *"SOR 주문에는
 * 중간가·스톱지정가호가를 제공하지 않는다"*고 적었다.
 *
 * ★ **`OrderVenue` 타입에 없는 `SOR`을 표에 적어 둔 것은 일부러다.** 지금은 타입이
 * 막고 있지만 언젠가 SOR을 열 수 있고, 그때 스톱지정가가 함께 열리면 안 된다.
 * 표에 **없는 값도 `false`**다 — 모르는 거래소에 검증 안 된 주문유형을 보내지 않는다.
 *
 * 삼항 사슬 대신 표로 가른다(`docs/CODE_STYLE.md`).
 */
const VENUE_ACCEPTS_STOP_LIMIT: Record<string, boolean> = {
  KRX: true,
  NXT: true,
  SOR: false,
};

export function venueAcceptsStopLimit(venue: string): boolean {
  return VENUE_ACCEPTS_STOP_LIMIT[venue] === true;
}
