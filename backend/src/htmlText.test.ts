/**
 * HTML 조각 → 글자. KIND 쪽은 `krx/kindDelistings.test.ts`가 표 파싱으로 덮고,
 * 여기는 네이버 뉴스 제목에 실제로 오는 엔티티를 잰다. 네트워크를 쓰지 않는다.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { decodeEntities, htmlText } from './htmlText.js';

describe('HTML 조각 → 글자', () => {
  it('네이버 뉴스 제목의 엔티티를 되돌린다', () => {
    assert.equal(
      htmlText('<a href="#">삼성전자&middot;SK하이닉스 &quot;반등&quot;&hellip; &#039;HBM&#039; &ldquo;기대&rdquo;</a>'),
      '삼성전자·SK하이닉스 "반등"… \'HBM\' "기대"',
    );
  });

  it('&amp;는 마지막에 푼다 — 원문의 &lt;를 태그로 만들지 않는다', () => {
    assert.equal(decodeEntities('S&amp;T &amp;lt;주의&amp;gt;'), 'S&T &lt;주의&gt;');
    assert.equal(decodeEntities('/news/read.naver?a=1&amp;b=2'), '/news/read.naver?a=1&b=2');
  });
});
