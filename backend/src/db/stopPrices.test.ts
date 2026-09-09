/**
 * **손절가를 종목별로 끝까지 찾는지** 검증한다.
 *
 * 2026-09-08에 보유 7종목 중 **감시 1**이었다. 손절 감시가 최근 서른 회차만
 * 훑었는데 적정가 빠른 회차가 하루 10~12번 돌아 **서른 회차 ≈ 2.5일**이었고,
 * 그보다 전에 산 종목은 창 밖으로 밀려 조용히 빠졌다. 삼성전자우 1,002만원이
 * 손절가를 적어 두고도 무방비였다.
 *
 * 눈으로 고쳤다고 넘어가면 같은 병이 조용히 돌아온다 — 회차는 계속 쌓이므로.
 *
 * DB에 못 붙으면 건너뛴다.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';

import { pool } from './client.js';
import { ensureDeliberationSchema, getLatestStopPrices } from './deliberations.js';

let usable = false;
const account = `TEST-STOP-${randomUUID().slice(0, 8)}`;

before(async () => {
  try {
    await ensureDeliberationSchema();
    usable = true;
  } catch {
    usable = false;
  }
});

after(async () => {
  if (usable) {
    await pool.query('DELETE FROM trading_deliberations WHERE account_id = $1', [account])
      .catch(() => undefined);
  }
  await pool.end().catch(() => undefined);
});

/** 회차 하나를 심는다. `decisions`만 의미가 있고 나머지는 자리를 채운다. */
async function seed(day: string, decisions: unknown[]): Promise<void> {
  await pool.query(
    `INSERT INTO trading_deliberations
       (account_id, trading_day, started_at, trigger, trigger_reason, equity,
        positions, findings, decisions, falsifier, unknowns, sources, reference, executions)
     VALUES ($1, $2, 0, 'scheduled', '', 0,
             '[]'::jsonb, '[]'::jsonb, $3::jsonb, 'test', '[]'::jsonb, '[]'::jsonb,
             '{"prices":{}}'::jsonb, '[]'::jsonb)`,
    [account, day, JSON.stringify(decisions)],
  );
}

const buy = (symbol: string, stopPrice: number, layer?: string) => ({
  symbol, name: symbol, action: 'buy', quantity: 1, rationale: '', layer,
  plan: { targetPrice: stopPrice * 2, stopPrice, horizonDays: 10, expectedReturn: 0.1, basis: '' },
});

describe('손절가 — 종목별 최신 하나', () => {
  it('회차가 아무리 쌓여도 옛 매수의 손절가를 찾는다', async (t) => {
    if (!usable) return t.skip('DB에 붙지 못했다');
    await seed('2026-09-01', [buy('005935', 177_000, 'bet')]);
    // 그 뒤로 손절가 없는 회차를 많이 쌓는다 — 옛 방식(최근 30회차)이라면 밀려난다.
    for (let i = 0; i < 40; i += 1) {
      await seed('2026-09-02', []);
    }
    const found = await getLatestStopPrices(account);
    assert.equal(found.get('005935')?.stop, 177_000, '40회차 뒤에도 찾아야 한다');
    assert.equal(found.get('005935')?.layer, 'bet');
  });

  it('같은 종목을 다시 사면 나중 회차의 손절가가 이긴다', async (t) => {
    if (!usable) return t.skip('DB에 붙지 못했다');
    await seed('2026-09-03', [buy('015760', 30_300, 'short')]);
    await seed('2026-09-04', [buy('015760', 31_500, 'short')]);
    const found = await getLatestStopPrices(account);
    assert.equal(found.get('015760')?.stop, 31_500, '판단자가 옮긴 값을 써야 한다');
  });

  it('plan이 없는 결정은 손절가로 읽지 않는다', async (t) => {
    if (!usable) return t.skip('DB에 붙지 못했다');
    await seed('2026-09-05', [
      { symbol: '069500', name: 'KODEX 200', action: 'hold', quantity: 0, rationale: '' },
      { symbol: '069500', name: 'KODEX 200', action: 'sell', quantity: 1, rationale: '' },
    ]);
    const found = await getLatestStopPrices(account);
    assert.equal(found.has('069500'), false, '적어 둔 약속이 없다');
  });

  /**
   * 2026-09-09까지 `action = 'buy'`만 읽었다. 그래서 판단자가 계속 들고 가기로
   * 하면서 목표를 올려도 감시는 옛 값을 봤고, 판단자는 **손절을 옮기는 것을
   * 포기했다**("기록만 남기면 착각을 만든다" — 회차 474).
   */
  it('계속 들고 가면서 옮긴 값이 매수 때의 값을 이긴다', async (t) => {
    if (!usable) return t.skip('DB에 붙지 못했다');
    await seed('2026-09-07', [buy('010950', 137_000, 'short')]);
    await seed('2026-09-08', [{
      symbol: '010950', name: 'S-Oil', action: 'hold', quantity: 0, rationale: '',
      plan: {
        targetPrice: 170_000, stopPrice: 145_000,
        horizonDays: 10, expectedReturn: 0.1, basis: '올려 잡는다',
      },
    }]);
    const found = await getLatestStopPrices(account);
    assert.equal(found.get('010950')?.stop, 145_000, 'hold로 옮긴 손절가를 써야 한다');
    assert.equal(found.get('010950')?.target, 170_000, 'hold로 올린 목표가를 써야 한다');
  });

  /** 절반만 팔고 남긴 수량에도 약속이 필요하다. */
  it('부분 매도에 적은 약속도 읽는다', async (t) => {
    if (!usable) return t.skip('DB에 붙지 못했다');
    await seed('2026-09-09', [{
      symbol: '034020', name: '두산에너빌리티', action: 'sell', quantity: 25, rationale: '',
      plan: {
        targetPrice: 90_000, stopPrice: 72_000,
        horizonDays: 10, expectedReturn: 0.1, basis: '남은 25주의 약속',
      },
    }]);
    const found = await getLatestStopPrices(account);
    assert.equal(found.get('034020')?.stop, 72_000);
    assert.equal(found.get('034020')?.target, 90_000);
  });

  it('0이거나 읽을 수 없는 손절가는 넣지 않는다', async (t) => {
    if (!usable) return t.skip('DB에 붙지 못했다');
    await seed('2026-09-06', [buy('000660', 0)]);
    const found = await getLatestStopPrices(account);
    assert.equal(found.has('000660'), false, '0원에 팔라는 뜻이 아니다');
  });
});
