import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createEmbeddedConnector } from "@mbm/connector-fints/embedded";
import { createEmbeddedConnector as createEnableBankingConnector } from "@mbm/connector-enablebanking/embedded";
import { ConnectorClient, ConnectorRegistry, embeddedExchange, type EmbeddedConnector, type EmbeddedLoader } from "./connectors/client.js";
import { loadConfig } from "./config.js";

/** An embedded connector that answers every request with `answer`, or never. */
const fake = (answer: ((url: string) => { status: number; body: string }) | "never"): EmbeddedConnector => ({
    startLine: "fake",
    request: ({ url }) => (answer === "never" ? new Promise(() => undefined) : Promise.resolve(answer(url))),
    close: async () => undefined,
});

describe("embedded connector calls", () => {
    it("check answers against the contract and pass on the connector's error codes", async () => {
        const client = new ConnectorClient(
            "fints",
            embeddedExchange(
                Promise.resolve(
                    fake((url) =>
                        url === "/v1/info"
                            ? { status: 200, body: JSON.stringify({ name: "fints", version: "1", capabilities: [] }) }
                            : { status: 503, body: JSON.stringify({ error: "product_id_missing", message: "keine ID" }) },
                    ),
                ),
                1000,
            ),
        );
        await expect(client.call("info")).rejects.toMatchObject({ code: "internal" }); // productConfigured missing
        await expect(client.call("checkBank", { body: { bank: { blz: "12345678", url: "https://x.invalid" } } })).rejects.toMatchObject({ code: "product_id_missing" });
    });

    it("give up after the time limit, as over the socket", async () => {
        const client = new ConnectorClient("fints", embeddedExchange(Promise.resolve(fake("never")), 30));
        await expect(client.call("info")).rejects.toMatchObject({ code: "connector_unavailable" });
    });

    it("report a connector that could not be loaded as unavailable", async () => {
        const failed = Promise.reject(new Error("missing"));
        failed.catch(() => undefined);
        const client = new ConnectorClient("fints", embeddedExchange(failed, 1000));
        await expect(client.call("info")).rejects.toMatchObject({ code: "connector_unavailable" });
    });

    it("stop the start when the embedded connector is missing, and log its start line", async () => {
        const missing: EmbeddedLoader = () => Promise.reject(new Error("no connector inside"));
        const lines: string[] = [];
        await expect(new ConnectorRegistry({ connectors: { fints: { embedded: true } } }, { loadEmbedded: { fints: missing } }).start({ info: (m) => lines.push(m) })).rejects.toThrow("no connector inside");

        const registry = new ConnectorRegistry({ connectors: { fints: { embedded: true } } }, { loadEmbedded: { fints: () => createEmbeddedConnector({ MBM_VERSION: "1.2.3" }, { productId: null }) } });
        await registry.start({ info: (m) => lines.push(m) });
        expect(lines).toEqual(["MBM FinTS connector 1.2.3 embedded (no product ID: banks will not be contacted)"]);
        await registry.refresh();
        expect(registry.status()).toEqual([{ name: "fints", reachable: true, version: "1.2.3", productConfigured: false }]);
        await registry.close();
    });

    it("only for the FinTS and the Enable Banking connector", async () => {
        const registry = new ConnectorRegistry({ connectors: { other: { embedded: true } } });
        await expect(registry.start({ info: () => undefined })).rejects.toThrow("Only the FinTS and the Enable Banking connector can be embedded");
    });

    it("embed the Enable Banking connector next to FinTS", async () => {
        const lines: string[] = [];
        const registry = new ConnectorRegistry(
            { connectors: { fints: { embedded: true }, enablebanking: { embedded: true } } },
            {
                loadEmbedded: {
                    fints: () => createEmbeddedConnector({ MBM_VERSION: "1.2.3" }, { productId: null }),
                    enablebanking: () => createEnableBankingConnector({ MBM_VERSION: "1.2.3" }),
                },
            },
        );
        await registry.start({ info: (m) => lines.push(m) });
        expect(lines).toContain("MBM Enable Banking connector 1.2.3 embedded");
        await registry.refresh();
        expect(registry.status()).toContainEqual({ name: "enablebanking", reachable: true, version: "1.2.3", productConfigured: true });
        await registry.close();
    });
});

describe("connector configuration", () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "mbm-config-"));

    it("takes the socket or the embedded connector from the environment", () => {
        expect(loadConfig({}, cwd).connectors).toEqual({});
        expect(loadConfig({ MBM_FINTS_SOCKET: "/run/mbm/fints.sock" }, cwd).connectors).toEqual({ fints: { socket: "/run/mbm/fints.sock" } });
        expect(loadConfig({ MBM_FINTS_EMBEDDED: "1" }, cwd).connectors).toEqual({ fints: { embedded: true } });
        expect(loadConfig({ MBM_FINTS_EMBEDDED: "true" }, cwd).connectors).toEqual({ fints: { embedded: true } });
        expect(loadConfig({ MBM_FINTS_EMBEDDED: "0" }, cwd).connectors).toEqual({});
    });

    it("takes the Enable Banking connector from the environment, and lets it be switched off", () => {
        expect(loadConfig({ MBM_ENABLEBANKING_SOCKET: "/run/mbm/enablebanking.sock" }, cwd).connectors).toEqual({ enablebanking: { socket: "/run/mbm/enablebanking.sock" } });
        expect(loadConfig({ MBM_FINTS_EMBEDDED: "1", MBM_ENABLEBANKING_EMBEDDED: "1" }, cwd).connectors).toEqual({ fints: { embedded: true }, enablebanking: { embedded: true } });
        const file = path.join(cwd, "eb.yaml");
        writeFileSync(file, "connectors:\n  fints:\n    socket: /run/mbm/fints.sock\n  enablebanking:\n    embedded: true\n");
        expect(loadConfig({ MBM_CONFIG: file, MBM_ENABLEBANKING_EMBEDDED: "0", MBM_FINTS_EMBEDDED: "0" }, cwd).connectors).toEqual({ fints: { socket: "/run/mbm/fints.sock" } });
        expect(() => loadConfig({ MBM_ENABLEBANKING_EMBEDDED: "1", MBM_ENABLEBANKING_SOCKET: "/x.sock" }, cwd)).toThrow("Enable Banking connector is either embedded or on its socket");
    });

    it("refuses both at once", () => {
        expect(() => loadConfig({ MBM_FINTS_EMBEDDED: "1", MBM_FINTS_SOCKET: "/run/mbm/fints.sock" }, cwd)).toThrow("both set");
        const file = path.join(cwd, "both.yaml");
        writeFileSync(file, "connectors:\n  fints:\n    socket: /run/mbm/fints.sock\n    embedded: true\n");
        expect(() => loadConfig({ MBM_CONFIG: file }, cwd)).toThrow();
    });
});
