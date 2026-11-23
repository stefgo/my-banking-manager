import { createRootRoute, createRoute, createRouter } from "@tanstack/react-router";
import { Gate } from "./shell/Gate";
import { OverviewPage } from "./pages/Overview";
import { TransactionsPage } from "./pages/Transactions";
import { SettingsPage } from "./pages/Settings";
import { SETTINGS_TABS, type SettingsTab } from "./lib/settingsTabs";
import { TransferPage } from "./pages/Transfer";
import { OrdersPage } from "./pages/Orders";
import { AccountsPage } from "./pages/Accounts";
import { ImportPage } from "./pages/Import";
import { ImportFormatPage } from "./pages/ImportFormat";
import { RunRulesPage } from "./pages/RunRules";
import { registerImportNavigation } from "./lib/importNav";
import { registerRuleNavigation } from "./lib/rules";
import { compactTxSearch, parseTxSearch } from "./lib/search";

const root = createRootRoute({ component: Gate });

const overview = createRoute({ getParentRoute: () => root, path: "/", component: OverviewPage });

export const transactionsRoute = createRoute({
    getParentRoute: () => root,
    path: "/transactions",
    validateSearch: (raw: Record<string, unknown>) => compactTxSearch(parseTxSearch(raw)),
    component: TransactionsPage,
});

const accountsPage = createRoute({ getParentRoute: () => root, path: "/accounts", component: AccountsPage });
const transfer = createRoute({ getParentRoute: () => root, path: "/transfer", component: TransferPage });
const orders = createRoute({ getParentRoute: () => root, path: "/orders", component: OrdersPage });

export const settingsRoute = createRoute({
    getParentRoute: () => root,
    path: "/settings",
    // `new`: the form for a new rule is open
    validateSearch: (raw: Record<string, unknown>): { tab?: SettingsTab; new?: true } => {
        if (!SETTINGS_TABS.some((t) => t.id === raw.tab)) return {};
        const tab = raw.tab as SettingsTab;
        return tab === "rules" && raw.new === true ? { tab, new: true } : { tab };
    },
    component: SettingsPage,
});

export const importRoute = createRoute({
    getParentRoute: () => root,
    path: "/import",
    validateSearch: (raw: Record<string, unknown>): { account?: number } => (Number.isSafeInteger(raw.account) && (raw.account as number) > 0 ? { account: raw.account as number } : {}),
    component: ImportPage,
});

export const importFormatRoute = createRoute({
    getParentRoute: () => root,
    path: "/import-format",
    // "new", or the key of a format ("builtin:…", "custom:<id>")
    validateSearch: (raw: Record<string, unknown>): { key: string } => ({ key: typeof raw.key === "string" && raw.key.length <= 80 ? raw.key : "new" }),
    component: ImportFormatPage,
});

export const runRulesRoute = createRoute({
    getParentRoute: () => root,
    path: "/rules/run",
    validateSearch: (raw: Record<string, unknown>): { rule?: number } => (Number.isSafeInteger(raw.rule) && (raw.rule as number) > 0 ? { rule: raw.rule as number } : {}),
    component: RunRulesPage,
});

export const router = createRouter({
    routeTree: root.addChildren([overview, transactionsRoute, accountsPage, transfer, orders, settingsRoute, importRoute, importFormatRoute, runRulesRoute]),
    defaultPreload: false,
    scrollRestoration: true,
});

registerImportNavigation((accountId) => void router.navigate({ to: "/import", search: accountId === undefined ? {} : { account: accountId } }));

registerRuleNavigation(
    (ruleId) => void router.navigate({ to: "/rules/run", search: ruleId === undefined ? {} : { rule: ruleId } }),
    () => void router.navigate({ to: "/settings", search: { tab: "rules" } }),
);

declare module "@tanstack/react-router" {
    interface Register {
        router: typeof router;
    }
}

export const ROUTE_TITLES: Record<string, string> = {
    "/": "Übersicht",
    "/transactions": "Umsätze",
    "/accounts": "Konten",
    "/transfer": "Überweisen",
    "/orders": "Aufträge",
    "/settings": "Einstellungen",
    "/import": "Importieren",
    "/import-format": "Importformat",
    "/rules/run": "Regeln ausführen",
};
