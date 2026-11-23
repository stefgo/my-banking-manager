import { describe, expect, it } from "vitest";
import { compileRules, evaluateRules, ruleIssues, type RuleBooking, type RuleDefinition } from "./ruleEngine.js";
import type { RuleEdit, RuleExtract } from "./schemas/banking.js";
import { matchTxQuery, parseTxQuery, toTxQueryTarget } from "./txquery.js";

const booking = (over: Partial<Omit<RuleBooking, "target">> = {}): RuleBooking => {
    const b = { accountId: 1, counterpartyName: "PayPal Europe", ultimateParty: "", remittance: "Ihr Einkauf bei SPOTIFY", bookingText: "Lastschrift", reference: "", mandateId: "", creditorId: "", ...over };
    return {
        ...b,
        target: toTxQueryTarget({ counterparty: b.counterpartyName, ultimateParty: b.ultimateParty, remittance: b.remittance, iban: null, amount: -999, category: "", categoryPath: [], uncategorized: true, accountPath: ["Giro"], accountIban: null, bookingDate: "2026-11-01" }),
    };
};
let nextId = 1;
const rule = (query: string, over: Partial<RuleDefinition> = {}): RuleDefinition => ({ id: nextId++, query, categoryId: 7, accountIds: null, extracts: [], edits: [], ...over });
const pattern = (p: string, id = "s1"): RuleExtract => ({ id, input: { field: "remittance" }, type: "pattern", pattern: p });
const setParty = (value: string): RuleEdit => ({ op: "set", field: "counterparty", value });
const first = (rules: RuleDefinition[], b = booking()) => evaluateRules(compileRules(rules), b);

describe("evaluateRules", () => {
    it("stops at the first rule that hits", () => {
        const a = rule("gegenseite:paypal");
        expect(first([a, rule("zweck:spotify", { categoryId: 9 })])).toMatchObject({ rule: a, categoryId: 7 });
    });

    it("goes on when a value the actions need is missing", () => {
        const miss = rule("gegenseite:paypal", { extracts: [pattern("Rechnung {nr:zahl}")], edits: [{ op: "set", field: "remittance", value: "Rechnung {nr}" }] });
        const next = rule("zweck:spotify", { categoryId: 9 });
        expect(first([miss, next])).toMatchObject({ rule: next, categoryId: 9 });
    });

    it("runs a rule's actions in order from the bank's value", () => {
        const r = first([
            rule("zweck:einkauf", {
                extracts: [pattern("Einkauf bei {h}")],
                edits: [setParty("{h:titel}"), { op: "remove", field: "remittance", text: "ihr " }, { op: "replace", field: "remittance", text: "einkauf", with: "Kauf" }],
            }),
        ]);
        expect(r).toMatchObject({ counterparty: "Spotify", remittance: "Kauf bei SPOTIFY", values: { h: "SPOTIFY" } });
    });

    it("skips a step that would leave nothing and stores no result equal to the bank's", () => {
        expect(first([rule("zweck:einkauf", { edits: [{ op: "remove", field: "remittance", text: "Ihr Einkauf bei SPOTIFY" }] })])?.remittance).toBeNull();
        expect(first([rule("gegenseite:paypal", { edits: [setParty("PayPal Europe")] })])?.counterparty).toBeNull();
    });

    it("respects the chosen accounts", () => {
        const only = rule("gegenseite:paypal", { accountIds: [2] });
        expect(first([only])).toBeNull();
        expect(first([only], booking({ accountId: 2 }))).not.toBeNull();
        expect(first([rule("gegenseite:paypal", { accountIds: [] })])).toBeNull();
    });

    it("reads the shop as the counterparty and treats foreign text as text", () => {
        expect(first([rule("gegenseite:rewe", { edits: [setParty("{gegenseite:klein}")] })], booking({ ultimateParty: "REWE", counterpartyName: "Bank" }))?.counterparty).toBe("rewe");
        const evil = booking({ remittance: "Ihr Einkauf bei {zweck}" });
        expect(first([rule("zweck:einkauf", { extracts: [pattern("bei {h}")], edits: [setParty("{h}")] })], evil)?.counterparty).toBe("{zweck}");
    });

    it("splits by separators and keywords like the import", () => {
        const sep: RuleExtract = { id: "s", input: { field: "remittance" }, type: "separator", separator: "//", parts: ["a", "b"] };
        expect(first([rule("zweck:x", { extracts: [sep], edits: [setParty("{b}")] })], booking({ remittance: "x // y" }))?.counterparty).toBe("y");
        expect(first([rule("zweck:x", { extracts: [sep], edits: [setParty("{b}")] })], booking({ remittance: "x" }))).toBeNull();
        const words: RuleExtract = { id: "k", input: { field: "remittance" }, type: "keywords", prefix: "", suffix: ":", keywords: [{ text: "Ref", part: "ref" }] };
        expect(first([rule("zweck:ref", { extracts: [words], edits: [setParty("{ref}")] })], booking({ remittance: "Kauf Ref: 42" }))?.counterparty).toBe("42");
    });

    it("reads a later step from the rest of an earlier one", () => {
        const steps: RuleExtract[] = [pattern("Ihr {a:wort}"), { id: "s2", input: { step: "s1", part: "rest" }, type: "pattern", pattern: "bei {b}" }];
        expect(first([rule("zweck:einkauf", { extracts: steps, edits: [setParty("{b}")] })])?.counterparty).toBe("SPOTIFY");
    });
});

describe("ruleIssues", () => {
    it("names what is wrong", () => {
        const issues = (extracts: RuleExtract[], edits: RuleEdit[], categoryId: number | null = 1) => ruleIssues({ categoryId, extracts, edits });
        expect(issues([], [], null)).toHaveLength(1);
        expect(issues([pattern("a {zweck}")], [])[0]).toContain("reserviert");
        expect(issues([pattern("a {x}"), pattern("b {x}", "s2")], [])[0]).toContain("gibt es schon");
        expect(issues([], [setParty("{fehlt}")])[0]).toContain("gibt es nicht");
        expect(issues([pattern("a {x}")], [setParty("{rest}")])[0]).toContain("Rest");
        expect(issues([pattern("a {x}")], [setParty("{x:titel} {zweck}")])).toEqual([]);
    });
});

describe("wildcards without regular expressions", () => {
    const old = (pattern: string, s: string) => new RegExp(pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, "."), "s").test(s);
    const target = (remittance: string) => toTxQueryTarget({ counterparty: "x", remittance, iban: null, amount: 1, category: "", categoryPath: [], uncategorized: true, accountPath: [], accountIban: null, bookingDate: "2026-01-01" });

    it("finds the same as before", () => {
        const texts = ["", "a", "ab", "aab", "abcabc", "a.b", "xaybz", "aaaa", "b a"];
        const patterns = ["a*b", "*a", "a*", "a?b", "?", "??", "a*?c", "*", "a.b", "a*b*c", "b?a", "?*?", "x*y*z"];
        for (const p of patterns) {
            const parsed = parseTxQuery(`zweck:"${p}"`, { mode: "rule" });
            if (!parsed.ok) throw new Error(parsed.error);
            for (const t of texts) expect(matchTxQuery(parsed.query, target(t)), `${p} / ${t}`).toBe(old(p, t));
        }
    });

    it("stays fast on patterns a regular expression stalls on", () => {
        const parsed = parseTxQuery(`zweck:"${"*a".repeat(20)}*b"`, { mode: "rule" });
        if (!parsed.ok) throw new Error(parsed.error);
        const start = performance.now();
        expect(matchTxQuery(parsed.query, target("a".repeat(20_000)))).toBe(false);
        expect(performance.now() - start).toBeLessThan(200);
    });
});
