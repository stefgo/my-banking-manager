import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fintsProductVersion, resolveProductId } from "./product.js";

let dir: string | undefined;

afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
});

/** A product-id file with this content in a fresh temporary folder. */
function file(content: string): string {
    dir = mkdtempSync(path.join(tmpdir(), "mbm-product-"));
    const p = path.join(dir, "product-id");
    writeFileSync(p, content);
    return p;
}

describe("FinTS product ID", () => {
    it("takes the environment before the file of the build", () => {
        expect(resolveProductId(" EIGENEID ", file("BUILDID\n"))).toEqual({ id: "EIGENEID", source: "env" });
    });

    it("takes the file of the build when the environment is empty", () => {
        expect(resolveProductId("", file(" BUILDID\n"))).toEqual({ id: "BUILDID", source: "build" });
        expect(resolveProductId("  ", file("BUILDID"))).toEqual({ id: "BUILDID", source: "build" });
        expect(resolveProductId(undefined, file("BUILDID"))).toEqual({ id: "BUILDID", source: "build" });
    });

    it("has none without environment and file", () => {
        expect(resolveProductId(undefined, path.join(tmpdir(), "mbm-no-such-folder", "product-id"))).toEqual({ id: null, source: null });
        expect(resolveProductId("", file("\n"))).toEqual({ id: null, source: null });
    });
});

describe("FinTS product version", () => {
    it("keeps a version of up to five characters", () => {
        expect(fintsProductVersion("1.0.0")).toBe("1.0.0");
        expect(fintsProductVersion("9.9.9")).toBe("9.9.9");
        expect(fintsProductVersion(" 2.1 ")).toBe("2.1");
    });

    it("shortens a longer version to major.minor, never ending in a dot", () => {
        expect(fintsProductVersion("1.10.0")).toBe("1.10");
        expect(fintsProductVersion("10.2.1")).toBe("10.2");
        expect(fintsProductVersion("12.34.5")).toBe("12.34");
        expect(fintsProductVersion("v1.10.0")).toBe("1.10");
    });

    it("drops a pre-release part", () => {
        expect(fintsProductVersion("1.1.0-beta.2")).toBe("1.1");
        expect(fintsProductVersion("10.10.0-beta.1")).toBe("10.10");
        expect(fintsProductVersion("100.10.0-beta.1")).toBe("100");
    });

    it("falls back to the major version, and cuts anything else", () => {
        expect(fintsProductVersion("123.45.0")).toBe("123");
        expect(fintsProductVersion("123456.0.0")).toBe("12345");
        expect(fintsProductVersion("abcdefgh")).toBe("abcde");
    });
});
