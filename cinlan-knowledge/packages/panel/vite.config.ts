import { defineConfig } from "vite";

// 构建产物由 hub 托管在 /panel/（architecture.md §6）。
// dev 时 /api 与 /dl 代理到本机 hub（install.md §2）；浏览器发出的 Origin 是 http://localhost:5173，
// 要把它写进 hub 配置的 listen.allowedOrigins。
export default defineConfig({
  base: "/panel/",
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": "http://127.0.0.1:8424",
      "/dl": "http://127.0.0.1:8424",
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2022",
  },
});
