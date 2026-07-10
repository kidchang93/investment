import { API_BASE } from './config';
import type { CandlesResponse, WatchItem } from '@invest/shared';

export async function fetchWatchlist(): Promise<WatchItem[]> {
  const res = await fetch(`${API_BASE}/api/watchlist`);
  if (!res.ok) throw new Error(`watchlist 조회 실패: ${res.status}`);
  return res.json();
}

export async function fetchCandles(code: string): Promise<CandlesResponse> {
  const res = await fetch(`${API_BASE}/api/candles/${code}`);
  if (!res.ok) throw new Error(`candles 조회 실패: ${res.status}`);
  return res.json();
}
