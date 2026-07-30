/**
 * 테마 코드 마스터 고정폭 파싱 검증.
 *
 * 이 파일의 핵심은 **종목코드 필드 폭이 9바이트지 10바이트가 아니라는 것**이다.
 * KIS 공식 파서(`theme_code.py`)는 `row[-10:]`으로 자르는데, 그러면 테마명 필드의
 * 마지막 바이트를 끌어온다. 지금 데이터로는 그 자리가 늘 공백이라 `.strip()`이
 * 삼켜 버려 **결과가 똑같이 나온다** — 그래서 값만 보는 시험으로는 못 잡는다.
 * 자른 **원본** 모양(앞 글자가 공백인가)까지 봐야 걸린다.
 *
 * 픽스처는 파서의 상수를 쓰지 않고 **실측 폭(3·40·9)으로 직접 짓는다.** 검사 대상인
 * 상수로 행을 지으면 상수가 틀려도 행이 같이 틀리게 지어져 왕복이 맞아떨어진다
 * (`domesticMaster.test.ts`에서 실제로 그렇게 통과한 적이 있다).
 *
 * 마지막 describe만 실제 마스터 파일을 읽는다. 파일이 없으면 건너뛴다.
 */

import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  countThemeMembers,
  parseThemeMaster,
  parseThemeMasterRow,
  THEME_MASTER_FILE,
  themeMasterSymbols,
} from './themeMaster.js';

/**
 * backend/.cache 실측(2026-07-31, 파일은 2025-11-06자): 292,984바이트 / 5,528행 /
 * 모든 행이 52바이트. 52 = 테마코드 3 + 테마명 40 + 단축코드 9.
 */
const MEASURED_ROW_BYTES = 52;
const MEASURED_THEME_CODE_BYTES = 3;
const MEASURED_NAME_FIELD_BYTES = 40;
const MEASURED_SYMBOL_FIELD_BYTES = 9;

/**
 * KIS 공식 파서(`theme_code.py`)가 뒤에서 세는 글자 수. 그 `10`은 `9 + 개행`이라
 * **파이썬에서는 맞고**, 개행을 뗀 행에 옮겼을 때만 한 칸 밀린다.
 */
const PYTHON_SYMBOL_TAIL = 10;

describe('parseThemeMasterRow', () => {
  it('테마코드·테마명·종목코드를 읽는다', () => {
    assert.deepEqual(parseThemeMasterRow(buildRow('004', '반도체/반도체장비', '005930')), {
      themeCode: '004',
      themeName: '반도체/반도체장비',
      symbol: '005930',
    });
    assert.deepEqual(parseThemeMasterRow(buildRow('017', '방위산업', '012450')), {
      themeCode: '017',
      themeName: '방위산업',
      symbol: '012450',
    });
    assert.deepEqual(parseThemeMasterRow(buildRow('172', '농업', '001120')), {
      themeCode: '172',
      themeName: '농업',
      symbol: '001120',
    });
  });

  it('한글이 든 행도 뒤에서 재면 자리가 맞는다 — 앞에서 43글자를 세면 어긋난다', () => {
    const row = buildRow('004', '반도체/반도체장비', '005930');
    // 바이트는 52인데 글자는 44다. 고정폭을 앞에서 글자로 세면 안 되는 이유.
    assert.equal(eucKrBytes(row), MEASURED_ROW_BYTES);
    assert.equal(row.length, 44);
    assert.notEqual(row.slice(43), '005930   ', '앞에서 43글자를 세면 엉뚱한 자리다');

    assert.equal(parseThemeMasterRow(row).symbol, '005930');
    assert.equal(parseThemeMasterRow(row).themeName, '반도체/반도체장비');
  });

  it('공식 파서 상수(10)를 개행 뗀 행에 쓰면 앞에 공백이 붙는다 — trim한 값만 보면 똑같아서 안 걸린다', () => {
    const row = buildRow('004', '반도체/반도체장비', '005930');
    const pythonSlice = row.slice(row.length - PYTHON_SYMBOL_TAIL);

    // 값만 보면 구별되지 않는다. 그래서 파서가 자른 원본 모양을 검사한다.
    assert.equal(pythonSlice.trim(), '005930');
    assert.equal(pythonSlice, ' 005930   ');
    assert.equal(row.slice(row.length - MEASURED_SYMBOL_FIELD_BYTES), '005930   ');
  });

  it('공식 파서 상수(10)를 개행 뗀 행에 쓰면 이름이 꽉 찼을 때 끝 글자를 먹는다', () => {
    // 파이썬은 개행이 붙은 행을 받으므로 10이 맞다. 개행을 뗀 우리 행에 그 상수를 쓰면
    // 한 칸 밀린다. 실측 최대 이름은 24바이트라 지금은 드러나지 않지만, 필드가 40바이트이므로
    // 이런 이름이 오는 날 종목코드 자리가 `버005930   `이 되고 이름은 `버`를 잃는다.
    const name = '가나다라마바사아자차카타파하거너더러머버';
    assert.equal(eucKrBytes(name), MEASURED_NAME_FIELD_BYTES);

    const row = buildRow('004', name, '005930');
    assert.equal(row.slice(row.length - PYTHON_SYMBOL_TAIL), '버005930   ', '공식 파서 자리를 쓰면 이렇게 된다');
    assert.equal(row.slice(MEASURED_THEME_CODE_BYTES, row.length - PYTHON_SYMBOL_TAIL), name.slice(0, -1));

    assert.deepEqual(parseThemeMasterRow(row), { themeCode: '004', themeName: name, symbol: '005930' });
  });

  it('종목코드 자리가 한 칸이라도 밀리면 던진다', () => {
    const row = buildRow('004', '반도체/반도체장비', '005930');
    // 왼쪽으로 한 칸(공식 파서의 10): 값은 멀쩡한 6자리라 형식 검사로는 못 잡힌다.
    assert.match(row.slice(row.length - PYTHON_SYMBOL_TAIL).trim(), /^\d{6}$/);
    // 실제로 밀린 행을 만들어 던지는지 본다. 뒤에 공백 하나를 더하면 파서가
    // 자르는 9글자가 한 칸 왼쪽으로 밀린다.
    assert.throws(() => parseThemeMasterRow(`${row} `), /단축코드 자리가 어긋났습니다/);
    // 오른쪽으로 한 칸: 끝 공백 하나를 떼면 코드가 5자리로 읽힌다.
    assert.throws(() => parseThemeMasterRow(row.slice(0, -1)), /단축코드 자리가 어긋났습니다/);
  });

  it('테마코드가 숫자 3자리가 아니면 던진다', () => {
    // 테마코드 1글자를 빠뜨린 행. 이름 첫 글자가 코드 자리로 밀려 들어온다.
    assert.throws(() => parseThemeMasterRow(buildRow('04', '농업', '001120')), /테마코드 자리가 어긋났습니다/);
    assert.throws(() => parseThemeMasterRow(buildRow('00A', '농업', '001120')), /테마코드 자리가 어긋났습니다/);
  });

  it('행이 통째로 짧으면 던진다', () => {
    assert.throws(() => parseThemeMasterRow('004농업 005930'), /행 길이가 고정폭과 맞지 않습니다/);
  });

  it('테마 이름이 비면 던진다', () => {
    assert.throws(() => parseThemeMasterRow(buildRow('999', '', '005930')), /테마 이름이 비었습니다/);
  });
});

describe('parseThemeMaster', () => {
  it('테마 표와 (테마,종목) 쌍을 만든다 — 한 종목이 여러 테마에 든다', () => {
    const master = parseThemeMaster(
      [
        buildRow('004', '반도체/반도체장비', '005930'),
        buildRow('928', 'HBM', '005930'),
        buildRow('017', '방위산업', '012450'),
        buildRow('004', '반도체/반도체장비', '000660'),
      ].join('\n'),
    );

    assert.equal(master.names.size, 3);
    assert.equal(master.names.get('004'), '반도체/반도체장비');
    assert.equal(master.members.length, 4);
    assert.deepEqual(themeMasterSymbols(master), ['005930', '012450', '000660']);
    assert.equal(countThemeMembers(master).get('004'), 2);
    assert.equal(countThemeMembers(master).get('017'), 1);
  });

  it('빈 줄과 끝 개행을 무시한다', () => {
    const text = `${buildRow('172', '농업', '001120')}\n\n`;
    assert.equal(parseThemeMaster(text).members.length, 1);
  });

  it('같은 테마코드에 이름이 둘이면 던진다', () => {
    const text = [buildRow('004', '반도체/반도체장비', '005930'), buildRow('004', '반도체', '000660')].join('\n');
    assert.throws(() => parseThemeMaster(text), /같은 테마코드에 이름이 둘입니다/);
  });

  it('같은 (테마,종목) 쌍이 두 번이면 던진다 — N:M 테이블의 기본키가 깨진다', () => {
    const text = [buildRow('004', '반도체/반도체장비', '005930'), buildRow('004', '반도체/반도체장비', '005930')].join(
      '\n',
    );
    assert.throws(() => parseThemeMaster(text), /같은 \(테마,종목\) 쌍이 두 번 나옵니다/);
  });
});

/**
 * 실제 마스터 파일로 재는 시험. 지어낸 행은 파서의 자리 계산만 확인할 뿐,
 * 진짜 파일이 그 모양인지는 말해 주지 않는다.
 *
 * 값은 2026-07-31에 실측한 것이고, 파일 자체는 2025-11-06자다. 파일이 새로
 * 받아져 숫자가 달라지면 이 시험이 먼저 알려 준다 — **화면이 조용히 다른 것을
 * 보여 주기 전에** 알아야 한다.
 */
describe('theme_code.mst 실측', () => {
  // 이 파일(backend/src/kis) 기준으로 잡는다. `process.cwd()`를 쓰면 레포 루트에서
  // 돌릴 때 조용히 건너뛰어, 시험이 도는 줄 알고 아무것도 안 재게 된다.
  const path = resolve(dirname(fileURLToPath(import.meta.url)), '../../.cache', THEME_MASTER_FILE);
  const exists = (() => {
    try {
      statSync(path);
      return true;
    } catch {
      return false;
    }
  })();

  it('302개 테마 · 5,528쌍 · 고유 2,333종목', { skip: exists ? false : `${path} 없음` }, () => {
    const master = parseThemeMaster(new TextDecoder('euc-kr').decode(readFileSync(path)));
    assert.equal(master.names.size, 302);
    assert.equal(master.members.length, 5528);
    assert.equal(themeMasterSymbols(master).length, 2333);
  });

  it('반도체 110 · 방위산업 27 · 농업 26', { skip: exists ? false : `${path} 없음` }, () => {
    const master = parseThemeMaster(new TextDecoder('euc-kr').decode(readFileSync(path)));
    const counts = countThemeMembers(master);
    for (const [code, name, count] of [
      ['004', '반도체/반도체장비', 110],
      ['017', '방위산업', 27],
      ['172', '농업', 26],
    ] as const) {
      assert.equal(master.names.get(code), name, `테마 ${code} 이름`);
      assert.equal(counts.get(code), count, `테마 ${name} 종목 수`);
    }
  });

  it('업종으로는 못 가르는 것을 테마가 가른다', { skip: exists ? false : `${path} 없음` }, () => {
    const master = parseThemeMaster(new TextDecoder('euc-kr').decode(readFileSync(path)));
    const themesOf = (symbol: string): string[] =>
      master.members
        .filter((row) => row.symbol === symbol)
        .map((row) => row.themeName)
        .sort();

    // 둘 다 지수업종은 `제조 / 전기·전자`다.
    assert.equal(themesOf('005930').length, 16, '삼성전자');
    assert.ok(themesOf('005930').includes('HBM'));
    assert.ok(themesOf('005930').includes('온디바이스AI'));
    assert.ok(themesOf('247540').includes('2차전지(소재,부품,장비)'), '에코프로비엠');

    // 둘 다 지수업종은 `제조 / 운송장비·부품`이다.
    assert.deepEqual(themesOf('012450'), [
      'T-50고등훈련기',
      'UAM',
      '그래핀',
      '로봇',
      '방위산업',
      '보안(물리)',
      '우주(위성,발사체)',
    ]);
    assert.deepEqual(themesOf('042660'), ['LNG', '셰일가스', '조선'], '한화오션');
  });

  it('낡았다 — 2024까지만 있고 2025·2026 신규 상장주는 없다', { skip: exists ? false : `${path} 없음` }, () => {
    const master = parseThemeMaster(new TextDecoder('euc-kr').decode(readFileSync(path)));
    const names = [...master.names.values()];
    for (const year of [2018, 2019, 2020, 2021, 2022, 2023, 2024]) {
      assert.ok(names.includes(`${year} 신규 상장주`), `${year} 신규 상장주`);
    }
    for (const year of [2025, 2026]) {
      assert.equal(names.includes(`${year} 신규 상장주`), false, `${year} 신규 상장주가 생겼다`);
    }
  });
});

/**
 * 실제 파일과 같은 고정폭으로 한 행을 짓는다 (개행은 붙이지 않는다).
 *
 * **폭을 파서에서 가져오지 않고 실측값(3·40·9)으로 박아 둔다.** 파서의 상수가
 * 틀려도 행이 같이 틀리게 지어지면 시험이 통과해 버린다.
 */
function buildRow(themeCode: string, themeName: string, symbol: string): string {
  const padding = MEASURED_NAME_FIELD_BYTES - eucKrBytes(themeName);
  assert.ok(padding >= 0, `${themeName}이(가) ${MEASURED_NAME_FIELD_BYTES}바이트를 넘는다`);
  return (
    themeCode + themeName + ' '.repeat(padding) + symbol.padEnd(MEASURED_SYMBOL_FIELD_BYTES)
  );
}

/** EUC-KR 바이트 폭. 한글·기호는 2바이트다. */
function eucKrBytes(text: string): number {
  return [...text].reduce((sum, char) => sum + (char.charCodeAt(0) < 0x80 ? 1 : 2), 0);
}
