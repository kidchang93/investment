/**
 * 슬랙 알림 검증. **네트워크를 쓰지 않는다** — 설정 판별과 문자열 조립만 잰다.
 *
 * 여기서 못 박는 것은 알림이 거짓말하거나 자격증명을 흘릴 수 있는 자리다.
 */

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { escapeMrkdwn, signedWon, slackConfigured, won } from './slack.js';

const KEY = 'SLACK_WEBHOOK_URL';
const original = process.env[KEY];

afterEach(() => {
  if (original === undefined) delete process.env[KEY];
  else process.env[KEY] = original;
});

describe('슬랙 설정 판별 — "안 쓴다"와 "잘못 넣었다"를 가른다', () => {
  it('설정이 없으면 안 보낸다', () => {
    delete process.env[KEY];
    assert.equal(slackConfigured(), false);
  });

  it('슬랙 webhook 주소면 보낸다', () => {
    process.env[KEY] = 'https://hooks.slack.com/services/T000/B000/xxxx';
    assert.equal(slackConfigured(), true);
  });

  it('★ 따옴표째 붙여 넣어도 읽는다 — .env에서 실제로 일어나는 일이다', () => {
    process.env[KEY] = '"https://hooks.slack.com/services/T000/B000/xxxx"';
    assert.equal(slackConfigured(), true);
  });

  it('★ 슬랙 주소가 아니면 안 보낸다 — 엉뚱한 곳으로 계좌 내역이 나가면 안 된다', () => {
    for (const bad of ['https://example.com/hook', 'hooks.slack.com/services/x', 'TODO', '']) {
      process.env[KEY] = bad;
      assert.equal(slackConfigured(), false, `입력 ${bad}`);
    }
  });
});

describe('알림 문자열', () => {
  it('원화는 천 단위로 끊는다', () => {
    assert.equal(won(9_176_736), '9,176,736원');
  });

  it('손익은 부호가 먼저 읽힌다', () => {
    assert.equal(signedWon(-505_000), '-505,000원');
    assert.equal(signedWon(37_370), '+37,370원');
  });

  it('★ 종목명의 &를 막는다 — S&T모티브가 깨져서 나가면 안 된다', () => {
    assert.equal(escapeMrkdwn('S&T모티브'), 'S&amp;T모티브');
    assert.equal(escapeMrkdwn('<대신>'), '&lt;대신&gt;');
  });
});
