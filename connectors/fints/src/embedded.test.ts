import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createEmbeddedConnector } from "./embedded.js";
import { connectorSetup } from "./setup.js";

describe("connector setup from the environment", () => {
    it("reports where the product ID comes from", () => {
        const dir = mkdtempSync(path.join(tmpdir(), "mbm-setup-"));
        const file = path.join(dir, "product-id");
        writeFileSync(file, "BUILDID\n");
        expect(connectorSetup({ MBM_FINTS_PRODUCT_ID: "EIGENEID" }, file)).toMatchObject({ productSource: "env", options: { productId: "EIGENEID" } });
        expect(connectorSetup({}, file)).toMatchObject({ productSource: "build", options: { productId: "BUILDID" } });
        expect(connectorSetup({}, path.join(dir, "none"))).toMatchObject({ productSource: null, options: { productId: null } });
    });

    it("takes the reported version and the product version from the environment", () => {
        const s = connectorSetup({ MBM_VERSION: "dev-abc1234", MBM_FINTS_PRODUCT_VERSION: "1.10.0" });
        expect(s.version).toBe("dev-abc1234");
        expect(s.options.productVersion).toBe("1.10");
    });
});

describe("embedded connector", () => {
    it("answers over inject and never names the product ID", async () => {
        const c = await createEmbeddedConnector({ MBM_FINTS_PRODUCT_ID: "GEHEIMEID", MBM_VERSION: "9.9.9" });
        try {
            expect(c.startLine).toBe("MBM FinTS connector 9.9.9 embedded (product ID from the environment)");
            expect(c.startLine).not.toContain("GEHEIMEID");
            const res = await c.request({ method: "GET", url: "/v1/info" });
            expect(res.status).toBe(200);
            expect(JSON.parse(res.body)).toMatchObject({ name: "fints", version: "9.9.9", productConfigured: true });
        } finally {
            await c.close();
        }
    });

    it("refuses to contact a bank without a product ID", async () => {
        const c = await createEmbeddedConnector({}, { productId: null });
        try {
            const res = await c.request({ method: "POST", url: "/v1/bank", payload: JSON.stringify({ bank: { blz: "12345678", url: "https://bank.example.invalid/fints" } }) });
            expect(res.status).toBe(503);
            expect(JSON.parse(res.body)).toMatchObject({ error: "product_id_missing" });
        } finally {
            await c.close();
        }
    });
});
