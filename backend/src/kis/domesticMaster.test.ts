/**
 * 국내 종목 마스터 고정폭 파싱 검증.
 *
 * 이 파싱이 한 칸 밀리면 화면에 `TIGER 엔비디아미국채커버드콜밸런스(합성`처럼 끝
 * 글자를 잃은 이름이 뜬다. 대부분의 행은 이름 뒤 공백이 잘려 `.trim()`이 삼키므로
 * 티가 나지 않는다 — **이름이 40바이트를 꽉 채운 행만 드러난다.** 그래서 픽스처도
 * 꽉 찬 이름으로 만든다. 여유 있는 이름으로만 재면 이 결함은 시험을 통과한다.
 *
 * 실제 마스터 파일 없이 돌도록 행을 실측 고정폭 그대로 지어서 쓴다.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DOMESTIC_MASTER_SPECS,
  parseDomesticMasterRow,
  type DomesticMasterSpec,
} from './domesticMaster.js';

const KOSPI = specFor('KOSPI');
const KOSDAQ = specFor('KOSDAQ');
const KONEX = specFor('KONEX');

/** KIS 공식 파이썬 파서의 상수. 개행 1글자를 포함한 값이라 우리 기준으로는 1 크다. */
const PYTHON_KOSPI_TAIL = 228;

describe('DOMESTIC_MASTER_SPECS', () => {
  /**
   * backend/.cache 실측(2026-07-31): 행 바이트 수가 시장마다 하나로 고정돼 있었다.
   * 꼬리 = 행 바이트 − 61(단축 9 + 표준 12 + 한글명 40).
   */
  it('실측한 행 바이트 폭과 꼬리 길이가 맞는다', () => {
    const rowBytes: Record<string, number> = { KOSPI: 288, KOSDAQ: 282, KONEX: 245 };
    for (const spec of DOMESTIC_MASTER_SPECS) {
      assert.equal(spec.tailLength, rowBytes[spec.market] - 61, `${spec.market} 꼬리 길이`);
    }
  });

  it('세 시장 꼬리 길이가 서로 다르다 — 일괄로 1을 빼면 KONEX가 어긋난다', () => {
    assert.equal(KOSPI.tailLength, 227);
    assert.equal(KOSDAQ.tailLength, 221);
    assert.equal(KONEX.tailLength, 184);
  });
});

describe('parseDomesticMasterRow', () => {
  it('이름이 40바이트를 꽉 채워도 마지막 글자를 잃지 않는다', () => {
    // 실제로 잘려 있던 종목(0000D0). "TIGER "(6) + 한글 14자(28) + "(합성)"(6) = 40바이트.
    const name = 'TIGER 엔비디아미국채커버드콜밸런스(합성)';
    assert.equal(eucKrBytes(name), 40);

    const row = buildRow(KOSPI, { symbol: '0000D0', standardCode: 'KR7000000D07', name, group: 'EF' });
    assert.equal(parseDomesticMasterRow(row, KOSPI).name, name);
  });

  it('파이썬 상수(228)를 그대로 쓰면 조용히 잘리지 않고 던진다', () => {
    const name = 'TIGER 엔비디아미국채커버드콜밸런스(합성)';
    const row = buildRow(KOSPI, { symbol: '0000D0', standardCode: 'KR7000000D07', name, group: 'EF' });
    const shifted: DomesticMasterSpec = { ...KOSPI, tailLength: PYTHON_KOSPI_TAIL };

    // 이 가드가 없으면 마지막 ')'만 사라진 채 정상 결과처럼 통과한다.
    assert.throws(() => parseDomesticMasterRow(row, shifted), /꼬리 정렬이 어긋났습니다/);
  });

  it('이름이 짧으면 남는 자리의 공백을 떼고 준다', () => {
    const row = buildRow(KOSDAQ, { symbol: '900110', standardCode: 'HK0000057197', name: '딥커머스', group: 'FS' });
    const parsed = parseDomesticMasterRow(row, KOSDAQ);
    assert.equal(parsed.symbol, '900110');
    assert.equal(parsed.standardCode, 'HK0000057197');
    assert.equal(parsed.name, '딥커머스');
  });

  it('한글만 20자여도(=40바이트) 끝까지 읽는다', () => {
    const name = '가나다라마바사아자차카타파하거너더러';
    assert.equal(eucKrBytes(name), 36);
    const full = `${name}머버`; // 40바이트
    assert.equal(eucKrBytes(full), 40);

    const row = buildRow(KONEX, { symbol: '0070X0', standardCode: 'KR70070X0000', name: full, group: 'ST' });
    assert.equal(parseDomesticMasterRow(row, KONEX).name, full);
  });

  it('KONEX는 184 그대로여야 한다 — 1을 빼면 정렬이 깨진다', () => {
    const row = buildRow(KONEX, { symbol: '0070X0', standardCode: 'KR70070X0000', name: '에스테크엠', group: 'ST' });
    assert.equal(parseDomesticMasterRow(row, KONEX).name, '에스테크엠');
    assert.throws(
      () => parseDomesticMasterRow(row, { ...KONEX, tailLength: 183 }),
      /꼬리 정렬이 어긋났습니다/,
    );
  });

  it('꼬리 원본을 그대로 넘겨 준다 — 업종 등 뒤 필드를 여기서 자른다', () => {
    const row = buildRow(KOSPI, { symbol: '005930', standardCode: 'KR7005930003', name: '삼성전자', group: 'ST' });
    const { tail } = parseDomesticMasterRow(row, KOSPI);
    assert.equal(tail.length, KOSPI.tailLength);
    assert.equal(tail.slice(0, 2), 'ST');
  });

  it('행 길이가 고정폭과 맞지 않으면 던진다', () => {
    assert.throws(
      () => parseDomesticMasterRow('005930   KR7005930003삼성전자', KOSPI),
      /행 길이가 고정폭과 맞지 않습니다/,
    );
  });
});

function specFor(market: string): DomesticMasterSpec {
  const spec = DOMESTIC_MASTER_SPECS.find((item) => item.market === market);
  assert.ok(spec, `${market} 스펙이 없다`);
  return spec;
}

/** EUC-KR 바이트 폭. 한글·기호는 2바이트다. */
function eucKrBytes(text: string): number {
  return [...text].reduce((sum, char) => sum + (char.charCodeAt(0) < 0x80 ? 1 : 2), 0);
}

/**
 * 픽스처를 지을 때 쓰는 실측 꼬리 폭. backend/.cache 실측(2026-07-31)에서 직접 온 값이다.
 *
 * **`spec.tailLength`를 쓰면 안 된다.** 검사 대상인 상수로 행을 지으면, 상수가 틀려도
 * 행이 같이 틀리게 지어져 왕복이 맞아떨어진다 — 실제로 처음 판에서 그랬고,
 * `이름이 40바이트를 꽉 채워도…` 시험이 **옛 상수 228에서도 통과했다.**
 * `NO_COSTS`로 도는 승률 시험이 비용 버그를 못 잡던 것과 같은 모양이다.
 * 픽스처는 검사 대상과 독립이어야 시험이 상수를 붙잡는다.
 */
const MEASURED_TAIL_BYTES: Record<string, number> = { KOSPI: 227, KOSDAQ: 221, KONEX: 184 };

/**
 * 마스터 한 행을 실제 파일과 같은 고정폭으로 짓는다 (개행은 붙이지 않는다).
 * 한글명은 40바이트가 되도록 공백으로 채우고, 꼬리는 증권그룹구분코드 + 채움이다.
 */
function buildRow(
  spec: DomesticMasterSpec,
  fields: { symbol: string; standardCode: string; name: string; group: string },
): string {
  const padding = 40 - eucKrBytes(fields.name);
  assert.ok(padding >= 0, `${fields.name}이(가) 40바이트를 넘는다`);
  const tailBytes = MEASURED_TAIL_BYTES[spec.market];
  assert.ok(tailBytes, `${spec.market} 실측 꼬리 폭이 없다`);
  return (
    fields.symbol.padEnd(9) +
    fields.standardCode.padEnd(12) +
    fields.name +
    ' '.repeat(padding) +
    fields.group.padEnd(tailBytes, '0')
  );
}
