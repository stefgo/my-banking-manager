import { useState, type ReactNode } from "react";
import { isOffline, routes, type Account } from "@mbm/shared";
import { call } from "../lib/api";
import { accountMenu } from "../lib/menus";
import { useAction } from "../lib/queries";
import { useUnreadByAccount } from "../lib/unread";
import { useOpenTransactions } from "../lib/useOpenTransactions";
import { MenuButton, RenameInput, WithContextMenu } from "../shell/Trees";
import { Amt } from "./common";
import { Tile } from "./icons";
import { StylePicker } from "./pickers";

/**
 * An account in Einstellungen → Konten: the symbol opens symbol and colour, the name the
 * transactions, „…“ and right click the menu of the sidebar (renaming happens in the row).
 * `detail` is the line below the name, `actions` the buttons before the menu.
 */
export function AccountRow({ account: a, detail, actions }: { account: Account; detail: ReactNode; actions?: ReactNode }) {
    const action = useAction();
    const open = useOpenTransactions();
    const unread = useUnreadByAccount().get(a.id) ?? 0;
    const [styleOpen, setStyleOpen] = useState(false);
    const [renaming, setRenaming] = useState(false);
    const update = (body: { name?: string; icon?: string; color?: string }) => void action.run(() => call(routes.updateAccount, { params: { id: a.id }, body }), { topics: ["accounts"] });
    const items = accountMenu(a, action, () => setStyleOpen(true), undefined, unread, () => setRenaming(true));
    return (
        <WithContextMenu items={items}>
            <div className="cc-acc">
                <StylePicker
                    open={styleOpen}
                    onOpenChange={setStyleOpen}
                    trigger={
                        <button type="button" className="cc-ic" aria-label={`Symbol und Farbe von „${a.name}“ ändern`} title="Symbol und Farbe ändern" onClick={() => setStyleOpen(true)}>
                            <Tile icon={a.icon} color={a.color} size={15} />
                        </button>
                    }
                    name={a.name}
                    kindName={isOffline(a) ? "Offline-Konto" : "Konto"}
                    icon={a.icon}
                    color={a.color}
                    onChange={(patch) => update({ icon: patch.icon, color: patch.color ?? undefined })}
                />
                {renaming ? (
                    <span className="cc-acc-main">
                        <RenameInput value={a.name} onSave={(name) => update({ name })} onDone={() => setRenaming(false)} />
                        {detail}
                    </span>
                ) : (
                    <button className="cc-link" onClick={() => void open({ kind: "show", search: { scope: `account:${a.id}` } })}>
                        <b>{a.name}</b>
                        {detail}
                    </button>
                )}
                <Amt cents={a.balance} />
                <span className="cc-acc-actions">
                    {actions}
                    <MenuButton items={items} label={`Aktionen für „${a.name}“`} />
                </span>
            </div>
        </WithContextMenu>
    );
}
