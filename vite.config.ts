import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';

// 源码在 ui/，产物直接落到 web/ —— 服务端的静态处理（src/server.mjs 里的 WEB_DIR）
// 一个字节都不用改：它本来就按 web/ 下的文件名发 .js/.css 的 content-type。
export default defineConfig({
  root: path.resolve(import.meta.dirname, 'ui'),
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': path.resolve(import.meta.dirname, 'ui/src') } },
  build: {
    outDir: path.resolve(import.meta.dirname, 'web'),
    emptyOutDir: true,
    sourcemap: false,
    cssCodeSplit: false
  },
  server: { port: 5173, proxy: { '/admin': 'http://127.0.0.1:8787', '/v1': 'http://127.0.0.1:8787' } }
});
