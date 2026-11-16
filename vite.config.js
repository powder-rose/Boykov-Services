import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig(({ mode }) => ({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": `http://127.0.0.1:${loadEnv(mode, process.cwd(), "").PORT || 8787}`,
    },
    fs: {
      deny: [
        ".env",
        ".env.*",
        "**/.env*",
        "**/.git/**",
        "**/data/**",
        "**/worker/**",
        "**/server/**",
      ],
    },
  },
  build: { sourcemap: false },
}));
