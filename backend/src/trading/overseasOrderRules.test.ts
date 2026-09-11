/**
 * 해외주식 보내기 전 규칙의 **계약**을 못 박는다.
 *
 * 국내 잣대(KST 장시간·국내 개장일·원화 금액)를 해외에 그대로 대면 셋 다 틀린다.
 * 그 셋이 여기서 각각 어떻게 갈리는지를 시험으로 남긴다.
 */

import assert from 'node:assert/strict';
import { describe as suite, it } from 'node:test';

import {
  FX_MAX_AGE_MS, krwNotional, usOrderExchange, usRegularSession,
} from './overseasOrderRules.js';

const us = (market: string) => ({ country: 'US', market, currency: 'USD' });

suite('어느 거래소로 보내나', () => {
  it('★ 마스터 이름을 주문 이름으로 바꾼다 — NAS를 그대로 보내면 거절된다', () => {
    assert.deepEqual(usOrderExchange(us('NAS')), { ok: true, exchange: 'NASD' });
    assert.deepEqual(usOrderExchange(us('NYS')), { ok: true, exchange: 'NYSE' });
    assert.deepEqual(usOrderExchange(us('AMS')), { ok: true, exchange: 'AMEX' });
  });

  it('★★ 주간거래(BAQ·BAY·BAA)는 막는다 — TR이 다르고 모의 TR이 없다', () => {
    for (const market of ['BAQ', 'BAY', 'BAA']) {
      const v = usOrderExchange(us(market));
      assert.equal(v.ok, false, market);
      assert.match((v as { reason: string }).reason, /주간거래/);
    }
  });

  it('미국이 아니면 막는다 — 모의로 접수를 본 적이 없다', () => {
    assert.equal(usOrderExchange({ country: 'JP', market: 'TSE', currency: 'JPY' }).ok, false);
    assert.equal(usOrderExchange({ country: 'KR', market: 'KOSPI', currency: 'KRW' }).ok, false);
  });

  it('모르는 미국 시장은 막는다 — 기본값으로 나스닥에 보내지 않는다', () => {
    assert.equal(usOrderExchange(us('XXX')).ok, false);
  });
});

suite('미국 정규장이 열려 있나', () => {
  /*
   * 2026-09-11(금)은 서머타임(EDT, UTC−4)이고 2026-12-10(목)은 표준시(EST, UTC−5)다.
   * 둘 다 넣어야 **KST로 표를 박아 두면 틀린다**는 것이 시험으로 드러난다.
   */
  it('★★ 서머타임: 뉴욕 09:30은 UTC 13:30 — KST로는 밤 22:30이다', () => {
    assert.equal(usRegularSession(new Date('2026-09-11T13:30:00Z')).open, true);
    assert.equal(usRegularSession(new Date('2026-09-11T13:29:00Z')).open, false);
  });

  it('★★ 표준시: 같은 뉴욕 09:30이 UTC 14:30으로 한 시간 밀린다', () => {
    assert.equal(usRegularSession(new Date('2026-12-10T14:30:00Z')).open, true);
    assert.equal(usRegularSession(new Date('2026-12-10T14:29:00Z')).open, false);
    // 서머타임 시각(13:30Z)이면 겨울엔 아직 08:30이라 닫혀 있어야 한다.
    assert.equal(usRegularSession(new Date('2026-12-10T13:30:00Z')).open, false);
  });

  it('16:00 정각부터는 닫힌다', () => {
    assert.equal(usRegularSession(new Date('2026-09-11T19:59:00Z')).open, true);
    assert.equal(usRegularSession(new Date('2026-09-11T20:00:00Z')).open, false);
  });

  it('★ 국내 장시간(KST 09:00~15:30)에는 미국이 닫혀 있다 — 국내 잣대를 쓰면 정반대가 된다', () => {
    // KST 2026-09-11 10:00 = UTC 01:00 = 뉴욕 09-10 21:00
    const v = usRegularSession(new Date('2026-09-11T01:00:00Z'));
    assert.equal(v.open, false);
    assert.match(v.reason ?? '', /정규장/);
  });

  it('뉴욕 주말은 닫혀 있다 — KST로는 토요일 밤이 아직 금요일 장이다', () => {
    // KST 토 2026-09-12 00:30 = UTC 09-11 15:30 = 뉴욕 금 11:30 → 열려 있다
    assert.equal(usRegularSession(new Date('2026-09-11T15:30:00Z')).open, true);
    // 뉴욕 토요일 11:30
    const sat = usRegularSession(new Date('2026-09-12T15:30:00Z'));
    assert.equal(sat.open, false);
    assert.match(sat.reason ?? '', /주말/);
  });

  it('막혔을 때 뉴욕 시각을 사유에 적는다', () => {
    const v = usRegularSession(new Date('2026-09-11T01:00:00Z'));
    assert.match(v.newYorkTime, /^뉴욕 \w{3} \d{2}:\d{2}$/);
    assert.ok((v.reason ?? '').includes(v.newYorkTime));
  });
});

suite('원화로 얼마인가', () => {
  const now = Date.UTC(2026, 8, 11, 14, 0, 0);
  const fx = { rate: 1337.9, fetchedAt: now - 60_000 };

  it('수량 × 달러 단가 × 환율', () => {
    assert.equal(krwNotional(10, 190.25, fx, now), 10 * 190.25 * 1337.9);
  });

  it('★★ 달러를 그대로 원화 한도에 넣으면 1,300배 작게 잡힌다 — 이 함수가 존재하는 이유', () => {
    const raw = 10 * 190.25;               // 1,902.5 — 원화 한도로 읽으면 사실상 0원
    const krw = krwNotional(10, 190.25, fx, now) ?? 0;
    assert.ok(krw / raw > 1300, `krw=${krw} raw=${raw}`);
  });

  it('★★ 환율을 모르면 undefined다 — 0으로 치면 금액 잣대가 통째로 열린다', () => {
    assert.equal(krwNotional(10, 190.25, undefined, now), undefined);
    assert.equal(krwNotional(10, 190.25, { rate: 0, fetchedAt: now }, now), undefined);
    assert.equal(krwNotional(10, 190.25, { rate: Number.NaN, fetchedAt: now }, now), undefined);
  });

  it('묵은 환율도 모르는 것으로 친다', () => {
    const stale = { rate: 1337.9, fetchedAt: now - FX_MAX_AGE_MS - 1 };
    assert.equal(krwNotional(10, 190.25, stale, now), undefined);
    const fresh = { rate: 1337.9, fetchedAt: now - FX_MAX_AGE_MS };
    assert.notEqual(krwNotional(10, 190.25, fresh, now), undefined);
  });

  it('수량·단가가 0 이하면 undefined다', () => {
    assert.equal(krwNotional(0, 190.25, fx, now), undefined);
    assert.equal(krwNotional(10, 0, fx, now), undefined);
    assert.equal(krwNotional(10, -1, fx, now), undefined);
  });
});
