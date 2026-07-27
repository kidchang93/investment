/**
 * 하루 전체를 앱이 뭐라고 부르는지 훑어본다 (일회성 조사용).
 *
 * 프리마켓·애프터마켓을 다루려면 지금 무엇을 말하고 있는지부터 알아야 한다.
 *
 *   npx tsx src/scripts/probeSessions.ts
 */

import { KRX_SESSION_MINUTES, krxSessionKind, type KrxSessionKind } from '@invest/shared';

const LABEL: Record<KrxSessionKind, string> = {
  preAuction: '장전 동시호가',
  regular: '정규장 · 거래 중',
  closeAuction: '마감 동시호가',
  postOffHours: '장후 시간외',
  singlePrice: '시간외 단일가',
  closed: '장외',
};

function label(minutes: number): string {
  const kind = krxSessionKind(minutes);
  if (kind !== 'closed') return LABEL[kind];
  if (minutes < KRX_SESSION_MINUTES.preAuctionOpen) return '장외 · 개장 전';
  if (minutes < KRX_SESSION_MINUTES.postOffHoursOpen) return '장외 · 정규장 마감';
  return '장외 · 시간외까지 끝';
}

/** KRX 공식 운영 시간. 앱이 무엇을 놓치는지 견주려고 옆에 적는다. */
const KRX: Array<[string, string]> = [
  ['07:30', '휴장'],
  ['08:20', '휴장'],
  ['08:30', '장전 시간외 종가(~08:40) · 장전 동시호가(~09:00)'],
  ['08:45', '장전 동시호가'],
  ['08:59', '장전 동시호가'],
  ['09:00', '정규장'],
  ['12:00', '정규장'],
  ['15:19', '정규장'],
  ['15:20', '마감 동시호가'],
  ['15:30', '마감 동시호가 끝'],
  ['15:35', '휴식'],
  ['15:40', '장후 시간외 종가(~16:00)'],
  ['16:00', '시간외 단일가(~18:00)'],
  ['16:30', '시간외 단일가'],
  ['17:59', '시간외 단일가'],
  ['18:00', '시간외 단일가 끝'],
  ['19:00', '휴장'],
];

async function main(): Promise<void> {
  console.log('시각     앱이 부르는 이름          KRX 실제');
  console.log('─'.repeat(78));
  for (const [clock, krx] of KRX) {
    const [hour, minute] = clock.split(':').map(Number);
    const mine = label(hour * 60 + minute);
    console.log(`${clock}   ${mine.padEnd(22)} ${krx}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
