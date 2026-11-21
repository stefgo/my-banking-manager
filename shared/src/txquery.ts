// Search syntax of the transaction list and of category rules: words, quoted phrases, wildcards
// (* ?), fields (gegenseite: zweck: iban: konto: kategorie: betrag: datum: ist:, also in English:
// counterparty: purpose: account: category: amount: date: is:), comparisons
// (> >= < <= =) for amounts and dates (absolute, partial or relative), UND / ODER / NICHT (or
// AND / OR / NOT, upper case only), "-" for NICHT and parentheses. Whitespace between terms means
// UND; UND binds stronger than ODER.

import { addDaysIso, isValidIsoDate, todayIso } from "./dates.js";
import { formatCents, parseAmount } from "./money.js";

export const TXQUERY_MAX_TERMS = 50;
export const TXQUERY_MAX_DEPTH = 10;
export const TXQUERY_MAX_LENGTH = 200;

/** Lower case, without accents, ß as ss, whitespace runs as one space. */
export function foldText(s: string): string {
    return s
        .toLowerCase()
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "")
        .replace(/ß/g, "ss")
        .replace(/\s+/g, " ");
}

/** A value in quotes for the search syntax, safe for any text: gegenseite:"Café \"Am Eck\"". */
export function quoteTxQueryValue(s: string): string {
    return `"${s.replace(/[\\"]/g, "\\$&")}"`;
}

type TextField = "counterparty" | "remittance" | "iban" | "account" | "category" | "amount";
type Cmp = ">" | ">=" | "<" | "<=" | "=";

export type TxQueryNode =
    | { k: "and" | "or"; items: TxQueryNode[] }
    | { k: "not"; item: TxQueryNode }
    | { k: "text"; field: TextField | null; test: (s: string) => boolean; testCompact: (s: string) => boolean }
    | { k: "amount"; op: Cmp; cents: number; signed: boolean }
    | { k: "date"; op: Cmp | ":"; from: string; to: string }
    | { k: "nocat" }
    | { k: "unread" };

export interface TxQueryOptions {
    /** The day relative dates count from; default: today in local time. */
    today?: string;
    /** "rule": no kategorie:, no ist:, no relative dates, at least one term. */
    mode?: "search" | "rule";
}

export type TxQueryResult =
    | { ok: true; query: TxQueryNode | null; hasDate: boolean }
    | { ok: false; error: string; at: number };

/** A transaction prepared for matching: all texts already folded. */
export interface TxQueryTarget {
    counterparty: string;
    remittance: string;
    iban: string;
    amountText: string;
    amount: number;
    category: string;
    categoryPath: string[];
    uncategorized: boolean;
    accountPath: string[];
    accountIban: string;
    bookingDate: string;
    unread: boolean;
}

export interface TxQueryInput {
    counterparty: string;
    /** Ultimate party (e.g. the shop of a card payment); `gegenseite:` finds either name. */
    ultimateParty?: string;
    remittance: string;
    iban: string | null;
    /** Cents, signed. */
    amount: number;
    /** Name of the own category, "" without one. */
    category: string;
    /** Names of the own category and all its parents (for `kategorie:`). */
    categoryPath: string[];
    uncategorized: boolean;
    /** Name of the account and of all its groups (for `konto:`). */
    accountPath: string[];
    accountIban: string | null;
    bookingDate: string;
    /** New for the user searching (for `ist:neu`); rules never see it. */
    unread?: boolean;
}

const compact = (s: string | null) => foldText(s ?? "").replace(/ /g, "");

export function toTxQueryTarget(t: TxQueryInput): TxQueryTarget {
    return {
        counterparty: foldText(t.ultimateParty ? `${t.ultimateParty} / ${t.counterparty}` : t.counterparty),
        remittance: foldText(t.remittance),
        iban: compact(t.iban),
        amountText: foldText(formatCents(Math.abs(t.amount))),
        amount: t.amount,
        category: foldText(t.category),
        categoryPath: t.categoryPath.map(foldText),
        uncategorized: t.uncategorized,
        accountPath: t.accountPath.map(foldText),
        accountIban: compact(t.accountIban),
        bookingDate: t.bookingDate,
        unread: t.unread ?? false,
    };
}

export function matchTxQuery(node: TxQueryNode | null, t: TxQueryTarget): boolean {
    if (!node) return true;
    switch (node.k) {
        case "and":
            return node.items.every((n) => matchTxQuery(n, t));
        case "or":
            return node.items.some((n) => matchTxQuery(n, t));
        case "not":
            return !matchTxQuery(node.item, t);
        case "nocat":
            return t.uncategorized;
        case "unread":
            return t.unread;
        case "amount": {
            const v = node.signed ? t.amount : Math.abs(t.amount);
            return compare(v, node.op, node.cents);
        }
        case "date":
            switch (node.op) {
                case ">":
                    return t.bookingDate > node.to;
                case ">=":
                    return t.bookingDate >= node.from;
                case "<":
                    return t.bookingDate < node.from;
                case "<=":
                    return t.bookingDate <= node.to;
                default:
                    return t.bookingDate >= node.from && t.bookingDate <= node.to;
            }
        case "text":
            switch (node.field) {
                case "counterparty":
                    return node.test(t.counterparty);
                case "remittance":
                    return node.test(t.remittance);
                case "iban":
                    return node.testCompact(t.iban);
                case "account":
                    return t.accountPath.some(node.test) || (!!t.accountIban && node.testCompact(t.accountIban));
                case "category":
                    return t.categoryPath.some(node.test);
                case "amount":
                    return node.test(t.amountText);
                default:
                    return node.test(t.counterparty) || node.test(t.remittance) || node.testCompact(t.iban) || node.test(t.amountText) || node.test(t.category);
            }
    }
}

function compare(a: number, op: Cmp, b: number): boolean {
    switch (op) {
        case ">":
            return a > b;
        case ">=":
            return a >= b;
        case "<":
            return a < b;
        case "<=":
            return a <= b;
        case "=":
            return a === b;
    }
}

/** Days a query can match at most; missing ends are open. `from` > `to` means none. */
export interface TxDateBounds {
    from?: string;
    to?: string;
}

/** The smallest span of booking days that holds every match of the query. */
export function dateBounds(node: TxQueryNode | null): TxDateBounds {
    if (!node) return {};
    switch (node.k) {
        case "date":
            switch (node.op) {
                case ">":
                    return { from: addDaysIso(node.to, 1) };
                case ">=":
                    return { from: node.from };
                case "<":
                    return { to: addDaysIso(node.from, -1) };
                case "<=":
                    return { to: node.to };
                default:
                    return { from: node.from, to: node.to };
            }
        case "and": {
            const parts = node.items.map(dateBounds);
            const froms = parts.flatMap((p) => (p.from ? [p.from] : []));
            const tos = parts.flatMap((p) => (p.to ? [p.to] : []));
            return { from: froms.sort().at(-1), to: tos.sort()[0] };
        }
        case "or": {
            const parts = node.items.map(dateBounds);
            return {
                from: parts.every((p) => p.from) ? parts.map((p) => p.from!).sort()[0] : undefined,
                to: parts.every((p) => p.to) ? parts.map((p) => p.to!).sort().at(-1) : undefined,
            };
        }
        default:
            return {};
    }
}

// ---------- Dates ----------

const pad = (n: number) => String(n).padStart(2, "0");
const iso = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;

function lastDay(y: number, m: number): number {
    return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** `months` months before or after a day; the day sticks to the end of shorter months. */
function addMonthsIso(day: string, months: number): string {
    const [y, m, d] = day.split("-").map(Number) as [number, number, number];
    const total = y * 12 + (m - 1) + months;
    const ny = Math.floor(total / 12);
    const nm = (total % 12) + 1;
    return iso(ny, nm, Math.min(d, lastDay(ny, nm)));
}

function weekday(day: string): number {
    const [y, m, d] = day.split("-").map(Number) as [number, number, number];
    return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7; // Monday = 0
}

function monthSpan(y: number, m: number): { from: string; to: string } {
    return { from: iso(y, m, 1), to: iso(y, m, lastDay(y, m)) };
}

/** English names of calendar periods and their German counterparts. */
const NAMED_EN: Readonly<Record<string, string>> = {
    today: "heute",
    yesterday: "gestern",
    week: "woche",
    lastweek: "vorwoche",
    month: "monat",
    lastmonth: "vormonat",
    quarter: "quartal",
    lastquarter: "vorquartal",
    year: "jahr",
    lastyear: "vorjahr",
};

/** Calendar periods by name (German or English), relative to `today`. */
function namedSpan(name: string, today: string): { from: string; to: string } | null {
    const word = Object.hasOwn(NAMED_EN, name) ? NAMED_EN[name]! : name;
    const [y, m] = today.split("-").map(Number) as [number, number];
    const q = Math.floor((m - 1) / 3);
    const monday = addDaysIso(today, -weekday(today));
    switch (word) {
        case "heute":
            return { from: today, to: today };
        case "gestern": {
            const d = addDaysIso(today, -1);
            return { from: d, to: d };
        }
        case "woche":
            return { from: monday, to: addDaysIso(monday, 6) };
        case "vorwoche":
            return { from: addDaysIso(monday, -7), to: addDaysIso(monday, -1) };
        case "monat":
            return monthSpan(y, m);
        case "vormonat":
            return m === 1 ? monthSpan(y - 1, 12) : monthSpan(y, m - 1);
        case "quartal":
            return { from: iso(y, q * 3 + 1, 1), to: monthSpan(y, q * 3 + 3).to };
        case "vorquartal":
            return q === 0 ? { from: iso(y - 1, 10, 1), to: iso(y - 1, 12, 31) } : { from: iso(y, q * 3 - 2, 1), to: monthSpan(y, q * 3).to };
        case "jahr":
            return { from: iso(y, 1, 1), to: iso(y, 12, 31) };
        case "vorjahr":
            return { from: iso(y - 1, 1, 1), to: iso(y - 1, 12, 31) };
        default:
            return null;
    }
}

/**
 * A date as a span of days: full or partial ("2026", "2026-03", "3.2026", "1.3.2026",
 * "2026-03-01"), the last N days, weeks, months or years up to today ("-30t", "-2w", "-3m", "-1j",
 * in English also "-30d" and "-1y") or a calendar period by name ("vormonat", "lastmonth").
 * `relative` tells whether it depends on today.
 */
export function parseDateSpec(s: string, today = todayIso()): { from: string; to: string; relative: boolean } | null {
    const word = s.trim().toLowerCase();
    const named = namedSpan(word, today);
    if (named) return { ...named, relative: true };
    let r = /^-(\d{1,4})([twmjdy])$/.exec(word);
    if (r) {
        const n = Number(r[1]);
        if (n < 1) return null;
        const unit = r[2] === "d" ? "t" : r[2] === "y" ? "j" : r[2]!;
        const from =
            unit === "t" ? addDaysIso(today, -(n - 1)) : unit === "w" ? addDaysIso(today, -(7 * n - 1)) : addDaysIso(addMonthsIso(today, -(unit === "m" ? n : 12 * n)), 1);
        return { from, to: today, relative: true };
    }
    let y: number;
    let m: number | null = null;
    let d: number | null = null;
    if ((r = /^(\d{4})$/.exec(word))) y = Number(r[1]);
    else if ((r = /^(\d{4})-(\d{1,2})$/.exec(word))) [y, m] = [Number(r[1]), Number(r[2])];
    else if ((r = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(word))) [y, m, d] = [Number(r[1]), Number(r[2]), Number(r[3])];
    else if ((r = /^(\d{1,2})\.(\d{4})$/.exec(word))) [m, y] = [Number(r[1]), Number(r[2])];
    else if ((r = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(word))) [d, m, y] = [Number(r[1]), Number(r[2]), Number(r[3])];
    else return null;
    if (y < 1900 || y > 2999) return null;
    if (m === null) return { from: iso(y, 1, 1), to: iso(y, 12, 31), relative: false };
    if (m < 1 || m > 12) return null;
    if (d === null) return { ...monthSpan(y, m), relative: false };
    const day = iso(y, m, d);
    return isValidIsoDate(day) ? { from: day, to: day, relative: false } : null;
}

// ---------- Parsing ----------

const FIELDS: Record<string, TextField | "date" | "flag"> = {
    gegenseite: "counterparty",
    name: "counterparty",
    zweck: "remittance",
    verwendungszweck: "remittance",
    iban: "iban",
    konto: "account",
    kategorie: "category",
    kat: "category",
    betrag: "amount",
    datum: "date",
    ist: "flag",
};

/** English names of the fields; the parser reads them like the German ones. */
const FIELDS_EN: Record<string, TextField | "date" | "flag"> = {
    counterparty: "counterparty",
    purpose: "remittance",
    account: "account",
    category: "category",
    cat: "category",
    amount: "amount",
    date: "date",
    is: "flag",
};

const ALL_FIELDS: Record<string, TextField | "date" | "flag"> = { ...FIELDS, ...FIELDS_EN };

/** Values of `ist:` (German and English). */
export const TX_QUERY_FLAGS = ["neu"] as const;
const FLAG_VALUES = new Set(["neu", "new"]);

/** German field names of the search syntax and what they search; for suggestions while typing. */
export const TX_QUERY_FIELDS: Readonly<Record<string, TextField | "date" | "flag">> = FIELDS;

/** English field names (counterparty:, purpose:, amount: …) and what they search. */
export const TX_QUERY_FIELDS_EN: Readonly<Record<string, TextField | "date" | "flag">> = FIELDS_EN;

/** What a field name of either language searches, case-insensitive; undefined if it is none. */
export function txQueryField(name: string): TextField | "date" | "flag" | undefined {
    const key = name.toLowerCase();
    return Object.hasOwn(ALL_FIELDS, key) ? ALL_FIELDS[key] : undefined;
}

const OPERATORS: Record<string, "and" | "or" | "not"> = { UND: "and", AND: "and", ODER: "or", OR: "or", NICHT: "not", NOT: "not" };

type Token = { t: "lp"; at: number } | { t: "rp"; at: number } | { t: "and" | "or" | "not"; at: number; word: string } | { t: "term"; at: number; node: TxQueryNode };

class QueryError extends Error {
    constructor(
        message: string,
        readonly at: number,
    ) {
        super(message);
    }
}

/** Matcher for a folded pattern with * and ?: substring, or a regular expression with wildcards. */
function matcher(pattern: string): (s: string) => boolean {
    if (!/[*?]/.test(pattern)) return (s) => s.includes(pattern);
    const source = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
    const re = new RegExp(source, "s");
    return (s) => re.test(s);
}

function textNode(field: TextField | null, raw: string): TxQueryNode {
    const pattern = foldText(raw).trim();
    return { k: "text", field, test: matcher(pattern), testCompact: matcher(pattern.replace(/ /g, "")) };
}

function amountNode(op: Cmp, value: string, at: number): TxQueryNode {
    const cents = parseAmount(value);
    if (cents === null) {
        const hint = parseDateSpec(value) ? ` – für ein Datum: datum${op}${value}` : "";
        throw new QueryError(`„${value}“ ist kein gültiger Betrag${hint}`, at);
    }
    const signed = /^[+\-−–]/.test(value.trim()) || cents < 0;
    return { k: "amount", op, cents: signed ? cents : Math.abs(cents), signed };
}

const CMP_PREFIX = /^(>=|<=|>|<|=)/;

class Lexer {
    private i = 0;
    readonly tokens: Token[] = [];

    constructor(
        private readonly s: string,
        private readonly today: string,
        private readonly rule: boolean,
    ) {}

    run(): Token[] {
        while (this.skipSpace()) {
            const c = this.s[this.i]!;
            const at = this.i;
            if (c === "(" || c === ")") {
                this.tokens.push(c === "(" ? { t: "lp", at } : { t: "rp", at });
                this.i++;
            } else if (c === "-" && this.i + 1 < this.s.length && /[^\s\d-]/.test(this.s[this.i + 1]!)) {
                this.tokens.push({ t: "not", at, word: "-" });
                this.i++;
            } else if (c === '"') {
                this.tokens.push({ t: "term", at, node: textNode(null, this.quoted()) });
            } else {
                this.word(at);
            }
        }
        return this.tokens;
    }

    /** Skips whitespace; false at the end. */
    private skipSpace(): boolean {
        while (this.i < this.s.length && /\s/.test(this.s[this.i]!)) this.i++;
        return this.i < this.s.length;
    }

    /** A quoted value; \" stands for a quote and \\ for a backslash. */
    private quoted(): string {
        const start = this.i;
        let out = "";
        for (let j = start + 1; j < this.s.length; j++) {
            const c = this.s[j]!;
            if (c === "\\" && (this.s[j + 1] === '"' || this.s[j + 1] === "\\")) {
                out += this.s[++j];
            } else if (c === '"') {
                this.i = j + 1;
                return out;
            } else out += c;
        }
        throw new QueryError("Anführungszeichen nicht geschlossen", start);
    }

    private bare(): string {
        const start = this.i;
        while (this.i < this.s.length && !/[\s()"]/.test(this.s[this.i]!)) this.i++;
        return this.s.slice(start, this.i);
    }

    /** The value after a field or comparison sign: right behind it, after spaces, or quoted. */
    private value(rest: string, label: string, at: number): string {
        if (rest) return rest;
        if (this.skipSpace()) {
            const c = this.s[this.i]!;
            if (c === '"') return this.quoted();
            if (c !== "(" && c !== ")") {
                const w = this.bare();
                if (!OPERATORS[w]) return w;
                this.i -= w.length;
            }
        }
        throw new QueryError(`Nach „${label}“ fehlt ein Wert`, at);
    }

    private dateNode(op: Cmp | ":", value: string, at: number): TxQueryNode {
        const spec = parseDateSpec(value, this.today);
        if (!spec) throw new QueryError(`„${value}“ ist kein gültiges Datum (z. B. 2026, 3.2026, 1.3.2026, -30t oder vormonat)`, at);
        if (spec.relative && this.rule) throw new QueryError("Relative Datumsangaben gehen in Regeln nicht, weil sich ihre Bedeutung täglich ändert", at);
        return { k: "date", op, from: spec.from, to: spec.to };
    }

    private word(at: number): void {
        const w = this.bare();
        // A quote right behind the word belongs to it: gegenseite:"rewe markt", >"50"
        const glued = this.s[this.i] === '"' && /(:|[<>=])$/.test(w);
        if (OPERATORS[w] && !glued) {
            this.tokens.push({ t: OPERATORS[w], at, word: w });
            return;
        }
        const cmp = CMP_PREFIX.exec(w);
        if (cmp) {
            const op = cmp[1] as Cmp;
            const value = this.value(glued ? "" : w.slice(op.length), op, at);
            this.tokens.push({ t: "term", at, node: amountNode(op, value, at) });
            return;
        }
        const f = /^([a-zA-ZäöüÄÖÜ]+)(:|>=|<=|>|<|=)(.*)$/.exec(w);
        const field = f ? txQueryField(f[1]!) : undefined;
        if (!f || !field) {
            this.tokens.push({ t: "term", at, node: textNode(null, w) });
            return;
        }
        const name = f[1]!.toLowerCase();
        if (field === "category" && this.rule) throw new QueryError("kategorie: geht in Regeln nicht, weil Regeln nur auf Umsätze ohne Kategorie wirken", at);
        if (field === "flag" && this.rule) throw new QueryError("ist: geht in Regeln nicht, weil „neu“ für jeden Benutzer anders ist", at);
        let op = f[2] as Cmp | ":";
        let rest = glued ? "" : f[3]!;
        // betrag:>50 is the same as betrag>50
        if (op === ":" && (field === "amount" || field === "date")) {
            const inner = CMP_PREFIX.exec(rest);
            if (inner) {
                op = inner[1] as Cmp;
                rest = rest.slice(op.length);
            }
        }
        if (op !== ":" && field !== "amount" && field !== "date") throw new QueryError(`Vergleiche gehen nur bei betrag und datum, nicht bei ${name}`, at);
        const value = this.value(rest, `${name}${op}`, at);
        if (field === "flag") {
            if (!FLAG_VALUES.has(foldText(value).trim())) throw new QueryError(`„${value}“ gibt es bei ist: nicht – möglich ist ist:neu`, at);
            this.tokens.push({ t: "term", at, node: { k: "unread" } });
        } else if (field === "date") this.tokens.push({ t: "term", at, node: this.dateNode(op, value, at) });
        else if (field === "amount" && op !== ":") this.tokens.push({ t: "term", at, node: amountNode(op, value, at) });
        else if (field === "category" && (value.trim() === "-" || foldText(value).trim() === "ohne kategorie")) this.tokens.push({ t: "term", at, node: { k: "nocat" } });
        else this.tokens.push({ t: "term", at, node: textNode(field, value) });
    }
}

class Parser {
    private i = 0;
    private depth = 0;
    terms = 0;
    hasDate = false;

    constructor(
        private readonly tokens: Token[],
        private readonly end: number,
    ) {}

    run(): TxQueryNode | null {
        if (!this.tokens.length) return null;
        const node = this.or();
        const t = this.tokens[this.i];
        if (t) {
            if (t.t === "rp") throw new QueryError("Öffnende Klammer fehlt", t.at);
            throw new QueryError("Unerwartetes Zeichen", t.at);
        }
        return node;
    }

    private peek(): Token | undefined {
        return this.tokens[this.i];
    }

    private or(): TxQueryNode {
        const items = [this.and()];
        while (this.peek()?.t === "or") {
            this.i++;
            items.push(this.and());
        }
        return items.length === 1 ? items[0]! : { k: "or", items };
    }

    private and(): TxQueryNode {
        const items = [this.unary()];
        for (;;) {
            const t = this.peek();
            if (!t || t.t === "or" || t.t === "rp") break;
            if (t.t === "and") this.i++;
            items.push(this.unary());
        }
        return items.length === 1 ? items[0]! : { k: "and", items };
    }

    private unary(): TxQueryNode {
        const t = this.peek();
        if (t?.t === "not") {
            this.i++;
            return { k: "not", item: this.unary() };
        }
        return this.primary();
    }

    private primary(): TxQueryNode {
        const t = this.peek();
        const prev = this.tokens[this.i - 1];
        const after = prev && (prev.t === "and" || prev.t === "or" || prev.t === "not") ? prev : undefined;
        if (!t) {
            if (after) throw new QueryError(`Nach „${after.word}“ fehlt ein Suchbegriff`, after.at);
            throw new QueryError("Suchbegriff fehlt", this.end);
        }
        if (t.t === "term") {
            this.i++;
            if (++this.terms > TXQUERY_MAX_TERMS) throw new QueryError(`Zu viele Suchbegriffe (höchstens ${TXQUERY_MAX_TERMS})`, t.at);
            if (t.node.k === "date") this.hasDate = true;
            return t.node;
        }
        if (t.t === "lp") {
            this.i++;
            if (++this.depth > TXQUERY_MAX_DEPTH) throw new QueryError(`Zu viele verschachtelte Klammern (höchstens ${TXQUERY_MAX_DEPTH})`, t.at);
            if (this.peek()?.t === "rp") throw new QueryError("Leere Klammer", t.at);
            const node = this.or();
            if (this.peek()?.t !== "rp") throw new QueryError("Schließende Klammer fehlt", t.at);
            this.i++;
            this.depth--;
            return node;
        }
        if (t.t === "rp") {
            if (after) throw new QueryError(`Nach „${after.word}“ fehlt ein Suchbegriff`, after.at);
            throw new QueryError("Öffnende Klammer fehlt", t.at);
        }
        // An operator where a term belongs: at the start or twice in a row
        if (after) throw new QueryError(`Nach „${after.word}“ fehlt ein Suchbegriff`, after.at);
        throw new QueryError(`Vor „${t.word}“ fehlt ein Suchbegriff`, t.at);
    }
}

/** Parses a search text; an empty search matches everything (`query: null`), an empty rule is an error. */
export function parseTxQuery(input: string, options: TxQueryOptions = {}): TxQueryResult {
    const rule = options.mode === "rule";
    const what = rule ? "Die Regel" : "Die Suche";
    if (input.length > TXQUERY_MAX_LENGTH) return { ok: false, error: `${what} ist zu lang (höchstens ${TXQUERY_MAX_LENGTH} Zeichen)`, at: TXQUERY_MAX_LENGTH };
    try {
        const tokens = new Lexer(input, options.today ?? todayIso(), rule).run();
        const parser = new Parser(tokens, input.length);
        const query = parser.run();
        if (!query && rule) return { ok: false, error: "Die Regel braucht mindestens einen Suchbegriff", at: 0 };
        return { ok: true, query, hasDate: parser.hasDate };
    } catch (e) {
        if (e instanceof QueryError) return { ok: false, error: e.message, at: e.at };
        throw e;
    }
}
