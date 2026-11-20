import { createServer, type Server } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { AddressInfo } from "node:net";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestApp, setUpSignedIn, type TestApp } from "./testing/testApp.js";
import { BankDirectory, findSourceUrl, formatDirectory, parseBlzText, type DirectoryFile } from "./services/bankdirectory.js";

// ---------- A bank code file in the format of the Bundesbank ----------

const pad = (s: string, n: number) => s.padEnd(n, " ").slice(0, n);

/** One line of the fixed-width file (168 characters). */
function line(blz: string, name: string, place: string, bic: string, opts: { head?: boolean; change?: string } = {}): string {
    return [blz, opts.head === false ? "2" : "1", pad(name, 58), "10115", pad(place, 35), pad(name, 27), "00000", pad(bic, 11), "09", "000001", opts.change ?? "U", "0", "00000000"].join("");
}

/** A file with the Bundesbank, one named bank and enough others to pass the checks. */
function bankFile(extra = 3000): Buffer {
    const lines = [line("10000000", "Bundesbank", "Berlin", "MARKDEF1100"), line("70099999", "Testbank Größenwahn", "Bad Tölz", "TESTDEM1XXX")];
    for (let i = 0; i < extra; i++) lines.push(line(String(20000000 + i), `Bank ${i}`, "Ort", ""));
    return Buffer.from(lines.join("\r\n") + "\r\n", "latin1");
}

describe("reading the file of the Bundesbank", () => {
    it("keeps head offices that are not deleted, with umlauts from ISO 8859-1", () => {
        const text = [
            line("10000000", "Bundesbank", "Berlin", "MARKDEF1100"),
            line("10000001", "Filiale", "Berlin", "", { head: false }),
            line("10000002", "Gelöschte Bank", "Köln", "", { change: "D" }),
            line("70054306", "Sparkasse Bad Tölz-Wolfratshausen", "Bad Tölz", "BYLADEM1WOR"),
            "zu kurz",
        ].join("\r\n");
        expect(parseBlzText(Buffer.from(text, "latin1"))).toEqual([
            ["10000000", "Bundesbank", "Berlin", "MARKDEF1100"],
            ["70054306", "Sparkasse Bad Tölz-Wolfratshausen", "Bad Tölz", "BYLADEM1WOR"],
        ]);
    });

    it("finds the link to the current text file on the download page", () => {
        const html = `<a href="/resource/blob/602702/x/y/blz-neu-txt-data.txt">neu</a><a href="/resource/blob/602632/3a97/472B/blz-aktuell-txt-data.txt">aktuell</a>`;
        expect(findSourceUrl(html, "https://www.bundesbank.de/de/download")).toBe("https://www.bundesbank.de/resource/blob/602632/3a97/472B/blz-aktuell-txt-data.txt");
        // Never from another site
        expect(findSourceUrl(`<a href="https://example.invalid/blz-aktuell-txt-data.txt">x</a>`, "https://www.bundesbank.de/de/download")).toBeNull();
    });

    it("writes one bank per line", () => {
        const file: DirectoryFile = { source: "a.txt", generated: "2026-11-18", banks: [["10000000", "Bundesbank", "Berlin", "MARKDEF1100"], ["10010010", "Postbank", "Berlin", ""]] };
        const text = formatDirectory(file);
        expect(text.split("\n")).toEqual([
            "{",
            '    "source": "a.txt",',
            '    "generated": "2026-11-18",',
            '    "banks": [',
            '        ["10000000", "Bundesbank", "Berlin", "MARKDEF1100"],',
            '        ["10010010", "Postbank", "Berlin", ""]',
            "    ]",
            "}",
            "",
        ]);
        expect(JSON.parse(text)).toEqual(file);
    });
});

// ---------- Update from a local stand-in for bundesbank.de ----------

let site: Server;
let base: string;
let link: string;
let body: Buffer;
let fileRequests: number;
let t: TestApp | undefined;
let api: Awaited<ReturnType<typeof setUpSignedIn>>["api"];

interface Status {
    banks: number;
    origin: string;
    autoUpdate: boolean;
    checkedAt: string | null;
    lastError: string | null;
}

beforeEach(async () => {
    link = "/resource/blob/602632/aaa/bbb/blz-aktuell-txt-data.txt";
    body = bankFile();
    fileRequests = 0;
    site = createServer((req, res) => {
        if (req.url === "/download") {
            res.end(`<html><body><a href="${link}" title="Bankleitzahlendatei">TXT</a></body></html>`);
        } else if (req.url === link) {
            fileRequests++;
            res.end(body);
        } else {
            res.statusCode = 404;
            res.end();
        }
    });
    await new Promise<void>((resolve) => site.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
});

afterEach(async () => {
    await t?.close();
    t = undefined;
    await new Promise<void>((resolve) => site.close(() => resolve()));
});

async function start(autoUpdate = true): Promise<TestApp> {
    const app = await createTestApp({ bankDirectoryUpdate: autoUpdate, bankDirectoryUrl: `${base}/download` });
    t = app;
    ({ api } = await setUpSignedIn(app));
    return app;
}

describe("updating the bank directory", () => {
    it("starts with the copy of the image, then loads the current file into the data directory", async () => {
        const { dataDir } = await start();
        const before = await api<Status>("GET", "/api/bank-directory");
        expect(before.body).toMatchObject({ origin: "image", autoUpdate: true, checkedAt: null, lastError: null });
        expect(before.body.banks).toBeGreaterThan(3000);

        const after = await api<Status>("POST", "/api/bank-directory/check");
        expect(after.body).toMatchObject({ origin: "download", banks: 3002, lastError: null });
        expect(after.body.checkedAt).not.toBeNull();

        const hits = await api<{ blz: string; name: string; place: string }[]>("GET", "/api/banks?q=Größenwahn");
        expect(hits.body).toEqual([{ blz: "70099999", name: "Testbank Größenwahn", place: "Bad Tölz", bic: "TESTDEM1XXX" }]);

        const saved = path.join(dataDir, "blz.json");
        expect(readFileSync(saved, "utf8").split("\n").slice(0, 5)).toEqual([
            "{",
            '    "source": "blz-aktuell-txt-data.txt",',
            expect.stringMatching(/^ {4}"generated": "\d{4}-\d{2}-\d{2}",$/),
            `    "sourceUrl": "${base}${link}",`,
            '    "banks": [',
        ]);

        // After a restart the downloaded file is used
        const again = new BankDirectory({ dataDir, pageUrl: `${base}/download`, autoUpdate: false, log: pino({ level: "silent" }), onChange: () => {} });
        expect(again.status()).toMatchObject({ origin: "download", banks: 3002 });
    });

    it("loads the file only when the link changed", async () => {
        await start();
        await api("POST", "/api/bank-directory/check");
        await api("POST", "/api/bank-directory/check");
        expect(fileRequests).toBe(1);
        link = "/resource/blob/602632/ccc/ddd/blz-aktuell-txt-data.txt";
        body = bankFile(3100);
        const r = await api<Status>("POST", "/api/bank-directory/check");
        expect(fileRequests).toBe(2);
        expect(r.body.banks).toBe(3102);
    });

    it("keeps the directory when the file is broken or the site is down", async () => {
        await start();
        await api("POST", "/api/bank-directory/check");
        link = "/resource/blob/602632/eee/fff/blz-aktuell-txt-data.txt";
        body = bankFile(10);
        const broken = await api<Status>("POST", "/api/bank-directory/check");
        expect(broken.body).toMatchObject({ origin: "download", banks: 3002, lastError: "Die Datei enthält nur 12 Banken." });

        await new Promise<void>((resolve) => site.close(() => resolve()));
        site.listen(0); // closed again in afterEach
        const down = await api<Status>("POST", "/api/bank-directory/check");
        expect(down.body).toMatchObject({ banks: 3002, lastError: "Die Bundesbank war nicht erreichbar." });
    });

    it("does not check when switched off", async () => {
        const { dataDir } = await start(false);
        const r = await api<{ error: string }>("POST", "/api/bank-directory/check");
        expect(r.status).toBe(409);
        expect(existsSync(path.join(dataDir, "blz.json"))).toBe(false);
        expect((await api<Status>("GET", "/api/bank-directory")).body).toMatchObject({ origin: "image", autoUpdate: false });
    });
});
