import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const server = process.env.MBM_SERVER ?? "http://localhost:3040";

export default defineConfig({
    plugins: [react(), tailwindcss()],
    resolve: {
        alias: { "@mbm/shared": fileURLToPath(new URL("../../shared/src/index.ts", import.meta.url)) },
    },
    server: {
        port: 5173,
        proxy: {
            "/api/events": { target: server.replace(/^http/, "ws"), ws: true },
            "/api": { target: server },
        },
    },
    build: { outDir: "dist", sourcemap: false, chunkSizeWarningLimit: 1200 },
});
