/**
 * 매일 그날의 시장 상태를 한 번 찍는다.
 *
 * ── 왜 러너와 따로 도나 ──────────────────────────────────────────────────
 *
 * 러너에 붙이면 **러너가 꺼진 날은 못 찍는다.** 오늘(2026-08-04)만 해도 러너가
 * 15:27에 스스로 멈췄고, 그 전에는 매수를 멈춘 상태로 돌았다. 스냅샷은 매매와
 * 무관하게 쌓여야 하는 자료라 서버가 떠 있으면 찍히게 둔다.
 *
 * ── 왜 최대한 이른 시각인가 ──────────────────────────────────────────────
 *
 * 장중 늦게 찍은 순위에는 **그날의 결과가 이미 섞여 있다.** 오전에 급등한 종목이
 * 오후 순위 상위에 오르는데, 그걸로 "그날 아침에 알 수 있었던 것"이라고 하면
 * 그게 바로 look-ahead다 — 오늘 그 편향이 측정 결론을 통째로 뒤집었다.
 *
 * 그래서 **개장 직후 한 번**만 찍고, 이미 찍었으면 아무것도 안 한다.
 *
 * ── 못 찍은 날은 못 찍은 것이다 ──────────────────────────────────────────
 *
 * 서버가 죽어 있던 날은 자료가 없다. 나중에 과거로 채우려 하면 안 된다 —
 * 그렇게 채운 값은 "그날 알 수 있었던 것"이 아니다. **빈 날은 빈 채로 둔다.**
 */

import { recordMarketSnapshot, getEarliestSnapshot } from '../db/marketSnapshot.js';
import { getDomesticTurnoverRanking } from '../kis/rest.js';
import { kstMinutesOfDay } from './session.js';

/** 몇 분마다 "오늘 찍었나"를 확인할지. 찍는 것은 하루 한 번이다 */
const CHECK_INTERVAL_MS = 5 * 60 * 1000;

/*
 * 이 시각 이후에 찍는다. 개장(09:00) 직후로 잡되 몇 분 여유를 둔다 —
 * 개장 동시호가 직후에는 순위가 아직 안 정해지고, 거래대금이 0인 종목이 섞인다.
 */
const SNAPSHOT_AFTER_MINUTES = 9 * 60 + 5;
/** 이 시각을 넘기면 그날은 안 찍는다. 늦게 찍은 값은 그날 아침의 정보가 아니다 */
const SNAPSHOT_BEFORE_MINUTES = 10 * 60;

/** KST 달력 날짜 `YYYY-MM-DD`. */
function kstDay(at: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
}

/**
 * 지금 찍어야 하면 찍는다. 이미 찍었거나 시각이 아니면 아무것도 안 한다.
 *
 * **실패해도 던지지 않는다.** 이건 곁다리 자료 수집이라 서버나 매매를 멈출
 * 이유가 없다. 다만 실패한 사실은 돌려줘서 부른 쪽이 적을 수 있게 한다.
 */
export async function captureDailySnapshotIfDue(
  at = new Date(),
): Promise<{ captured: boolean; reason: string }> {
  const minutes = kstMinutesOfDay(at);
  if (minutes < SNAPSHOT_AFTER_MINUTES) return { captured: false, reason: '아직 이르다' };
  if (minutes >= SNAPSHOT_BEFORE_MINUTES) {
    return { captured: false, reason: '오늘은 시각을 놓쳤다 — 늦게 찍은 순위는 그날 아침의 정보가 아니다' };
  }

  const day = kstDay(at);
  const existing = await getEarliestSnapshot(day, 'turnoverRanking').catch(() => null);
  if (existing) return { captured: false, reason: '오늘 이미 찍었다' };

  try {
    const symbols = await getDomesticTurnoverRanking(30);
    /*
     * 빈 목록을 찍지 않는다. 휴장일이면 순위가 안 오는데, 그걸 "그날 상위가
     * 없었다"로 남기면 나중에 자료와 휴장을 구별할 수 없다.
     */
    if (symbols.length === 0) return { captured: false, reason: '순위가 비어 있다 — 휴장일이거나 조회 실패' };
    await recordMarketSnapshot({
      tradingDay: day,
      kind: 'turnoverRanking',
      symbols,
      note: `거래소 거래대금 순위 상위 ${symbols.length}종목 · ${at.toISOString()} 조회`,
    });
    return { captured: true, reason: `${symbols.length}종목` };
  } catch (e) {
    return { captured: false, reason: `조회 실패: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** 서버가 떠 있는 동안 계속 확인한다. 서버 부팅 때 한 번 부른다. */
export function startDailySnapshot(log: (message: string) => void): NodeJS.Timeout {
  const tick = (): void => {
    void captureDailySnapshotIfDue().then((result) => {
      // 찍었을 때만 적는다. 매번 적으면 "아직 이르다"가 하루 수십 줄 쌓인다.
      if (result.captured) log(`시장 스냅샷을 찍었다 · ${result.reason}`);
    });
  };
  tick();
  return setInterval(tick, CHECK_INTERVAL_MS);
}
