import { API_BASE } from './config';
import type { CandlesResponse, Instrument, InstrumentCategory, Quote, WatchItem } from '@invest/shared';

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

export async function fetchQuote(code: string): Promise<Quote> {
  const res = await fetch(`${API_BASE}/api/quote/${code}`);
  if (!res.ok) throw new Error(`quote 조회 실패: ${res.status}`);
  return res.json();
}

export async function searchInstruments(query: string): Promise<Instrument[]> {
  const params = new URLSearchParams({ q: query });
  const res = await fetch(`${API_BASE}/api/instruments/search?${params.toString()}`);
  if (!res.ok) throw new Error(`종목 검색 실패: ${res.status}`);
  return res.json();
}

export async function fetchInstrumentCandles(id: string): Promise<CandlesResponse> {
  const res = await fetch(`${API_BASE}/api/instruments/${encodeURIComponent(id)}/candles`);
  if (!res.ok) throw new Error(`종목 차트 조회 실패: ${res.status}`);
  return res.json();
}

export async function fetchInstrumentQuote(id: string): Promise<Quote> {
  const res = await fetch(`${API_BASE}/api/instruments/${encodeURIComponent(id)}/quote`);
  if (!res.ok) throw new Error(`종목 현재가 조회 실패: ${res.status}`);
  return res.json();
}

export async function fetchInstrumentIntradayCandles(id: string): Promise<CandlesResponse> {
  const res = await fetch(`${API_BASE}/api/instruments/${encodeURIComponent(id)}/intraday-candles`);
  if (!res.ok) throw new Error(`종목 분봉 조회 실패: ${res.status}`);
  return res.json();
}

export async function fetchInstrumentQuotes(ids: string[]): Promise<Quote[]> {
  const res = await fetch(`${API_BASE}/api/instruments/quotes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ids }),
  });
  if (!res.ok) throw new Error(`종목 현재가 배치 조회 실패: ${res.status}`);
  return res.json();
}

export async function fetchInstrumentCategories(): Promise<InstrumentCategory[]> {
  const res = await fetch(`${API_BASE}/api/instruments/categories`);
  if (!res.ok) throw new Error(`종목 카테고리 조회 실패: ${res.status}`);
  return res.json();
}

export async function fetchCategoryInstruments(id: string): Promise<Instrument[]> {
  const res = await fetch(`${API_BASE}/api/instruments/categories/${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error(`종목 리스트 조회 실패: ${res.status}`);
  return res.json();
}

export async function fetchDefaultWatchlist(): Promise<Instrument[]> {
  const res = await fetch(`${API_BASE}/api/watchlists/default`);
  if (!res.ok) throw new Error(`관심종목 조회 실패: ${res.status}`);
  return res.json();
}

export async function addDefaultWatchlistItem(instrumentId: string): Promise<Instrument> {
  const res = await fetch(`${API_BASE}/api/watchlists/default/items`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ instrumentId }),
  });
  if (!res.ok) throw new Error(`관심종목 추가 실패: ${res.status}`);
  return res.json();
}

export async function removeDefaultWatchlistItem(instrumentId: string): Promise<void> {
  const res = await fetch(`${API_BASE}/api/watchlists/default/items/${encodeURIComponent(instrumentId)}`, {
    method: 'DELETE',
  });
  if (!res.ok) throw new Error(`관심종목 삭제 실패: ${res.status}`);
}
