import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        projects: [
            { test: { name: "shared", root: "shared", include: ["src/**/*.test.ts"] } },
            {
                resolve: { conditions: ["development"] },
                ssr: { resolve: { conditions: ["development"] } },
                test: { name: "server", root: "server", include: ["src/**/*.test.ts"], testTimeout: 20000 },
            },
            {
                resolve: { conditions: ["development"] },
                ssr: { resolve: { conditions: ["development"] } },
                test: { name: "fints", root: "connectors/fints", include: ["src/**/*.test.ts"], testTimeout: 20000 },
            },
            {
                resolve: { conditions: ["development"] },
                ssr: { resolve: { conditions: ["development"] } },
                test: { name: "enablebanking", root: "connectors/enablebanking", include: ["src/**/*.test.ts"] },
            },
            {
                resolve: { conditions: ["development"] },
                ssr: { resolve: { conditions: ["development"] } },
                test: { name: "web", root: "clients/web", include: ["src/**/*.test.ts"] },
            },
        ],
    },
});
