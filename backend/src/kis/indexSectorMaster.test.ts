/**
 * 지수·업종 코드 마스터 고정폭 파싱 검증.
 *
 * 여기서 이름 자리가 밀리면 종목에 `01종합`·`27제조`처럼 코드가 붙은 이름이 달린다.
 * KIS 공식 파서(`sector_code.py`)가 실제로 그렇게 적혀 있다(`row[3:43]`) — 그대로
 * 옮겼는지 확인하는 것이 이 파일의 핵심이다.
 *
 * 실제 마스터 파일 없이 돌도록 행을 실측 고정폭 그대로 지어서 쓴다.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseIndexSectorMasterRow, parseIndexSectorNames } from './indexSectorMaster.js';

/**
 * backend/.cache 실측(2026-07-31, 파일은 2026-05-21자): 22,586바이트 / 491행 /
 * 모든 행이 45바이트. 45 = 시장구분 1 + 코드 4 + 이름 40.
 *
 * **파서의 상수를 쓰지 않고 실측값으로 행을 짓는다.** 검사 대상인 상수로 행을 지으면
 * 상수가 틀려도 행이 같이 틀리게 지어져 왕복이 맞아떨어진다.
 */
const MEASURED_ROW_BYTES = 45;
const MEASURED_NAME_FIELD_BYTES = 40;

describe('parseIndexSectorMasterRow', () => {
  it('이름 앞에 코드가 붙지 않는다 — 공식 파서의 row[3:43]은 `01종합`을 준다', () => {
    const row = buildRow('0001', '종합');
    assert.equal(row.slice(3, 43).trim(), '01종합', '공식 파서 자리를 그대로 쓰면 이렇게 된다');
    assert.deepEqual(parseIndexSectorMasterRow(row), { code: '0001', name: '종합' });
  });

  it('KOSPI 계열 코드와 이름을 읽는다', () => {
    for (const [code, name] of [
      ['0005', '음식료·담배'],
      ['0008', '화학'],
      ['0013', '전기·전자'],
      ['0015', '운송장비·부품'],
      ['0021', '금융'],
      ['0027', '제조'],
    ] as const) {
      assert.deepEqual(parseIndexSectorMasterRow(buildRow(code, name)), { code, name });
    }
  });

  it('KOSDAQ 계열은 1000번대다 — 같은 `제조`가 KOSPI와 다른 코드다', () => {
    assert.deepEqual(parseIndexSectorMasterRow(buildRow('1009', '제조')), {
      code: '1009',
      name: '제조',
    });
    assert.deepEqual(parseIndexSectorMasterRow(buildRow('1028', '전기·전자')), {
      code: '1028',
      name: '전기·전자',
    });
  });

  it('이름이 40바이트를 꽉 채워도 끝 글자를 잃지 않는다', () => {
    // 실측 파일에서 가장 긴 이름 두 개. 뒤 공백이 없어 한 칸만 짧게 읽어도 드러난다.
    for (const name of ['코스피200 코스닥150 고정비중 5:5레버리지', 'CBOE S&P 500 4% OTM Short Strangle Index']) {
      assert.equal(eucKrBytes(name), MEASURED_NAME_FIELD_BYTES);
      assert.deepEqual(parseIndexSectorMasterRow(buildRow('4415', name)), { code: '4415', name });
    }
  });

  it('이름이 비면 담지 않는다 — 실측에서 `9999` 한 행이 그랬다', () => {
    assert.equal(parseIndexSectorMasterRow(buildRow('9999', '')), null);
  });

  it('숫자가 아닌 코드도 있다 (`E199` ETN · `T000` ETF)', () => {
    assert.deepEqual(parseIndexSectorMasterRow(buildRow('E199', 'ETN')), {
      code: 'E199',
      name: 'ETN',
    });
  });

  it('코드 자리가 어긋나면 던진다', () => {
    // 시장구분 1글자를 빠뜨린 행. 코드 자리에 이름 첫 글자가 들어온다.
    assert.throws(() => parseIndexSectorMasterRow('0027제조'), /코드 자리가 어긋났습니다/);
  });
});

describe('parseIndexSectorNames', () => {
  it('코드 → 이름 표를 만들고 빈 이름은 건너뛴다', () => {
    const text = [buildRow('0027', '제조'), buildRow('9999', ''), buildRow('1009', '제조')].join('\r\n');
    const names = parseIndexSectorNames(text);
    assert.equal(names.size, 2);
    assert.equal(names.get('0027'), '제조');
    assert.equal(names.get('1009'), '제조');
    assert.equal(names.has('9999'), false);
  });

  it('빈 줄과 끝 개행을 무시한다', () => {
    const text = `${buildRow('0013', '전기·전자')}\n\n`;
    assert.equal(parseIndexSectorNames(text).size, 1);
  });

  it('같은 코드가 두 번 나오면 던진다', () => {
    const text = [buildRow('0027', '제조'), buildRow('0027', '제조업')].join('\n');
    assert.throws(() => parseIndexSectorNames(text), /두 번 나옵니다/);
  });
});

/**
 * 실제 파일과 같은 고정폭으로 한 행을 짓는다 (개행은 붙이지 않는다).
 * 시장구분은 코드 첫 글자와 같다 — 491행 전부 그랬다.
 */
function buildRow(code: string, name: string): string {
  assert.equal(code.length, 4, '코드는 4글자다');
  const padding = MEASURED_NAME_FIELD_BYTES - eucKrBytes(name);
  assert.ok(padding >= 0, `${name}이(가) ${MEASURED_NAME_FIELD_BYTES}바이트를 넘는다`);
  const row = code.slice(0, 1) + code + name + ' '.repeat(padding);
  assert.equal(eucKrBytes(row), MEASURED_ROW_BYTES, '행 폭이 실측과 다르다');
  return row;
}

/** EUC-KR 바이트 폭. 한글·기호는 2바이트다. */
function eucKrBytes(text: string): number {
  return [...text].reduce((sum, char) => sum + (char.charCodeAt(0) < 0x80 ? 1 : 2), 0);
}
