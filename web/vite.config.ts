import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const api = process.env.IMPULSE_API ?? "http://localhost:8787";

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
