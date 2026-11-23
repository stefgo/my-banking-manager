import { ChevronRight } from "lucide-react";
import type { Rule, RuleEdit } from "@mbm/shared";
import { useAccounts, useCategoryIndex } from "../lib/queries";
import { categoryPath } from "../lib/tree";
import { CatTile, Ic } from "./icons";

const FIELD_NAME: Record<RuleEdit["field"], string> = { counterparty: "Gegenseite", remittance: "Zweck" };

const editText = (e: RuleEdit): string => {
    if (e.op === "set") return `${FIELD_NAME[e.field]}: ${e.value}`;
    if (e.op === "remove") return `${FIELD_NAME[e.field]}: „${e.text}“ entfernen`;
    return `${FIELD_NAME[e.field]}: „${e.text}“ → „${e.with}“`;
};

/** What a rule does: its name, accounts, condition and actions. */
export function RuleSummary({ rule }: { rule: Rule }) {
    const { index: cats } = useCategoryIndex();
    const accounts = useAccounts().data ?? [];
    const accountText = rule.accountIds === null ? "" : rule.accountIds.length === 0 ? "Konto fehlt" : rule.accountIds.map((id) => accounts.find((a) => a.id === id)?.name ?? "Konto").join(", ");
    return (
        <span className="r-txt">
            {rule.name && <b className="r-name">{rule.name}</b>}
            {accountText && <span className={`pill ${rule.accountIds?.length === 0 ? "warn" : ""}`}>{accountText}</span>}
            Wenn <code>{rule.query}</code>
            <Ic icon={ChevronRight} size={14} />
            {rule.edits.map((e, i) => <span key={i} className="r-edit">{editText(e)}</span>)}
            {rule.categoryId !== null && (
                <span className="cchip">
                    <CatTile idx={cats} id={rule.categoryId} size={11} className="ti-s" />
                    {categoryPath(cats, rule.categoryId)}
                </span>
            )}
        </span>
    );
}
