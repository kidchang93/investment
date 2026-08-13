/**
 * KIND 상장폐지 목록 파서의 **계약**을 못 박는다.
 *
 * 이 출처는 우리가 통제하지 못한다. 확장자는 `.xls`인데 내용은 EUC-KR HTML이고,
 * 시장 구분은 전체 목록에 없어 3벌을 더 받아 붙인다. 그래서 두 가지를 시험한다.
 *
 * ① **진짜 바이트로 푼다.** 아래 `KIND_FIXTURE_BASE64`는 2026-08-13에 받은 응답의
 *    앞부분(머리글 + 4행)을 **EUC-KR 그대로** 담은 것이다. UTF-8로 다시 적으면
 *    인코딩이 실제로 맞는지 시험할 수 없다 — `중앙제지`가 `���`로 오는 것이 이
 *    파일에서 가장 흔한 고장이다.
 * ② **형식이 바뀌면 던진다.** 열이 한 칸 밀리면 폐지사유가 종목코드 자리에
 *    들어가는데, 그건 값만 봐서는 알 수 없다. 조용히 넘기지 않는다.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  attachMarkets,
  dedupeDelistings,
  parseDelistingTable,
  toKindDate,
  type DelistingRecord,
} from './kindDelistings.js';

/** 2026-08-13 KIND 응답의 앞부분. 머리글 + 4행 · EUC-KR 바이트 그대로다. */
const KIND_FIXTURE_BASE64 = [
  'PHRhYmxlIGNlbGxwYWRkaW5nPSIwIiBjZWxsc3BhY2luZz0iMSIgY2xhc3M9ImJic190YiIgYm9yZGVyPTE+DQoJCQkNCgk8Y29s',
  'IHdpZHRoPSI1JSIgLz4NCgk8Y29sIHdpZHRoPSIyMCUiIC8+DQoJPGNvbCB3aWR0aD0iMTAlIiAvPg0KCTxjb2wgd2lkdGg9IjEw',
  'JSIgLz4NCgk8Y29sIHdpZHRoPSI0MDAiIC8+DQoJPGNvbCB3aWR0aD0iMjAlIiAvPg0KCTx0cj4NCgkJPHRoIGJnY29sb3I9IiM2',
  'NkZGOTkiPrn4yKM8L3RoPg0KCQk8dGggYmdjb2xvcj0iIzY2RkY5OSI+yLi757jtPC90aD4NCgkJPHRoIGJnY29sb3I9IiM2NkZG',
  'OTkiPsG+uPHE2rXlPC90aD4NCgkJPHRoIGJnY29sb3I9IiM2NkZGOTkiPsbzwfbAz8DaPC90aD4NCgkJPHRoIGJnY29sb3I9IiM2',
  'NkZGOTkiPsbzwfa758CvPC90aD4NCgkJPHRoIGJnY29sb3I9IiM2NkZGOTkiPrrxsO08L3RoPg0KCTwvdHI+DQoJDQoJCQ0KCQkJ',
  'DQoJCQkNCg0KCQkJPHRyPg0KCQkJCTx0ZCBzdHlsZT0idGV4dC1hbGlnbjpjZW50ZXI7Ij4xMjY3PC90ZD4NCgkJCQk8dGQ+wd++',
  '08GmwfY8L3RkPg0KCQkJCTx0ZCBzdHlsZT0ibXNvLW51bWJlci1mb3JtYXQ6J0AnO3RleHQtYWxpZ246Y2VudGVyOyI+MDA1NjAw',
  'PC90ZD4NCgkJCQk8dGQgc3R5bGU9InRleHQtYWxpZ246Y2VudGVyOyI+MjAwNS0wMS0wNjwvdGQ+DQoJCQkJPHRkPsPWwb66zrW1',
  'ud+7/TwvdGQ+DQoJCQkJPHRkPjwvdGQ+DQoJCQk8L3RyPg0KCQkJDQoJCQkNCg0KCQkJPHRyPg0KCQkJCTx0ZCBzdHlsZT0idGV4',
  'dC1hbGlnbjpjZW50ZXI7Ij4xMjY2PC90ZD4NCgkJCQk8dGQ+vcXH0cX1wNrB9bHHPC90ZD4NCgkJCQk8dGQgc3R5bGU9Im1zby1u',
  'dW1iZXItZm9ybWF0OidAJzt0ZXh0LWFsaWduOmNlbnRlcjsiPjAwODY3MDwvdGQ+DQoJCQkJPHRkIHN0eWxlPSJ0ZXh0LWFsaWdu',
  'OmNlbnRlcjsiPjIwMDUtMDEtMDU8L3RkPg0KCQkJCTx0ZD7B9sHWyLi758DHIL/PwPzA2si4u+fIrSjB9sHWyLi75yC9xbHUu/PA',
  '5Sk8L3RkPg0KCQkJCTx0ZD48L3RkPg0KCQkJPC90cj4NCgkJCQ0KCQkJDQoNCgkJCTx0cj4NCgkJCQk8dGQgc3R5bGU9InRleHQt',
  'YWxpZ246Y2VudGVyOyI+MTI2NTwvdGQ+DQoJCQkJPHRkPry8v/jIrby6PC90ZD4NCgkJCQk8dGQgc3R5bGU9Im1zby1udW1iZXIt',
  'Zm9ybWF0OidAJzt0ZXh0LWFsaWduOmNlbnRlcjsiPjAwNzkxMDwvdGQ+DQoJCQkJPHRkIHN0eWxlPSJ0ZXh0LWFsaWduOmNlbnRl',
  'cjsiPjIwMDUtMDItMjQ8L3RkPg0KCQkJCTx0ZD69xcO7v6EgwMfH0SC788DlxvPB9jwvdGQ+DQoJCQkJPHRkPjwvdGQ+DQoJCQk8',
  'L3RyPg0KCQkJDQoJCQkNCg0KCQkJPHRyPg0KCQkJCTx0ZCBzdHlsZT0idGV4dC1hbGlnbjpjZW50ZXI7Ij4xMjY0PC90ZD4NCgkJ',
  'CQk8dGQ+vL7D37iuPC90ZD4NCgkJCQk8dGQgc3R5bGU9Im1zby1udW1iZXItZm9ybWF0OidAJzt0ZXh0LWFsaWduOmNlbnRlcjsi',
  'PjAwNjc1MDwvdGQ+DQoJCQkJPHRkIHN0eWxlPSJ0ZXh0LWFsaWduOmNlbnRlcjsiPjIwMDUtMDQtMTQ8L3RkPg0KCQkJCTx0ZD6w',
  'qLvnwMew3yDAx7DfsMXA/TwvdGQ+DQoJCQkJPHRkPjwvdGQ+DQoJCQk8L3RyPjwvdGFibGU+',
].join('');

function fixtureHtml(): string {
  return new TextDecoder('euc-kr').decode(Buffer.from(KIND_FIXTURE_BASE64, 'base64'));
}

/** 시험용 표 만들기. 머리글은 실제 응답과 같은 순서다. */
function tableOf(rows: string[][]): string {
  const header = '<tr>'
    + ['번호', '회사명', '종목코드', '폐지일자', '폐지사유', '비고']
      .map((name) => `<th bgcolor="#66FF99">${name}</th>`).join('')
    + '</tr>';
  const body = rows
    .map((cells) => `<tr>${cells.map((cell) => `<td>${cell}</td>`).join('')}</tr>`)
    .join('');
  return `<table>${header}${body}</table>`;
}

function record(symbol: string, delistedOn: string, name = '시험'): DelistingRecord {
  return { symbol, name, delistedOn, reason: '사유', note: null, market: null };
}

describe('EUC-KR 응답 파싱 — 진짜 바이트로 푼다', () => {
  it('머리글과 4행을 그대로 읽는다', () => {
    const records = parseDelistingTable(fixtureHtml());

    assert.equal(records.length, 4);
    assert.deepEqual(records[0], {
      symbol: '005600',
      name: '중앙제지',
      delistedOn: '20050106',
      reason: '최종부도발생',
      note: null,
      market: null,
    });
  });

  it('한글이 깨지지 않는다 — 괄호와 공백이 든 긴 사유까지', () => {
    const records = parseDelistingTable(fixtureHtml());
    const shinhan = records.find((row) => row.symbol === '008670');

    assert.equal(shinhan?.name, '신한투자증권');
    assert.equal(shinhan?.reason, '지주회사의 완전자회사화(지주회사 신규상장)');
  });

  it('폐지일자를 YYYYMMDD로 바꾼다 — 봉 저장소와 같은 형식이다', () => {
    const records = parseDelistingTable(fixtureHtml());
    assert.deepEqual(records.map((row) => row.delistedOn), ['20050106', '20050105', '20050224', '20050414']);
  });

  it('빈 비고는 빈 문자열이 아니라 null이다', () => {
    for (const row of parseDelistingTable(fixtureHtml())) assert.equal(row.note, null);
  });

  it('시장은 이 응답에 없다 — 지어내지 않는다', () => {
    for (const row of parseDelistingTable(fixtureHtml())) assert.equal(row.market, null);
  });
});

describe('형식이 바뀌면 던진다 — 조용히 어긋난 값을 돌려주지 않는다', () => {
  it('머리글 순서가 바뀌면 던진다', () => {
    const html = '<table><tr>'
      + ['번호', '종목코드', '회사명', '폐지일자', '폐지사유', '비고'].map((n) => `<th>${n}</th>`).join('')
      + '</tr></table>';
    assert.throws(() => parseDelistingTable(html), /머리글이 바뀌었습니다/);
  });

  it('머리글이 아예 없으면 던진다', () => {
    const html = '<table><tr><td>1</td><td>중앙제지</td><td>005600</td>'
      + '<td>2005-01-06</td><td>최종부도발생</td><td></td></tr></table>';
    assert.throws(() => parseDelistingTable(html), /머리글 행이 없습니다/);
  });

  it('열 수가 모자라면 던진다 — 한 칸 밀린 값을 담지 않는다', () => {
    const html = tableOf([['1', '중앙제지', '005600', '2005-01-06', '최종부도발생']]);
    assert.throws(() => parseDelistingTable(html), /열 수가 6이 아닙니다/);
  });

  it('종목코드 자리가 6자리가 아니면 던진다', () => {
    const html = tableOf([['1', '중앙제지', '최종부도발생', '2005-01-06', '005600', '']]);
    assert.throws(() => parseDelistingTable(html), /종목코드 자리가 6자리가 아닙니다/);
  });

  it('폐지일자 형식이 다르면 던진다', () => {
    const html = tableOf([['1', '중앙제지', '005600', '20050106', '최종부도발생', '']]);
    assert.throws(() => parseDelistingTable(html), /폐지일자 형식이 다릅니다/);
  });

  it('표가 통째로 비면 던진다', () => {
    assert.throws(() => parseDelistingTable('<html><body>서비스 점검 중입니다</body></html>'), /<tr>이 하나도 없습니다/);
  });

  it('실체참조를 되돌린다 — &amp;를 먼저 풀지 않는다', () => {
    const html = tableOf([['1', 'A&amp;B', '005600', '2005-01-06', '&amp;lt;주의&amp;gt;', '&nbsp;']]);
    const [row] = parseDelistingTable(html);
    assert.equal(row.name, 'A&B');
    assert.equal(row.reason, '&lt;주의&gt;');
    assert.equal(row.note, null, '&nbsp;만 있는 칸은 빈 칸이다');
  });
});

describe('시장 붙이기 — 짝은 (코드, 폐지일)이다', () => {
  it('같은 코드가 두 번 폐지됐으면 에피소드마다 따로 붙는다', () => {
    /*
     * 실제로 그런 코드가 9개 있다(031440 신세계푸드: 2010-04-29 · 2026-08-11).
     * 코드만으로 맞추면 옛 에피소드에 새 시장이 붙어, 2010년 종목이 오늘 시장
     * 소속인 것처럼 된다.
     */
    const all = [record('031440', '20100429'), record('031440', '20260811')];
    const attached = attachMarkets(all, [
      { market: 'KOSDAQ', records: [record('031440', '20100429')] },
      { market: 'KOSPI', records: [record('031440', '20260811')] },
    ]);

    assert.deepEqual(attached.records.map((row) => row.market), ['KOSDAQ', 'KOSPI']);
    assert.equal(attached.marketUnknown, 0);
  });

  it('시장별 목록 어디에도 없으면 null로 두고 센다', () => {
    const attached = attachMarkets([record('005600', '20050106')], []);
    assert.equal(attached.records[0].market, null);
    assert.equal(attached.marketUnknown, 1);
  });

  it('시장별에만 있고 전체에는 없으면 어긋난 것으로 센다', () => {
    const attached = attachMarkets(
      [record('005600', '20050106')],
      [{ market: 'KOSPI', records: [record('005600', '20050106'), record('008670', '20050105')] }],
    );
    assert.equal(attached.marketOnly, 1);
  });
});

describe('접기와 날짜 형식', () => {
  it('같은 (코드, 폐지일)이 두 번 오면 하나로 접는다', () => {
    const folded = dedupeDelistings([record('005600', '20050106'), record('005600', '20050106')]);
    assert.equal(folded.length, 1);
  });

  it('폐지일이 다르면 접지 않는다 — 재상장은 두 건이다', () => {
    const folded = dedupeDelistings([record('031440', '20100429'), record('031440', '20260811')]);
    assert.equal(folded.length, 2);
  });

  it('KIND가 받는 날짜 형식으로 바꾼다', () => {
    assert.equal(toKindDate('20050101'), '2005-01-01');
  });
});
