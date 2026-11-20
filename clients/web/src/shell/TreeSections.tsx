// The account and category trees with their heads and add buttons; in the sidebar and on the page
// "Konten" of the phone layout.

import { useState } from "react";
import { Check, Pencil, Plus } from "lucide-react";
import { useAccounts, useAction, useCategoryIndex, useGroups } from "../lib/queries";
import { accountTree } from "../lib/tree";
import type { TxSearch } from "../lib/search";
import { createCategoryAndRename, createGroupAndRename } from "../lib/treeCreate";
import { useTreeKeys } from "../lib/treeKeys";
import { ui, useUi } from "../lib/ui";
import { Ic } from "../components/icons";
import { AccountTreeRows, CategoryTreeRows } from "./Trees";

function EditToggle({ on, label, onToggle }: { on: boolean; label: string; onToggle: () => void }) {
    return (
        <button className="mini" aria-pressed={on} onClick={onToggle} aria-label={label} title={on ? "Fertig" : label}>
            <Ic icon={on ? Check : Pencil} size={15} />
        </button>
    );
}

export function AccountsSection({ search, title = "Konten" }: { search: TxSearch; title?: string }) {
    const editing = useUi((s) => s.editing.acc);
    const action = useAction();
    const groups = useGroups().data ?? [];
    const accounts = useAccounts().data ?? [];
    const keys = useTreeKeys("Konten");
    return (
        <div className="sb-sec">
            <div className="sb-head">
                <span className="sb-title">{title}</span>
                <EditToggle on={editing} label="Konten und Gruppen bearbeiten" onToggle={() => ui.setEditing("acc", !editing)} />
            </div>
            <div className="tree" {...keys}>
                <AccountTreeRows nodes={accountTree(groups, accounts)} depth={0} groups={groups} accounts={accounts} search={search} />
                {!accounts.length && !groups.length && <p className="tree-empty">Noch keine Konten</p>}
            </div>
            {editing && (
                <>
                    <button className="btn btn-sm btn-ghost" style={{ justifySelf: "start" }} onClick={() => ui.open({ kind: "addAccount" })}>
                        <Ic icon={Plus} size={14} />
                        Neues Konto
                    </button>
                    <button className="btn btn-sm btn-ghost" style={{ justifySelf: "start" }} onClick={() => void createGroupAndRename(action, null)}>
                        <Ic icon={Plus} size={14} />
                        Neue Gruppe
                    </button>
                </>
            )}
        </div>
    );
}

export function CategoriesSection({ search, title = "Kategorien" }: { search: TxSearch; title?: string }) {
    const editing = useUi((s) => s.editing.cat);
    const action = useAction();
    const { index } = useCategoryIndex();
    const [, force] = useState(0);
    const keys = useTreeKeys("Kategorien");
    return (
        <div className="sb-sec">
            <div className="sb-head">
                <span className="sb-title">{title}</span>
                <EditToggle on={editing} label="Kategorien bearbeiten" onToggle={() => ui.setEditing("cat", !editing)} />
            </div>
            <div className="tree" {...keys}>
                <CategoryTreeRows index={index} search={search} onChange={() => force((n) => n + 1)} />
            </div>
            {editing && (
                <button className="btn btn-sm btn-ghost" style={{ justifySelf: "start" }} onClick={() => void createCategoryAndRename(action, null)}>
                    <Ic icon={Plus} size={14} />
                    Neue Kategorie
                </button>
            )}
        </div>
    );
}
