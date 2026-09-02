/**
 * 백엔드 REST/WS 주소.
 *
 * ★ **기본이 같은 오리진(빈 문자열)이다** (2026-09-02에 바꿨다). 백엔드가
 *   `frontend/dist`를 함께 내므로 `http://localhost:4000` 하나로 화면·API·
 *   WebSocket이 전부 나온다 — 띄울 것이 둘이면 둘 다 떠 있는지 사람이
 *   확인해야 하고, 그것이 곧 명령어를 치는 일이 된다.
 *
 * ★ `npm run dev:web`(:5173)으로 개발할 때는 오리진이 달라 API가 안 붙는다.
 *   그래서 **개발 서버에서는 :4000을 기본으로** 쓴다(`import.meta.env.DEV`).
 *   배포·다른 주소는 `VITE_API_BASE`로 덮는다.
 */
const fallback = import.meta.env.DEV ? 'http://localhost:4000' : '';
const rawBase = import.meta.env.VITE_API_BASE ?? fallback;

export const API_BASE = rawBase.replace(/\/$/, '');

/** 같은 오리진이면 지금 페이지 기준으로 만든다 — 하드코딩된 호스트가 없다. */
export const STREAM_URL = API_BASE
  ? `${API_BASE.replace(/^http/, 'ws')}/stream`
  : `${window.location.origin.replace(/^http/, 'ws')}/stream`;
