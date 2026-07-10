/** 백엔드 REST/WS 주소. 배포 시 VITE_API_BASE로 덮어쓴다. */
const rawBase = import.meta.env.VITE_API_BASE ?? 'http://localhost:4000';

export const API_BASE = rawBase.replace(/\/$/, '');
export const STREAM_URL = API_BASE.replace(/^http/, 'ws') + '/stream';
