import type { Instrument } from '@invest/shared';

/**
 * 국내 종목명 기반 자산 분류 규칙.
 * KIS 국내 마스터 파일은 ETF 여부를 직접 쓰기 어렵기 때문에 운용사 브랜드 접두어를 보조 신호로 쓴다.
 */

const DOMESTIC_STRONG_ETF_BRAND_PREFIXES = [
  'KODEX',
  'TIGER',
  'KBSTAR',
  'ARIRANG',
  'KOSEF',
  'HANARO',
  'TIMEFOLIO',
  'KOACT',
  'UNICORN',
  '마이다스',
  '히어로즈',
] as const;

const DOMESTIC_BOUNDED_ETF_BRAND_PREFIXES = [
  'ACE',
  'SOL',
  'PLUS',
  'RISE',
  '1Q',
  'WON',
  'FOCUS',
  'BNK',
  'TREX',
  'DAISHIN343',
  'HK',
  'IBK',
  'KCGI',
  'KIWOOM',
  'MIDAS',
  'TIME',
  'TRUSTON',
  '더제이',
  '마이티',
  '에셋플러스',
  '파워',
] as const;

export function inferDomesticAssetType(name: string): Instrument['assetType'] {
  const normalized = name.trim().replace(/\s+/g, ' ');
  const upper = normalized.toUpperCase();
  if (upper.includes('ETN')) return 'etn';
  if (upper.includes('ETF')) return 'etf';

  return hasDomesticEtfBrandPrefix(upper) ? 'etf' : 'stock';
}

function hasDomesticEtfBrandPrefix(name: string): boolean {
  if (DOMESTIC_STRONG_ETF_BRAND_PREFIXES.some((prefix) => name.startsWith(prefix))) return true;
  return DOMESTIC_BOUNDED_ETF_BRAND_PREFIXES.some((prefix) => {
    if (!name.startsWith(prefix)) return false;
    const next = name.slice(prefix.length, prefix.length + 1);
    return !next || /[\s0-9&()\-]/.test(next);
  });
}
