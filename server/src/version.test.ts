import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { createTestApp, type TestApp } from "./testing/testApp.js";
import { serverVersion } from "./version.js";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };

let t: TestApp | undefined;
afterEach(async () => {
    await t?.close();
    t = undefined;
});

describe("server version", () => {
    it("takes the version of the image build before that of the package", () => {
        expect(serverVersion(" dev-abc1234 ")).toBe("dev-abc1234");
        expect(serverVersion("")).toBe(pkg.version);
        expect(serverVersion(undefined)).toBe(pkg.version);
    });

    it("reports it in the status", async () => {
        t = await createTestApp();
        const status = (await t.app.inject({ url: "/api/status" })).json() as { version: string };
        expect(status.version).toBe(serverVersion());
        expect(status.version).not.toBe("");
    });
});
