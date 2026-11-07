import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  build: {
    outDir: "dist/client",
  },
  optimizeDeps: {
    include: ["react", "react-dom/client"],
  },
  server: {
    watch: { ignored: ["**/data/**"] },
    fs: {
      deny: [".env", ".env.*", "**/.local-runtime.env", "*.{crt,pem}", "**/.git/**", "**/data/**", "**/config/payment-catalog.json"],
    },
    proxy: { "/api/v1": { target: "http://127.0.0.1:8788", changeOrigin: false } },
    host: "127.0.0.1",
    port: 4173,
    strictPort: true,
    allowedHosts: ["terminal.local"],
    warmup: {
      clientFiles: ["./src/main.jsx"],
    },
  },
  plugins: [react()],
});
