// The bank directory of the Deutsche Bundesbank: bank code, name, place and BIC of every German
// bank. The image brings a copy (server/data-static/blz.json); the server replaces it with the
// current file from bundesbank.de, kept in <dataDir>/blz.json. Public data without any bank or
// personal reference, so it is stored unencrypted.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyBaseLogger as Logger } from "fastify";

export type DirectoryRow = [blz: string, name: string, place: string, bic: string];

/** The JSON file in the image and in the data directory. */
export interface DirectoryFile {
    /** Name of the source file of the Bundesbank. */
    source: string;
    /** Day the file was made (JJJJ-MM-TT). */
    generated: string;
    /** Download address of the source file; only in a downloaded directory. */
    sourceUrl?: string;
    banks: DirectoryRow[];
}

export interface DirectoryEntry {
    blz: string;
    name: string;
    place: string;
    bic: string;
}

export interface DirectoryStatus {
    banks: number;
    generated: string;
    origin: "image" | "download";
    autoUpdate: boolean;
    checkedAt: string | null;
    lastError: string | null;
}

const STATIC_FILE = fileURLToPath(new URL("../../data-static/blz.json", import.meta.url));
const SOURCE_NAME = "blz-aktuell-txt-data.txt";
const MAX_PAGE_BYTES = 2 * 1024 * 1024;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MIN_BANKS = 3000;
const START_DELAY_MS = 10_000;
const INTERVAL_MS = 24 * 60 * 60 * 1000;

// ---------- Reading the file of the Bundesbank ----------

/**
 * Reads the bank code file of the Bundesbank (fixed-width text, ISO 8859-1). Keeps only head
 * offices (Merkmal 1) that are not marked as deleted.
 *
 * Field widths: BLZ 8, Merkmal 1, Bezeichnung 58, PLZ 5, Ort 35, Kurzbezeichnung 27, PAN 5,
 * BIC 11, Prüfziffermethode 2, Datensatznummer 6, Änderungskennzeichen 1, Löschung 1, Nachfolge-BLZ 8
 */
export function parseBlzText(buf: Buffer): DirectoryRow[] {
    const rows: DirectoryRow[] = [];
    for (const line of buf.toString("latin1").split(/\r?\n/)) {
        if (line.length < 150) continue;
        const blz = line.slice(0, 8);
        const head = line[8] === "1";
        const name = line.slice(9, 67).trim();
        const place = line.slice(72, 107).trim();
        const bic = line.slice(139, 150).trim();
        const change = line[158];
        if (!head || change === "D" || !/^\d{8}$/.test(blz)) continue;
        rows.push([blz, name, place, bic]);
    }
    return rows;
}

/** Why a directory cannot be right, or null. */
export function directoryProblem(rows: DirectoryRow[]): string | null {
    if (rows.length < MIN_BANKS) return `Die Datei enthält nur ${rows.length} Banken.`;
    if (!rows.some((r) => r[0] === "10000000")) return "Die Datei enthält die Bundesbank nicht.";
    return null;
}

/** The directory as readable JSON: one bank per line. */
export function formatDirectory(file: DirectoryFile): string {
    const head = Object.entries(file)
        .filter(([k]) => k !== "banks")
        .map(([k, v]) => `    ${JSON.stringify(k)}: ${JSON.stringify(v)},`);
    const banks = file.banks.map((r) => `        [${r.map((v) => JSON.stringify(v)).join(", ")}]`).join(",\n");
    return `{\n${head.join("\n")}\n    "banks": [\n${banks}\n    ]\n}\n`;
}

/** The download address of the current text file, read from the download page of the Bundesbank. */
export function findSourceUrl(html: string, pageUrl: string): string | null {
    const m = new RegExp(`href="([^"]*/${SOURCE_NAME.replace(/\./g, "\\.")}[^"]*)"`, "i").exec(html);
    if (!m?.[1]) return null;
    const url = new URL(m[1].replace(/&amp;/g, "&"), pageUrl);
    // Only from the same site as the page
    return url.origin === new URL(pageUrl).origin ? url.href : null;
}

// ---------- Directory ----------

function readFile(file: string): DirectoryFile | null {
    try {
        if (!existsSync(file)) return null;
        const data = JSON.parse(readFileSync(file, "utf8")) as DirectoryFile;
        return Array.isArray(data.banks) && typeof data.generated === "string" && directoryProblem(data.banks) === null ? data : null;
    } catch {
        return null;
    }
}

async function download(url: string, maxBytes: number, timeoutMs: number): Promise<Buffer> {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: "follow" });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of res.body) {
        size += chunk.length;
        if (size > maxBytes) throw new Error("too large");
        chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
}

export interface BankDirectoryOptions {
    dataDir: string;
    /** Download page of the Bundesbank. */
    pageUrl: string;
    autoUpdate: boolean;
    log: Logger;
    /** Called after the directory was replaced. */
    onChange: () => void;
}

/** The directory in memory, and the regular check for a new file of the Bundesbank. */
export class BankDirectory {
    private file: DirectoryFile;
    private origin: DirectoryStatus["origin"];
    private checkedAt: string | null = null;
    private lastError: string | null = null;
    private running: Promise<void> | null = null;
    private timers: NodeJS.Timeout[] = [];
    private readonly target: string;

    constructor(private readonly opts: BankDirectoryOptions) {
        this.target = path.join(opts.dataDir, "blz.json");
        const downloaded = readFile(this.target);
        const image = readFile(STATIC_FILE);
        // The newer one wins: an image with a newer file than the last download brings it along
        if (downloaded && (!image || downloaded.generated >= image.generated)) {
            this.file = downloaded;
            this.origin = "download";
        } else if (image) {
            this.file = image;
            this.origin = "image";
        } else {
            throw new Error(`bank directory missing: ${STATIC_FILE}`);
        }
    }

    search(q: string): DirectoryEntry[] {
        const query = q.trim().toLowerCase();
        const digits = query.replace(/\s/g, "");
        const rows = this.file.banks;
        const hits = /^\d+$/.test(digits)
            ? rows.filter((r) => r[0].startsWith(digits))
            : rows.filter((r) => r[1].toLowerCase().includes(query) || r[2].toLowerCase().includes(query) || r[3].toLowerCase().startsWith(query));
        return hits.slice(0, 30).map(entry);
    }

    byBlz(blz: string): DirectoryEntry | null {
        const r = this.file.banks.find((x) => x[0] === blz);
        return r ? entry(r) : null;
    }

    status(): DirectoryStatus {
        return {
            banks: this.file.banks.length,
            generated: this.file.generated,
            origin: this.origin,
            autoUpdate: this.opts.autoUpdate,
            checkedAt: this.checkedAt,
            lastError: this.lastError,
        };
    }

    /** Checks shortly after the start and then once a day, if switched on. */
    start(): void {
        if (!this.opts.autoUpdate) return;
        const first = setTimeout(() => void this.check(), START_DELAY_MS);
        const daily = setInterval(() => void this.check(), INTERVAL_MS);
        first.unref();
        daily.unref();
        this.timers = [first, daily];
    }

    stop(): void {
        for (const t of this.timers) clearTimeout(t);
        this.timers = [];
    }

    /** Looks for a new file and loads it. A second call while one runs waits for that one. */
    check(): Promise<void> {
        this.running ??= this.update().finally(() => {
            this.running = null;
        });
        return this.running;
    }

    private async update(): Promise<void> {
        const { log, pageUrl } = this.opts;
        try {
            const page = (await download(pageUrl, MAX_PAGE_BYTES, 30_000)).toString("utf8");
            const sourceUrl = findSourceUrl(page, pageUrl);
            if (!sourceUrl) throw new Error("Auf der Seite der Bundesbank fehlt der Link zur Datei.");
            if (sourceUrl !== this.file.sourceUrl) {
                const rows = parseBlzText(await download(sourceUrl, MAX_FILE_BYTES, 60_000));
                const problem = directoryProblem(rows);
                if (problem) throw new Error(problem);
                const file: DirectoryFile = { source: SOURCE_NAME, generated: new Date().toISOString().slice(0, 10), sourceUrl, banks: rows };
                mkdirSync(this.opts.dataDir, { recursive: true });
                const tmp = `${this.target}.tmp`;
                writeFileSync(tmp, formatDirectory(file));
                renameSync(tmp, this.target);
                this.file = file;
                this.origin = "download";
                log.info({ banks: rows.length }, "bank directory updated");
                this.opts.onChange();
            }
            this.lastError = null;
        } catch (e) {
            this.lastError = e instanceof Error && !/^HTTP |too large|aborted|fetch failed/i.test(e.message) && e.name !== "TimeoutError" ? e.message : "Die Bundesbank war nicht erreichbar.";
            log.warn({ reason: e instanceof Error ? e.message : String(e) }, "bank directory check failed");
        } finally {
            this.checkedAt = new Date().toISOString();
        }
    }
}

const entry = ([blz, name, place, bic]: DirectoryRow): DirectoryEntry => ({ blz, name, place, bic });
