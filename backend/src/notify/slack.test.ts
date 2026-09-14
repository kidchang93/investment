/**
 * 슬랙 알림 검증. **네트워크를 쓰지 않는다** — 설정 판별과 문자열 조립만 잰다.
 *
 * 여기서 못 박는 것은 알림이 거짓말하거나 자격증명을 흘릴 수 있는 자리다.
 */

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { escapeMrkdwn, sendSlack, signedWon, won } from './slack.js';

const KEY = 'SLACK_WEBHOOK_URL';
const HOOK = 'https://hooks.slack.com/services/T000/B000/xxxx';
const original = process.env[KEY];
const realFetch = globalThis.fetch;

afterEach(() => {
  if (original === undefined) delete process.env[KEY];
  else process.env[KEY] = original;
  globalThis.fetch = realFetch;
});

/** 이 설정으로 `sendSlack`이 실제로 보내는 주소. 안 보내면 null. fetch를 가로채 네트워크를 쓰지 않는다 */
async function postedUrl(raw: string | undefined): Promise<string | null> {
  if (raw === undefined) delete process.env[KEY];
  else process.env[KEY] = raw;
  const urls: string[] = [];
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    urls.push(String(input));
    return new Response('ok');
  }) as typeof fetch;
  await sendSlack('시험');
  return urls[0] ?? null;
}

describe('슬랙 설정 판별 — "안 쓴다"와 "잘못 넣었다"를 가른다', () => {
  it('설정이 없으면 안 보낸다', async () => {
    assert.equal(await postedUrl(undefined), null);
  });

  it('슬랙 webhook 주소면 보낸다', async () => {
    assert.equal(await postedUrl(HOOK), HOOK);
  });

  it('★ 따옴표째 붙여 넣어도 읽는다 — .env에서 실제로 일어나는 일이다', async () => {
    assert.equal(await postedUrl(`"${HOOK}"`), HOOK);
  });

  it('★ 슬랙 주소가 아니면 안 보낸다 — 엉뚱한 곳으로 계좌 내역이 나가면 안 된다', async () => {
    for (const bad of ['https://example.com/hook', 'hooks.slack.com/services/x', 'TODO', '']) {
      assert.equal(await postedUrl(bad), null, `입력 ${bad}`);
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
