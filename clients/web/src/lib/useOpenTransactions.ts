import { useNavigate } from "@tanstack/react-router";
import { readLocalSetting } from "./localSettings";
import { txEntry, type TxEntry } from "./search";
import { ui } from "./ui";

/** Opens the transaction list; search and filters follow the kind of entry (see `txEntry`). */
export function useOpenTransactions() {
    const navigate = useNavigate();
    return (entry: TxEntry): Promise<void> => {
        const { search, q } = txEntry(entry, readLocalSetting("txFilters"));
        if (q !== undefined) ui.setSearch(q);
        return navigate({ to: "/transactions", search });
    };
}
