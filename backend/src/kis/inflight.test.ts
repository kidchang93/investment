/**
 * 겹친 조회를 하나로 묶는지. **네트워크를 쓰지 않는다.**
 *
 * 여기서 못 박는 것은 2026-08-18에 화면을 멈추게 한 자리다 — 같은 계좌 잔고를
 * 네 번 부르면 KIS에도 네 번 나갔다.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { inflightSize, shareInflight } from './inflight.js';

/** 밖에서 끝낼 수 있는 약속. 타이머 없이 순서를 만든다 */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('겹친 조회 묶기', () => {
  it('★ 진행 중이면 다시 부르지 않는다 — 넷이 물어도 한 번만 나간다', async () => {
    const gate = deferred<string>();
    let calls = 0;
    const run = (): Promise<string> => {
      calls += 1;
      return gate.promise;
    };

    const all = Promise.all([
      shareInflight('acct:VTS', run),
      shareInflight('acct:VTS', run),
      shareInflight('acct:VTS', run),
      shareInflight('acct:VTS', run),
    ]);
    gate.resolve('잔고');

    assert.deepEqual(await all, ['잔고', '잔고', '잔고', '잔고']);
    assert.equal(calls, 1, `네 번 물었는데 KIS에 ${calls}번 나갔다`);
  });

  it('키가 다르면 따로 나간다 — 다른 계좌를 섞으면 안 된다', async () => {
    const calls: string[] = [];
    const run = (id: string) => async (): Promise<string> => {
      calls.push(id);
      return id;
    };
    const [a, b] = await Promise.all([
      shareInflight('acct:21', run('21')),
      shareInflight('acct:23', run('23')),
    ]);
    assert.equal(a, '21');
    assert.equal(b, '23');
    assert.deepEqual(calls.sort(), ['21', '23']);
  });

  it('★ 끝나면 보관하지 않는다 — 캐시가 아니라서 다음엔 새 값이 온다', async () => {
    let n = 0;
    const run = async (): Promise<number> => {
      n += 1;
      return n;
    };
    assert.equal(await shareInflight('k', run), 1);
    assert.equal(await shareInflight('k', run), 2, '끝난 값을 재사용하면 오래된 잔고를 보게 된다');
    assert.equal(inflightSize(), 0, '끝난 조회가 남아 있다');
  });

  it('실패도 함께 받는다 — 같은 순간에 같은 것을 물었으면 답도 같아야 한다', async () => {
    const gate = deferred<string>();
    let calls = 0;
    const run = (): Promise<string> => {
      calls += 1;
      return gate.promise;
    };
    const first = shareInflight('boom', run);
    const second = shareInflight('boom', run);
    gate.reject(new Error('KIS 거절'));

    await assert.rejects(first, /KIS 거절/);
    await assert.rejects(second, /KIS 거절/);
    assert.equal(calls, 1);
    assert.equal(inflightSize(), 0, '실패한 조회가 남으면 다음 요청이 영영 그 실패를 받는다');
  });

  it('던지는 함수도 붙잡는다 — 동기 예외로 지도가 새면 안 된다', async () => {
    const before = inflightSize();
    await assert.rejects(
      shareInflight('sync-throw', () => {
        throw new Error('설정 오류');
      }),
      /설정 오류/,
    );
    assert.equal(inflightSize(), before, '동기 예외 뒤에 항목이 남았다');
  });
});
