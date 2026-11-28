import { describe, expect, it } from "vitest";
import type { VersionsResponse } from "@mbm/shared";
import { moduleRows, versionsText } from "./versions";

const base: VersionsResponse = {
    server: "0.7.0",
    webBuild: "abc",
    connectors: [{ name: "fints", embedded: true, reachable: true, version: "0.7.0", productConfigured: true }],
    node: "26.13.1",
    sqlite: "3.53.4",
    sqliteCiphers: "2.4.0",
    schema: "0017-booking-edits",
};

const row = (v: VersionsResponse, key: string, own: string | null = "abc") => moduleRows(v, own).find((r) => r.key === key)!;

describe("moduleRows", () => {
    it("names server, web client and every known connector, configured or not", () => {
        expect(moduleRows(base, "abc").map((r) => [r.label, r.state])).toEqual([
            ["My Banking Manager", "0.7.0"],
            ["Web-Client", "0.7.0"],
            ["FinTS-Konnektor", "0.7.0"],
            ["Enable-Banking-Konnektor", "nicht eingerichtet"],
        ]);
        expect(row(base, "fints")).toMatchObject({ tone: "ok", details: ["Im Server eingebettet"] });
        expect(row(base, "enablebanking").tone).toBe("off");
    });

    it("marks a web client older than the one the server delivers", () => {
        expect(row(base, "web", "old")).toMatchObject({ state: "veraltet", tone: "attn", outdated: true });
        expect(row(base, "web", null).outdated).toBe(false);
    });

    it("warns of a silent connector and of a missing product ID", () => {
        const silent = { ...base, connectors: [{ ...base.connectors[0]!, embedded: false, reachable: false, version: null }] };
        expect(row(silent, "fints")).toMatchObject({ state: "nicht erreichbar", tone: "attn" });
        expect(row(silent, "fints").details[0]).toBe("Eigener Dienst");
        const noProduct = { ...base, connectors: [{ ...base.connectors[0]!, productConfigured: false }] };
        expect(row(noProduct, "fints").tone).toBe("attn");
        expect(row(noProduct, "fints").details).toContain("Keine Produkt-ID eingetragen (MBM_FINTS_PRODUCT_ID)");
    });
});

describe("versionsText", () => {
    it("lists every module and the runtime, one per line", () => {
        const text = versionsText(base, "abc");
        expect(text.split("\n")).toHaveLength(8);
        expect(text).toContain("FinTS-Konnektor: 0.7.0 · Im Server eingebettet");
        expect(text).toContain("Datenbankschema: 0017-booking-edits");
    });
});
