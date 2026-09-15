/**
 * H0STCNT0 프레임 분할 — 한 프레임에 체결 여러 건이 붙어 온다.
 *
 * 2026-09-15 실측(모의·실전 각 1분): 레코드당 **47필드**가 프레임 100%였고 57%가
 * 여러 건짜리였다. 46으로 자르던 동안 두 번째 건부터 오류 없이 사라졌다.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ConnectionStatus, Trade } from '@invest/shared';

import { KisRealtime } from './realtime.js';

function record(code: string, price: number): string[] {
  const f = Array.from({ length: 47 }, () => '0');
  f[0] = code;
  f[1] = '101130';
  f[2] = String(price);
  f[3] = '2';
  f[4] = '100';
  f[5] = '0.10';
  f[7] = f[8] = f[9] = String(price);
  f[12] = '1';
  f[13] = '1000';
  f[33] = '20260915';
  f[46] = '2'; // MARKET_CLS_CODE — 2026-09-11에 붙은 칸, 정규장은 2
  return f;
}

function feed(fields: string[], count: number) {
  const kis = new KisRealtime();
  const trades: Trade[] = [];
  const statuses: ConnectionStatus[] = [];
  kis.on('trade', (t: Trade) => trades.push(t));
  kis.on('status', (s: ConnectionStatus) => statuses.push(s));
  (kis as unknown as { onMessage(raw: string): void }).onMessage(`0|H0STCNT0|${count}|${fields.join('^')}`);
  return { trades, statuses };
}

describe('H0STCNT0 여러 건 프레임', () => {
  it('47필드 레코드 셋을 셋 다 읽는다', () => {
    const { trades, statuses } = feed(
      [...record('005930', 70000), ...record('000660', 169000), ...record('069500', 104770)],
      3,
    );
    assert.deepEqual(trades.map((t) => [t.code, t.price]), [['005930', 70000], ['000660', 169000], ['069500', 104770]]);
    assert.equal(statuses.length, 0);
  });

  it('필드 수가 건수와 안 맞으면 조용히 넘기지 않는다', () => {
    const fields = [...record('005930', 70000), ...record('000660', 169000)];
    const { statuses } = feed(fields.slice(0, 46 * 2), 2);
    assert.match(statuses.map((s) => s.message ?? '').join(' '), /필드/);
  });
});
