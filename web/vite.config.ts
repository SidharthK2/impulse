import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The API the dev server proxies to: IMPULSE_API (full URL) or API_PORT on localhost (default 8787, the Rust server).
const api = process.env.IMPULSE_API ?? `http://localhost:${process.env.API_PORT ?? "8787"}`;

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": api,
      "/ws": { target: api.replace(/^http/, "ws"), ws: true },
    },
  },
});
