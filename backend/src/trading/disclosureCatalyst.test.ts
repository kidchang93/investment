/**
 * **재료가 막 나온 종목**의 계약을 못 박는다.
 *
 * 공시 제목을 단어로 가르는 표는 한 칸만 틀려도 희석이 호재로 읽힌다. 그 자리를
 * 시험으로 막는다.
 */

import assert from 'node:assert/strict';
import { describe as suite, it } from 'node:test';

import {
  baseCloseFor, classifyDisclosure, pickCatalysts, previousWeekday, type DayClose, type DisclosureRow,
} from './disclosureCatalyst.js';

suite('공시 제목 가르기', () => {
  it('정해진 이름의 호재를 가른다', () => {
    assert.equal(classifyDisclosure('(주)마음에이아이 단일판매ㆍ공급계약체결')?.label, '공급계약');
    assert.equal(classifyDisclosure('휴메딕스 주식소각 결정')?.label, '주식소각');
    assert.equal(classifyDisclosure('삼성전자 자기주식취득 결정')?.label, '자사주 취득');
    assert.equal(classifyDisclosure('연결재무제표기준영업(잠정)실적(공정공시)')?.tone, 'good');
  });

  it('★★ 악재를 먼저 본다 — 희석·해지가 호재로 읽히면 안 된다', () => {
    assert.equal(classifyDisclosure('(주)아무개 유무상증자결정')?.tone, 'bad');
    assert.equal(classifyDisclosure('(주)아무개 단일판매ㆍ공급계약해지')?.tone, 'bad');
    assert.equal(classifyDisclosure('엔투텍 (정정)전환사채권발행결정(제18회차)')?.tone, 'bad');
    assert.equal(classifyDisclosure('(주)에임드바이오 추가상장(신주인수권행사)')?.tone, 'bad');
    assert.equal(classifyDisclosure('[투자주의]투자경고종목 지정예고')?.tone, 'bad');
  });

  it('정정 공시를 표시한다 — 새 재료가 아닐 수 있다', () => {
    assert.equal(classifyDisclosure('(정정)단일판매ㆍ공급계약체결')?.correction, true);
    assert.equal(classifyDisclosure('단일판매ㆍ공급계약체결')?.correction, false);
  });

  it('규칙에 없는 공시는 재료로 안 센다', () => {
    assert.equal(classifyDisclosure('기업설명회(IR) 개최(안내공시)'), null);
    assert.equal(classifyDisclosure('주주명부폐쇄기간 또는 기준일 설정'), null);
    // 청약결과는 "유상증자"를 품지만 결정 공시가 아니다
    assert.equal(classifyDisclosure('유상증자 또는 주식관련사채 등의 청약결과(자율공시)'), null);
  });
});

suite('공시 직전 종가', () => {
  const closes: DayClose[] = [
    { day: '20260908', close: 100 }, { day: '20260909', close: 110 },
    { day: '20260910', close: 120 }, { day: '20260911', close: 999 },
  ];

  it('장 마감 전 공시는 그 전 거래일 종가다', () => {
    assert.deepEqual(baseCloseFor(closes, '20260910', '112100', '20260911'), { day: '20260909', close: 110 });
  });

  it('장 마감 뒤 공시는 그날 종가다', () => {
    assert.deepEqual(baseCloseFor(closes, '20260910', '165700', '20260911'), { day: '20260910', close: 120 });
  });

  it('★ 오늘 진행 중인 봉은 쓰지 않는다 — 아직 종가가 아니다', () => {
    assert.deepEqual(baseCloseFor(closes, '20260911', '084800', '20260911'), { day: '20260910', close: 120 });
  });

  it('주말에 난 공시는 직전 거래일 종가다', () => {
    const weekend: DayClose[] = [{ day: '20260904', close: 50 }];
    assert.deepEqual(baseCloseFor(weekend, '20260906', '100000', '20260908'), { day: '20260904', close: 50 });
  });

  it('기준이 될 봉이 없으면 null이다 — 짐작하지 않는다', () => {
    assert.equal(baseCloseFor(closes, '20260901', '100000', '20260911'), null);
  });
});

suite('전 평일', () => {
  it('평일은 하루 전, 월요일은 금요일이다', () => {
    assert.equal(previousWeekday('20260911'), '20260910');
    assert.equal(previousWeekday('20260914'), '20260911');
    assert.equal(previousWeekday('20260901'), '20260831');
  });
});

suite('목록 조립', () => {
  const row = (symbol: string, title: string, day = '20260911', time = '100000'): DisclosureRow =>
    ({ symbol, name: `이름${symbol}`, title, publishedDay: day, publishedTime: time });
  const base = (): DayClose => ({ day: '20260910', close: 100 });
  const run = (rows: DisclosureRow[], prices: Record<string, number>, eligible = (_: string) => true) =>
    pickCatalysts({ rows, eligible, price: (s) => prices[s], base, maxMove: 0.05, limit: 5 });

  it('★★ 공시 뒤 이미 많이 오른 것은 뺀다 — 그것이 📈였다', () => {
    const r = run([row('A', '단일판매ㆍ공급계약체결'), row('B', '주식소각 결정')], { A: 103, B: 112 });
    assert.deepEqual(r.picks.map((p) => p.symbol), ['A']);
    assert.equal(r.tooMoved, 1);
    assert.ok(Math.abs(r.picks[0].move - 0.03) < 1e-9);
  });

  it('후보 풀 밖이면 뺀다 — 사도 못 판다', () => {
    const r = run([row('A', '단일판매ㆍ공급계약체결')], { A: 100 }, () => false);
    assert.equal(r.picks.length, 0);
    assert.equal(r.outside, 1);
  });

  it('악재는 빼지 않고 붙인다', () => {
    const r = run([row('A', '단일판매ㆍ공급계약체결'), row('A', '전환사채권발행결정')], { A: 100 });
    assert.deepEqual(r.picks[0].warnings, ['전환사채']);
  });

  it('악재만 난 종목은 후보가 아니다', () => {
    assert.equal(run([row('A', '유상증자결정')], { A: 100 }).picks.length, 0);
  });

  it('최근 공시 순이고 상한까지만 보인다', () => {
    const rows = ['1', '2', '3', '4', '5', '6'].map((s, i) => row(s, '주식소각 결정', '20260911', `09${i}000`));
    const prices = Object.fromEntries(rows.map((r) => [r.symbol, 100]));
    const r = run(rows, prices);
    assert.deepEqual(r.picks.map((p) => p.symbol), ['6', '5', '4', '3', '2']);
  });

  it('기준가나 현재가를 모르면 세고 넘어간다', () => {
    const r = pickCatalysts({
      rows: [row('A', '주식소각 결정')], eligible: () => true, price: () => undefined,
      base, maxMove: 0.05, limit: 5,
    });
    assert.equal(r.unmeasured, 1);
    assert.equal(r.picks.length, 0);
  });
});
