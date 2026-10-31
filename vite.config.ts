import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import electron from 'vite-plugin-electron/simple';
import { resolve } from 'node:path';

// QuantPilot 构建配置：vite 负责 renderer(Vue3)，vite-plugin-electron 负责 main/preload
// 注意：better-sqlite3（原生模块）在 dataService 中用 createRequire 运行时加载，
// 避免 vite 把 native .node 动态 require 内联进 bundle（任何构建器都无法打包 .node）。
export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
      '@renderer': resolve(__dirname, 'src/renderer/src'),
      '@strategy': resolve(__dirname, 'strategy'),
    },
  },
  plugins: [
    vue(),
    electron({
      main: {
        entry: 'src/main/main.ts',
        vite: {
          resolve: {
            alias: {
              '@shared': resolve(__dirname, 'src/shared'),
              '@renderer': resolve(__dirname, 'src/renderer/src'),
            },
          },
          build: {
            outDir: 'dist-electron',
            rollupOptions: { output: { entryFileNames: 'main.js' } },
          },
        },
      },
      preload: {
        input: 'src/preload/preload.ts',
        vite: {
          resolve: {
            alias: {
              '@shared': resolve(__dirname, 'src/shared'),
              '@renderer': resolve(__dirname, 'src/renderer/src'),
            },
          },
          build: {
            outDir: 'dist-electron',
            rollupOptions: { output: { entryFileNames: 'preload.js' } },
          },
        },
      },
      renderer: process.env.NODE_ENV === 'test' ? undefined : {},
    }),
  ],
  server: { port: 5173, strictPort: false },
  clearScreen: false,
});
