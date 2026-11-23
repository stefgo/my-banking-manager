import type { RuleFieldChange, RuleRunItem } from "@mbm/shared";
import { describe, expect, it } from "vitest";
import { carryChoice, deviationsOf, itemKind, rowCheck, runCounts, runOutcome, setChosen, toggleRow, toggleShown } from "./ruleRun";

const change = (field: RuleFieldChange["field"], kind: RuleFieldChange["kind"], selected = kind !== "replace"): RuleFieldChange => ({ field, kind, before: "a", after: "b", selected });
const item = (key: string, ...changes: RuleFieldChange[]): RuleRunItem => ({ key, transactionId: 1, accountId: 1, bookingDate: "2026-01-01", amount: -1, counterparty: "x", remittance: "y", manual: false, split: false, ruleId: 1, changes });

describe("the choice of a rule run", () => {
    const mixed = item("t:1", change("counterparty", "fill"), change("category", "replace"));

    it("counts a row under its weightiest change", () => {
        expect(itemKind(mixed)).toBe("replace");
        expect(runCounts([mixed, item("t:2", change("remittance", "reset"))])).toEqual({ all: 2, fill: 0, change: 0, replace: 1, reset: 1 });
    });

    it("starts with the preview's choice and sends only what differs", () => {
        expect(rowCheck(mixed, new Map())).toBe("partial");
        expect(deviationsOf([mixed], new Map())).toEqual([]);
        const all = toggleRow(mixed, new Map());
        expect(rowCheck(mixed, all)).toBe("on");
        expect(deviationsOf([mixed], all)).toEqual([{ key: "t:1", field: "category", selected: true }]);
    });

    it("selects and clears everything shown", () => {
        const rows = [mixed, item("t:2", change("remittance", "fill"))];
        const on = toggleShown(rows, new Map());
        expect(rows.map((r) => rowCheck(r, on))).toEqual(["on", "on"]);
        const off = toggleShown(rows, on);
        expect(rows.map((r) => rowCheck(r, off))).toEqual(["off", "off"]);
        expect(runOutcome(rows, off)).toMatchObject({ chosen: 0, left: 2 });
    });

    it("sums up the chosen replacements", () => {
        const on = setChosen([mixed], true, new Map(), "category");
        expect(runOutcome([mixed], on)).toEqual({ chosen: 1, left: 0, replaces: 1, byKind: { fill: 0, change: 0, replace: 1, reset: 0 } });
    });

    it("keeps the choice of unchanged rows after a new check", () => {
        const other = item("t:2", change("category", "replace"));
        const choice = setChosen([mixed, other], true, new Map(), "category");
        const moved = item("t:2", { ...change("category", "replace"), after: "c" });
        const next = carryChoice([mixed, other], [mixed, moved], choice);
        expect(rowCheck(mixed, next)).toBe("on");
        expect(rowCheck(moved, next)).toBe("off");
    });
});
