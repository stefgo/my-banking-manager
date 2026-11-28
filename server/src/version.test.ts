import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { migrations } from "./db/migrations/index.js";
import { startFakeConnector, type FakeConnector } from "./testing/fakeConnector.js";
import { createTestApp, setUpSignedIn, type TestApp } from "./testing/testApp.js";
import { serverVersion } from "./version.js";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };

let t: TestApp | undefined;
let fc: FakeConnector | undefined;
afterEach(async () => {
    await t?.close();
    await fc?.close();
    t = undefined;
    fc = undefined;
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

describe("versions of all modules", () => {
    it("names server, connectors, runtime and the schema of the database", async () => {
        fc = await startFakeConnector();
        t = await createTestApp({ connectors: { fints: { socket: fc.socket } } });
        const { api } = await setUpSignedIn(t);
        const { status, body } = await api<Record<string, unknown>>("GET", "/api/system/versions");
        expect(status).toBe(200);
        expect(body).toEqual({
            server: serverVersion(),
            webBuild: null,
            connectors: [{ name: "fints", embedded: false, reachable: true, version: "test", productConfigured: true }],
            node: process.versions.node,
            sqlite: expect.stringMatching(/^3\.\d+\.\d+$/),
            sqliteCiphers: expect.stringMatching(/^\d+\.\d+\.\d+$/),
            schema: migrations.at(-1)!.name,
        });
    });

    it("are only for signed-in users", async () => {
        t = await createTestApp();
        await setUpSignedIn(t);
        expect((await t.app.inject({ url: "/api/system/versions" })).statusCode).toBe(401);
    });
});
