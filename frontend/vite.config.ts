import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    // `npm run dev:web`에서도 화면은 같은 오리진만 부른다. 백엔드(:4000)로 넘기는 것은 여기 한 곳이다.
    proxy: {
      '/api': 'http://localhost:4000',
      '/stream': { target: 'ws://localhost:4000', ws: true },
    },
  },
});
