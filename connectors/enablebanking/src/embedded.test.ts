import { describe, expect, it } from "vitest";
import { createEmbeddedConnector } from "./embedded.js";

describe("createEmbeddedConnector", () => {
    it("answers over JSON text like on the socket", async () => {
        const c = await createEmbeddedConnector({ MBM_VERSION: "9.9.9" });
        try {
            expect(c.startLine).toBe("MBM Enable Banking connector 9.9.9 embedded");
            const res = await c.request({ method: "GET", url: "/v1/info" });
            expect(res.status).toBe(200);
            expect(JSON.parse(res.body)).toMatchObject({ name: "enablebanking", version: "9.9.9", capabilities: expect.arrayContaining(["psd2"]) });
            const bad = await c.request({ method: "POST", url: "/v1/psd2/banks", payload: "{}" });
            expect(bad.status).toBe(400);
            expect(JSON.parse(bad.body)).toMatchObject({ error: "invalid" });
        } finally {
            await c.close();
        }
    });

    it("has no FinTS routes", async () => {
        const c = await createEmbeddedConnector({});
        try {
            expect((await c.request({ method: "POST", url: "/v1/accounts", payload: "{}" })).status).toBe(404);
        } finally {
            await c.close();
        }
    });
});
