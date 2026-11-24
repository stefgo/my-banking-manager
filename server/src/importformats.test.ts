import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BUILTIN_IMPORT_FORMATS, type Account, type ImportFormat, type ImportFormatDefinition, type ImportPreview, type TransactionList } from "@mbm/shared";
import { linkBookedTransfers } from "./services/transfers.js";
import { createTestApp, setUpSignedIn, type TestApp } from "./testing/testApp.js";

let t: TestApp;

beforeEach(async () => {
    t = await createTestApp();
});
afterEach(async () => {
    await t.close();
});

const HEADER = "Datum;Wertstellung;Kategorie;Name;Verwendungszweck;Konto;Bank;Betrag;Währung";
const LINE = "19.11.2026;19.11.2026;;Muster GmbH;Übertrag, Umsatzart: Echtzeitüberweisung, Referenz: MBM-TEST, Mandat: M-1, Gläubiger-ID: DE98ZZZ09999999999;DE02120300000000202051;BYLADEM1001;-1,00;EUR";
const FILE = `${HEADER}\n${LINE}\n`;
const MONEY = BUILTIN_IMPORT_FORMATS.find((f) => f.key === "builtin:moneymoney")!.definition;

const simple: ImportFormatDefinition = {
    version: 1,
    file: { encoding: "auto", delimiter: ";", quote: "\"", headerLine: 1 },
    steps: [],
    fields: { bookingDate: [{ column: "Datum" }], amount: [{ column: "Betrag" }] },
    values: { dateOrder: "dmy", decimalSeparator: ",", categorySeparator: "auto", pendingWords: [] },
};

async function setUp() {
    const { api } = await setUpSignedIn(t);
    const account = (await api<Account>("POST", "/api/accounts", { name: "Konto" })).body;
    const items = async () => (await api<TransactionList>("GET", "/api/transactions?range=all")).body.items;
    return { api, account, items };
}

describe("import formats", () => {
    it("lists the formats of the app and keeps own ones", async () => {
        const { api } = await setUp();
        const list = async () => (await api<ImportFormat[]>("GET", "/api/import-formats")).body;
        expect((await list()).map((f) => f.key)).toEqual(BUILTIN_IMPORT_FORMATS.map((f) => f.key));

        const created = await api<ImportFormat>("POST", "/api/import-formats", { name: "Mein Format", definition: simple });
        expect(created.body).toMatchObject({ name: "Mein Format", builtin: false, key: `custom:${created.body.id}` });
        expect((await list()).at(-1)?.definition).toEqual(simple);

        const renamed = await api<ImportFormat>("PATCH", `/api/import-formats/${created.body.id}`, { name: "Neu" });
        expect(renamed.body).toMatchObject({ name: "Neu", definition: simple });
        expect((await api("DELETE", `/api/import-formats/${created.body.id}`)).status).toBe(200);
        expect(await list()).toHaveLength(BUILTIN_IMPORT_FORMATS.length);
        expect((await api("DELETE", `/api/import-formats/${created.body.id}`)).status).toBe(404);
    });

    it("refuses a name in use, also one of the app and in other case", async () => {
        const { api } = await setUp();
        await api("POST", "/api/import-formats", { name: "Mein Format", definition: simple });
        expect((await api("POST", "/api/import-formats", { name: "mein format", definition: simple })).status).toBe(409);
        expect((await api("POST", "/api/import-formats", { name: "moneymoney (csv)", definition: simple })).status).toBe(409);
    });

    it("refuses a format whose step reads an unknown step", async () => {
        const { api } = await setUp();
        const broken = { ...simple, fields: { ...simple.fields, remittance: [{ step: "nope", part: "x" }] } };
        expect((await api("POST", "/api/import-formats", { name: "Kaputt", definition: broken })).status).toBe(400);
    });

    it("recognizes the format by the header and stores the details", async () => {
        const { api, account, items } = await setUp();
        const preview = (await api<ImportPreview>("POST", `/api/accounts/${account.id}/import/preview`, { fileName: "x.csv", content: FILE })).body;
        expect(preview.formatKey).toBe("builtin:moneymoney");
        expect(preview.columns).toMatchObject({ date: 0, purpose: null, bookingText: null, counterpartyBic: 6 });
        expect(preview.rows[0]).toMatchObject({ purpose: "Übertrag", bookingText: "Echtzeitüberweisung", reference: "MBM-TEST" });

        await api("POST", `/api/accounts/${account.id}/import`, { fileName: "x.csv", content: FILE });
        expect((await items())[0]).toMatchObject({
            remittance: "Übertrag",
            bookingText: "Echtzeitüberweisung",
            reference: "MBM-TEST",
            mandateId: "M-1",
            creditorId: "DE98ZZZ09999999999",
            counterpartyBic: "BYLADEM1001",
        });
    });

    it("prefers an own format with the same columns", async () => {
        const { api, account } = await setUp();
        const own = (await api<ImportFormat>("POST", "/api/import-formats", { name: "Eigenes", definition: MONEY })).body;
        const preview = (await api<ImportPreview>("POST", `/api/accounts/${account.id}/import/preview`, { fileName: "x.csv", content: FILE })).body;
        expect(preview.formatKey).toBe(own.key);
    });

    it("says what a chosen format misses in the file", async () => {
        const { api, account } = await setUp();
        const res = await api<{ error: string; message: string }>("POST", `/api/accounts/${account.id}/import/preview`, { fileName: "x.csv", content: "Datum;Betrag\n01.10.2026;1,00\n", format: MONEY });
        expect(res.status).toBe(400);
        expect(res.body.error).toBe("format_mismatch");
        expect(res.body.message).toContain("Verwendungszweck");
    });

    it("still takes a plain column assignment", async () => {
        const { api, account, items } = await setUp();
        const columns = { date: 0, valueDate: null, amount: 2, name: 1, iban: null, purpose: null, status: null, category: null };
        const res = await api("POST", `/api/accounts/${account.id}/import`, { fileName: "x.csv", content: "Tag;Wer;Wert\n01.10.2026;Markt;-2,50\n", columns });
        expect(res.status).toBe(200);
        expect((await items())[0]).toMatchObject({ counterpartyName: "Markt", amount: -250 });
    });

    it("fills in only empty details of bookings already stored and keeps their purpose", async () => {
        const { api, account, items } = await setUp();
        await api("POST", `/api/accounts/${account.id}/transactions`, { bookingDate: "2026-11-19", amount: -100, counterpartyName: "Muster GmbH", remittance: "Langer alter Text" });
        const id = (await items())[0]!.id;
        t.vault.database.prepare("UPDATE transactions SET mandate_id = 'BLEIBT' WHERE id = ?").run(id);

        const preview = (await api<ImportPreview>("POST", `/api/accounts/${account.id}/import/preview`, { fileName: "x.csv", content: FILE })).body;
        expect(preview.counts).toMatchObject({ new: 0, duplicate: 1, filled: 1 });
        expect(preview.rows[0]).toMatchObject({ fillsBookingText: true, fillsDetails: true });
        expect(preview.rows[0]!.fills).toEqual(expect.arrayContaining(["bookingText", "reference", "creditorId"]));
        expect(preview.rows[0]!.fills).not.toContain("mandateId");

        const result = (await api<{ imported: number; bookingTextsFilled: number; detailsFilled: number; filled: number }>("POST", `/api/accounts/${account.id}/import`, { fileName: "x.csv", content: FILE })).body;
        expect(result).toMatchObject({ imported: 0, bookingTextsFilled: 1, detailsFilled: 1, filled: 1 });
        expect((await items())[0]).toMatchObject({ remittance: "Langer alter Text", bookingText: "Echtzeitüberweisung", reference: "MBM-TEST", mandateId: "BLEIBT", creditorId: "DE98ZZZ09999999999" });

        const again = (await api<ImportPreview>("POST", `/api/accounts/${account.id}/import/preview`, { fileName: "x.csv", content: FILE })).body;
        expect(again.counts.filled).toBe(0);
    });

    it("counts bookings that got only a kind of booking or only details once each", async () => {
        const { api, account } = await setUp();
        const add = (day: string, name: string) => api("POST", `/api/accounts/${account.id}/transactions`, { bookingDate: `2026-11-${day}`, amount: -100, counterpartyName: name });
        await add("01", "Eins");
        await add("02", "Zwei");
        t.vault.database.prepare("UPDATE transactions SET reference = 'R', mandate_id = 'M', creditor_id = 'C', counterparty_bic = 'BYLADEM1001' WHERE counterparty_name = 'Eins'").run();
        t.vault.database.prepare("UPDATE transactions SET booking_text = 'Lastschrift' WHERE counterparty_name = 'Zwei'").run();
        const line = (day: string, name: string) => `${day}.11.2026;${day}.11.2026;;${name};Umsatzart: X, Referenz: R2;;BYLADEM1001;-1,00;EUR`;
        const res = (await api<{ bookingTextsFilled: number; detailsFilled: number; filled: number }>("POST", `/api/accounts/${account.id}/import`, { fileName: "x.csv", content: `${HEADER}\n${line("01", "Eins")}\n${line("02", "Zwei")}\n` })).body;
        expect(res).toMatchObject({ bookingTextsFilled: 1, detailsFilled: 1, filled: 2 });
    });

    it("detects the format without an account", async () => {
        const { api } = await setUp();
        const known = await api<{ formatKey: string | null }>("POST", "/api/import-formats/detect", { content: FILE });
        expect(known.body.formatKey).toBe("builtin:moneymoney");
        const unknown = await api<{ formatKey: string | null; format: ImportFormatDefinition }>("POST", "/api/import-formats/detect", { content: "Tag;Wert\n01.10.2026;1,00\n" });
        expect(unknown.body.formatKey).toBeNull();
        expect(unknown.body.format.version).toBe(1);
        expect((await api<{ error: string }>("POST", "/api/import-formats/detect", { content: "" })).body.error).toBe("empty_file");
    });

    it("leaves out deselected new rows, also their missing category", async () => {
        const { api, account, items } = await setUp();
        const line = (day: string, name: string, category: string) => `${day}.11.2026;${day}.11.2026;${category};${name};Text;;;-1,00;EUR`;
        const content = `${HEADER}\n${line("01", "Bleibt", "Testkategorie")}\n${line("02", "Weg", "Nur abgewählt")}\n`;
        const res = await api<{ imported: number; excluded: number; createdCategories: number }>("POST", `/api/accounts/${account.id}/import`, { fileName: "x.csv", content, createCategories: true, excludeLines: [2] });
        expect(res.body).toMatchObject({ imported: 1, excluded: 1, createdCategories: 1 });
        expect((await items()).map((i) => i.counterpartyName)).toEqual(["Bleibt"]);
        const names = t.vault.database.prepare("SELECT name FROM categories").pluck().all() as string[];
        expect(names).toContain("Testkategorie");
        expect(names).not.toContain("Nur abgewählt");
    });

    it("does not fill in or overwrite a deselected booking", async () => {
        const { api, account, items } = await setUp();
        await api("POST", `/api/accounts/${account.id}/transactions`, { bookingDate: "2026-11-19", amount: -100, counterpartyName: "Muster GmbH" });
        const res = await api<{ imported: number; skipped: number; filled: number; excluded: number }>("POST", `/api/accounts/${account.id}/import`, { fileName: "x.csv", content: FILE, excludeLines: [1] });
        expect(res.body).toMatchObject({ imported: 0, skipped: 1, filled: 0, excluded: 1 });
        expect((await items())[0]).toMatchObject({ bookingText: "", reference: "", mandateId: "" });
    });

    it("keeps equal rows matched when one of them is deselected", async () => {
        const { api, account, items } = await setUp();
        await api("POST", `/api/accounts/${account.id}/transactions`, { bookingDate: "2026-11-19", amount: -100, counterpartyName: "Muster GmbH" });
        const row = "19.11.2026;19.11.2026;;Muster GmbH;Text;;;-1,00;EUR";
        const res = await api<{ imported: number; skipped: number; excluded: number }>("POST", `/api/accounts/${account.id}/import`, { fileName: "x.csv", content: `${HEADER}\n${row}\n${row}\n${row}\n`, excludeLines: [2] });
        // Row 1 is the stored booking, row 2 is left out, only row 3 is new
        expect(res.body).toMatchObject({ imported: 1, skipped: 1, excluded: 1 });
        expect(await items()).toHaveLength(2);
    });

    it("never links a transfer through a reference from a file", async () => {
        const { api, account, items } = await setUp();
        const db = t.vault.database;
        const insert = db.prepare(
            "INSERT INTO transfers (request_id, account_id, created_by, created_by_name, payee_name, payee_iban, amount, remittance, end_to_end_id, status, created_at, updated_at) VALUES ('r1', ?, 1, 'Anna', 'X', 'DE02120300000000202051', 100, 'x', 'MBM-TEST', 'unknown', '2026-11-19T00:00:00Z', '2026-11-19T00:00:00Z')",
        );
        insert.run(account.id);
        await api("POST", `/api/accounts/${account.id}/import`, { fileName: "x.csv", content: FILE });
        expect((await items())[0]!.reference).toBe("MBM-TEST");
        expect(db.prepare("SELECT end_to_end_id AS id FROM transactions").get()).toEqual({ id: null });
        expect(linkBookedTransfers(db, account.id)).toBe(0);
        expect(db.prepare("SELECT status, transaction_id AS tx FROM transfers").get()).toEqual({ status: "unknown", tx: null });
    });

    describe("kinds of reference", () => {
        const refs: ImportFormatDefinition = {
            ...simple,
            fields: { ...simple.fields, counterpartyName: [{ column: "Name" }], reference: [{ column: "Ref" }], customerReference: [{ column: "KRef" }], bankReference: [{ column: "BRef" }] },
        };
        const file = (ref: string, kref = "", bref = "") => `Datum;Name;Betrag;Ref;KRef;BRef\n19.11.2026;Muster GmbH;-1,00;${ref};${kref};${bref}\n`;
        const withMatch = (referenceMatch: NonNullable<ImportFormatDefinition["values"]["referenceMatch"]>): ImportFormatDefinition => ({ ...refs, values: { ...refs.values, referenceMatch } });

        async function stored(columns: { reference?: string; customer_reference?: string; bank_reference?: string }) {
            const s = await setUp();
            await s.api("POST", `/api/accounts/${s.account.id}/transactions`, { bookingDate: "2026-11-19", amount: -100, counterpartyName: "Muster GmbH" });
            const id = (await s.items())[0]!.id;
            const db = t.vault.database;
            db.prepare("UPDATE transactions SET reference = ?, customer_reference = ?, bank_reference = ? WHERE id = ?").run(columns.reference ?? "", columns.customer_reference ?? "", columns.bank_reference ?? "", id);
            return s;
        }

        it("stores each kind of a new booking in its own field", async () => {
            const { api, account, items } = await setUp();
            const res = await api("POST", `/api/accounts/${account.id}/import`, { fileName: "x.csv", content: file("E2E-1", "KREF-1", "BANK-1"), format: refs });
            expect(res.status).toBe(200);
            expect((await items())[0]).toMatchObject({ reference: "E2E-1", customerReference: "KREF-1", bankReference: "BANK-1" });
        });

        it("fills in nothing when a kind searched holds the reference already", async () => {
            const { api, account, items } = await stored({ bank_reference: "x-1" });
            const preview = (await api<ImportPreview>("POST", `/api/accounts/${account.id}/import/preview`, { fileName: "x.csv", content: file("X-1"), format: refs })).body;
            expect(preview.rows[0]).toMatchObject({ state: "duplicate", fillsDetails: false, fills: [] });
            expect(preview.counts.filled).toBe(0);
            const result = (await api<{ detailsFilled: number }>("POST", `/api/accounts/${account.id}/import`, { fileName: "x.csv", content: file("X-1"), format: refs })).body;
            expect(result.detailsFilled).toBe(0);
            expect((await items())[0]).toMatchObject({ reference: "", customerReference: "", bankReference: "x-1" });
        });

        it("fills in its own empty kind when the kinds searched do not hold it", async () => {
            const { api, account, items } = await stored({ bank_reference: "X-1" });
            const format = withMatch({ reference: ["reference"] });
            const preview = (await api<ImportPreview>("POST", `/api/accounts/${account.id}/import/preview`, { fileName: "x.csv", content: file("X-1"), format })).body;
            expect(preview.rows[0]!.fills).toEqual(["reference"]);
            const result = (await api<{ detailsFilled: number }>("POST", `/api/accounts/${account.id}/import`, { fileName: "x.csv", content: file("X-1"), format })).body;
            expect(result.detailsFilled).toBe(1);
            expect((await items())[0]).toMatchObject({ reference: "X-1", customerReference: "", bankReference: "X-1" });
        });

        it("fills in only the kinds the plan names and keeps one set otherwise", async () => {
            const { api, account, items } = await stored({ reference: "ALT", customer_reference: "" });
            const preview = (await api<ImportPreview>("POST", `/api/accounts/${account.id}/import/preview`, { fileName: "x.csv", content: file("NEU", "ALT", "BANK-1"), format: refs })).body;
            expect(preview.rows[0]!.fills).toEqual(["bankReference"]);
            await api("POST", `/api/accounts/${account.id}/import`, { fileName: "x.csv", content: file("NEU", "ALT", "BANK-1"), format: refs });
            expect((await items())[0]).toMatchObject({ reference: "ALT", customerReference: "", bankReference: "BANK-1" });
        });

        it("refuses a format reading one source for two kinds", async () => {
            const { api, account } = await setUp();
            const format = { ...refs, fields: { ...refs.fields, customerReference: [{ column: "Ref" }] } };
            const res = await api("POST", `/api/accounts/${account.id}/import/preview`, { fileName: "x.csv", content: file("X-1"), format });
            expect(res.status).toBe(400);
        });
    });
});
