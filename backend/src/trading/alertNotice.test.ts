import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { splitByNotice, type AlertNotice } from './alertNotice.js';

const alert = (key: string, digest: string) => ({ key, digest });
const seen = (...rows: Array<[string, string, string]>): Map<string, AlertNotice> =>
  new Map(rows.map(([key, digest, day]) => [key, { digest, day }]));

describe('경보 알림 억제 — 하루 16번 울려서 사용자가 데몬을 껐다 (2026-08-22)', () => {
  it('한 번도 안 알린 경보는 알린다', () => {
    const r = splitByNotice([alert('layer-mismatch', '131290')], new Map(), '2026-08-21');
    assert.equal(r.fresh.length, 1);
    assert.equal(r.muted.length, 0);
  });

  it('★ 같은 내용을 오늘 이미 알렸으면 조용하다 — 20분마다 같은 말을 하지 않는다', () => {
    const r = splitByNotice(
      [alert('layer-mismatch', '131290')],
      seen(['layer-mismatch', '131290', '2026-08-21']),
      '2026-08-21',
    );
    assert.equal(r.fresh.length, 0);
    assert.equal(r.muted.length, 1, '경보가 사라지는 것이 아니라 알림만 안 뜬다');
  });

  it('★ 내용이 바뀌면 그날 안이라도 다시 알린다 — 종목이 하나 늘었다는 것은 새 사실이다', () => {
    const r = splitByNotice(
      [alert('layer-mismatch', '131290 316140')],
      seen(['layer-mismatch', '131290', '2026-08-21']),
      '2026-08-21',
    );
    assert.equal(r.fresh.length, 1);
  });

  it('★ 날이 바뀌면 다시 알린다 — 어제 넘긴 문제가 오늘도 남아 있다는 소식이다', () => {
    const r = splitByNotice(
      [alert('layer-mismatch', '131290')],
      seen(['layer-mismatch', '131290', '2026-08-21']),
      '2026-08-22',
    );
    assert.equal(r.fresh.length, 1);
  });

  it('종류가 다르면 서로를 막지 않는다', () => {
    const r = splitByNotice(
      [alert('layer-mismatch', '131290'), alert('stop-equity', '')],
      seen(['layer-mismatch', '131290', '2026-08-21']),
      '2026-08-21',
    );
    assert.deepEqual(r.fresh.map((a) => a.key), ['stop-equity']);
    assert.deepEqual(r.muted.map((a) => a.key), ['layer-mismatch']);
  });

  it('빈 digest도 정상적인 값이다 — 내용이 늘 같은 경보(중단선·데몬 정지)가 그렇다', () => {
    const r = splitByNotice(
      [alert('stop-equity', '')],
      seen(['stop-equity', '', '2026-08-21']),
      '2026-08-21',
    );
    assert.equal(r.fresh.length, 0);
  });
});
