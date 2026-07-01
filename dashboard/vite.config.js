import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
    // Proxy WebSocket to ESP32 during local dev
    // Change the target IP if your ESP32 is on a different address
    proxy: {
      "/ws": {
        target: "ws://192.168.4.1:81",
        ws: true
      }
    }
  }
});
