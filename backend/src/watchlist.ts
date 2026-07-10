import type { WatchItem } from '@invest/shared';

/**
 * 기본 감시 종목.
 * .env의 WATCHLIST="005930:삼성전자,000660:SK하이닉스" 형식으로 덮어쓸 수 있다.
 */
const DEFAULT_WATCHLIST: WatchItem[] = [
  { code: '005930', name: '삼성전자' },
  { code: '000660', name: 'SK하이닉스' },
  { code: '035420', name: 'NAVER' },
  { code: '035720', name: '카카오' },
  { code: '005380', name: '현대차' },
];

function parseEnvWatchlist(raw: string | undefined): WatchItem[] | null {
  if (!raw?.trim()) return null;
  const items = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [code, name] = entry.split(':');
      return { code: code?.trim() ?? '', name: name?.trim() || code?.trim() || '' };
    })
    .filter((it) => /^\d{6}$/.test(it.code));
  return items.length ? items : null;
}

export const WATCHLIST: WatchItem[] = parseEnvWatchlist(process.env.WATCHLIST) ?? DEFAULT_WATCHLIST;
