import { useMemo } from "react";
import { useLocalSetting } from "./localSettings";
import { useAccounts, useCategoryIndex, useGroups } from "./queries";
import { txHome, type TxSearch } from "./search";

/** The search "Umsätze" in the navigation opens: the last view shown, or the hint to pick one. */
export function useTxHome(): Partial<TxSearch> {
    const last = useLocalSetting("lastTxView");
    const kept = useLocalSetting("txFilters");
    const accounts = useAccounts().data;
    const groups = useGroups().data;
    const { data: categories, index } = useCategoryIndex();
    return useMemo(
        () =>
            txHome(
                last,
                {
                    accounts: accounts && new Set(accounts.map((a) => a.id)),
                    groups: groups && new Set(groups.map((g) => g.id)),
                    categories: categories && new Set(index.byId.keys()),
                },
                kept,
            ),
        [last, kept, accounts, groups, categories, index],
    );
}
