// The diagrams of docs/datenbankmodell.md. Positions are on a grid; after a change to the schema,
// add the table or edge here, run `npm run diagrams` and look at the result.

import type { Box, Diagram, Edge } from "./svg.js";

// ---------- Overview of the tables ----------

const COL = [0, 100, 320, 540, 760, 980, 1200];
const Y0 = 48; // users band
const Y1 = 108;
const R1 = 222; // main area
const R2 = 318;
const R3 = 420;
const R4 = 515;

/** A table: its centre in column `col` at height `y`; `sub` names references not drawn as an edge. */
const table = (id: string, col: number, y: number, cls: string, sub: string[] = []): Box => ({ id, x: COL[col]!, y, w: 178, h: 32 + sub.length * 13, cls, sub });

const tables: Box[] = [
    table("activity_log", 1, Y0, "d-user", ["→ users"]),
    table("devices", 2, Y0, "d-user"),
    table("users", 3, Y0, "d-user"),
    table("user_settings", 4, Y0, "d-user"),
    table("dashboard_cards", 3, Y1, "d-user"),
    table("import_formats", 6, Y0, "d-misc"),
    table("migrations", 6, Y1, "d-misc"),

    table("bank_ignored_accounts", 1, R1, "d-bank"),
    table("bank_connections", 2, R1, "d-bank"),
    table("sync_runs", 1, R2, "d-bank", ["→ users, accounts"]),
    table("bank_logins", 2, R2, "d-bank", ["→ users"]),
    table("bank_login_accounts", 2, R3, "d-bank"),

    table("account_groups", 3, R1, "d-acc", ["↺ parent_id"]),
    table("accounts", 3, R2, "d-acc", ["↺ reference_account_id"]),
    table("balances", 4, R1, "d-acc"),

    table("transactions", 4, R2, "d-tx", ["↺ counter_transaction_id,", "return_of_id, funding_of_id", "→ users"]),
    table("imports", 4, R3, "d-tx", ["→ users"]),
    table("transaction_edits", 5, R1, "d-tx"),
    table("transaction_unread", 5, R3, "d-tx", ["→ users"]),

    table("transaction_categories", 5, R2, "d-cat"),
    table("categories", 6, R2, "d-cat", ["↺ parent_id"]),
    table("uncategorized_slot", 6, R1, "d-cat"),
    table("rules", 6, R3, "d-cat"),
    table("rule_accounts", 6, R4, "d-cat", ["→ accounts"]),

    table("transfers", 3, R3, "d-ord", ["→ users, bank_logins,", "transactions"]),
    table("standing_orders", 3, R4, "d-ord", ["→ accounts"]),
    table("scheduled_transfers", 4, R4, "d-ord", ["→ accounts"]),
    table("payees", 2, R4, "d-ord"),
];

/** From the table with the foreign key to the table it references. */
const references: Edge[] = [
    { from: "devices", to: "users" },
    { from: "user_settings", to: "users" },
    { from: "dashboard_cards", to: "users" },
    { from: "activity_log", to: "devices", style: "setnull" },

    { from: "bank_ignored_accounts", to: "bank_connections" },
    { from: "bank_logins", to: "bank_connections" },
    { from: "sync_runs", to: "bank_logins", style: "setnull" },
    { from: "sync_runs", to: "bank_connections" },
    { from: "bank_login_accounts", to: "bank_logins" },
    { from: "bank_login_accounts", to: "accounts" },
    { from: "accounts", to: "bank_connections", style: "restrict", label: "sperrt Löschen", dx: 6, dy: -14 },

    { from: "accounts", to: "account_groups", style: "setnull" },
    { from: "balances", to: "accounts" },
    { from: "transactions", to: "accounts" },
    { from: "transactions", to: "imports", style: "setnull" },
    { from: "imports", to: "accounts" },
    { from: "transfers", to: "accounts" },
    { from: "transfers", to: "standing_orders", style: "logical", label: "order_id", dx: 30, anchor: "start" },
    { from: "transfers", to: "scheduled_transfers", style: "logical" },

    { from: "transaction_edits", to: "transactions" },
    { from: "transaction_unread", to: "transactions" },
    { from: "transaction_categories", to: "transactions" },
    { from: "transaction_categories", to: "categories" },
    { from: "transaction_categories", to: "rules", style: "setnull" },
    { from: "rules", to: "categories", style: "setnull" },
    { from: "uncategorized_slot", to: "categories", style: "setnull" },
    { from: "rule_accounts", to: "rules" },
];

export const overview: Diagram = {
    width: 1300,
    height: 560,
    title: "Tabellen der MBM-Datenbank, farbig nach Bereich. Pfeile zeigen vom Fremdschlüssel zur Tabelle, auf die er verweist; durchgezogen ON DELETE CASCADE, gestrichelt SET NULL, orange ohne Löschregel, gepunktet ohne Fremdschlüssel.",
    boxes: tables,
    edges: references,
    behind: `<line class="divider" x1="10" y1="160" x2="1290" y2="160"/>`,
};

// ---------- Keys and files ----------

const key = (id: string, x: number, y: number, label: string, sub: string[], cls: string, w = 210): Box => ({ id, x, y, w, h: 34 + sub.length * 13, label, sub, cls });

export const keys: Diagram = {
    width: 1210,
    height: 385,
    title: "Schlüsselkette: Passwort oder Wiederherstellungsschlüssel packen den Datenschlüssel aus keystore.json aus. Er öffnet mbm.db und liefert den Feldschlüssel für das TOTP-Geheimnis. Bankzugangsdaten versiegelt zusätzlich der Benutzerschlüssel, den nur Passwort oder Sitzungstoken des Besitzers öffnen.",
    boxes: [
        key("rk", 122, 52, "Wiederherstellungsschlüssel", ["beim Betreiber, auf Papier"], "k-secret", 226),
        key("pw", 122, 160, "Passwort", ["je Benutzer, im Kopf"], "k-secret", 226),
        key("tok", 122, 340, "Sitzungstoken", ["beim Client (Cookie / Gerät)"], "k-secret", 226),
        key("ks", 360, 106, "keystore.json", ["Datenschlüssel, verpackt:", "je Benutzer + Wiederherstellung"], "k-file"),
        key("usk", 360, 250, "users.sealed_user_key", [], "k-field"),
        key("dsk", 360, 340, "devices.sealed_user_key", [], "k-field"),
        key("dk", 610, 106, "Datenschlüssel", ["nur im RAM, solange entsperrt"], "k-key", 200),
        key("uk", 610, 295, "Benutzerschlüssel", ["je Benutzer, nur pro Anfrage"], "k-key", 200),
        key("db", 860, 52, "mbm.db + WAL", ["SQLCipher: AES-256 + HMAC"], "k-file"),
        key("fk", 860, 160, "Feldschlüssel", ["HKDF »mbm-fields-v1«"], "k-key"),
        key("totp", 1108, 160, "users.totp_secret", [], "k-field", 200),
        key("bl", 860, 295, "bank_logins", ["sealed_credentials,", "sealed_connector_state"], "k-field"),
        key("blz", 1100, 52, "blz.json", ["unverschlüsselt, öffentlich"], "k-plain", 200),
    ],
    edges: [
        { from: "rk", to: "ks", style: "flow", label: "scrypt", dy: -10 },
        { from: "pw", to: "ks", style: "flow", label: "scrypt", dy: 12 },
        { from: "ks", to: "dk", style: "flow", label: "packt aus", dy: -10 },
        { from: "dk", to: "db", style: "flow", label: "öffnet", dx: -16, dy: -6 },
        { from: "dk", to: "fk", style: "flow", label: "HKDF", dx: -14, dy: 8 },
        { from: "fk", to: "totp", style: "flow", label: "AES-GCM", dy: -10 },
        { from: "pw", to: "usk", style: "flow", label: "scrypt", dx: -6, dy: 14 },
        { from: "tok", to: "dsk", style: "flow", label: "HKDF", dy: -10 },
        { from: "usk", to: "uk", style: "flow", label: "AES-GCM", dx: 4, dy: -12 },
        { from: "dsk", to: "uk", style: "flow", label: "AES-GCM", dx: 4, dy: 14 },
        { from: "uk", to: "bl", style: "flow", accent: true, label: "AES-GCM", dy: -10 },
    ],
};

// ---------- States of a transfer (services/transfers.ts) ----------

const state = (id: string, x: number, y: number, cls: string, w = 168): Box => ({ id, x, y, w, h: 34, cls });

export const transferStates: Diagram = {
    width: 990,
    height: 460,
    title: "Zustände in transfers.status: submitting, die Wartezustände awaiting_vop_confirm und awaiting_tan, dann executed, rejected, unknown, cancelled oder failed. unknown wird executed, sobald ein Abruf die Buchung findet.",
    boxes: [
        { id: "waiting", x: 380, y: 160, w: 214, h: 236, cls: "", group: "wartet auf den Benutzer" },
        state("submitting", 110, 240, "s-run"),
        state("awaiting_vop_confirm", 380, 92, "s-wait", 186),
        state("awaiting_tan", 380, 232, "s-wait", 186),
        state("executed", 690, 70, "s-ok"),
        state("rejected", 690, 160, "s-bad"),
        state("unknown", 690, 250, "s-warn"),
        state("cancelled", 380, 345, "s-end"),
        state("failed", 690, 430, "s-bad"),
    ],
    edges: [
        { from: "submitting", to: "awaiting_vop_confirm", style: "flow", label: "Name weicht ab", dx: -52, dy: -4 },
        { from: "submitting", to: "awaiting_tan", style: "flow", label: "TAN nötig", dy: 12 },
        { from: "awaiting_vop_confirm", to: "awaiting_tan", style: "flow", label: "bestätigt", dx: 34 },
        { from: "submitting", to: "executed", style: "flow", via: [{ x: 110, y: 34 }, { x: 690, y: 34 }], label: "ausgeführt ohne TAN", dy: -10 },
        { from: "awaiting_tan", to: "executed", style: "flow", label: "freigegeben", dx: 6, dy: -10 },
        { from: "awaiting_tan", to: "rejected", style: "flow", label: "abgelehnt", dx: 8, dy: 10 },
        { from: "awaiting_tan", to: "unknown", style: "flow", label: "Antwort verloren", dy: 14 },
        { from: "waiting", to: "cancelled", style: "flow", label: "abgebrochen", dx: 42 },
        { from: "submitting", to: "failed", style: "flow", via: [{ x: 110, y: 430 }], label: "Fehler", dy: -10 },
        { from: "unknown", to: "executed", style: "logical", accent: true, via: [{ x: 820, y: 250 }, { x: 820, y: 70 }], label: "Abruf findet die\nBuchung (E2E-ID)", dx: 10, anchor: "start" },
    ],
};
