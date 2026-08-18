/**
 * 같은 순간에 겹쳐 나가는 KIS 조회를 하나로 묶는다.
 *
 * ── 왜 생겼나 (2026-08-18 실측) ──────────────────────────────────────────
 *
 * 목표 화면을 한 번 여는 데 **같은 계좌의 잔고 조회가 네 번** 나갔다 — 계좌
 * 카드가 두 번(accountId 없이 한 번, 붙여서 한 번), 3층 표가 한 번, 자동화
 * 상태가 한 번. 각각 5~8초라 브라우저의 동시 연결 여섯 개를 다 먹었고,
 * 뒤에 선 요청은 **30초가 지나도 시작조차 못 했다.** 화면은 "갱신 중"에서
 * 멈춰 있었는데, 같은 API를 curl로 부르면 5초에 정상 응답했다.
 *
 * ★ **캐시가 아니다.** 끝난 값을 보관하지 않는다 — 진행 중인 것만 함께
 * 기다린다. 그래서 "오래된 잔고"가 생기지 않는다. 두 요청이 겹친 시점에
 * 나간 조회는 하나뿐이고, 그 하나의 답은 두 요청 모두에게 같은 순간의
 * 사실이다.
 *
 * ★ **주문 경로에는 쓰지 않는다.** 매수가능금액과 보유수량은 진행 중인
 * 조회를 물려받으면 안 된다 — 그 조회가 시작된 뒤 체결이 있었다면 체결 전
 * 잔고로 주문을 내게 되고, 이미 쓴 돈을 또 쓴다. 화면용 라우트만 부른다.
 */

const inflight = new Map<string, Promise<unknown>>();

/**
 * `key`가 같은 조회가 진행 중이면 그것을 함께 기다리고, 없으면 새로 시작한다.
 *
 * 실패도 공유한다 — 같은 순간에 같은 조회를 한 둘이 다른 답을 받으면 안 된다.
 * 끝나면 즉시 지우므로 다음 호출은 새로 나간다.
 */
export function shareInflight<T>(key: string, run: () => Promise<T>): Promise<T> {
  const existing = inflight.get(key) as Promise<T> | undefined;
  if (existing) return existing;
  const started = (async () => run())().finally(() => {
    inflight.delete(key);
  });
  inflight.set(key, started);
  return started;
}

/** 지금 묶여 있는 조회 수. 시험과 진단용이다 */
export function inflightSize(): number {
  return inflight.size;
}
