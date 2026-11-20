import { createRootRoute, createRoute, createRouter } from "@tanstack/react-router";
import { Gate } from "./shell/Gate";
import { OverviewPage } from "./pages/Overview";
import { TransactionsPage } from "./pages/Transactions";
import { SettingsPage } from "./pages/Settings";
import { SETTINGS_TABS, type SettingsTab } from "./lib/settingsTabs";
import { TransferPage } from "./pages/Transfer";
import { OrdersPage } from "./pages/Orders";
import { AccountsPage } from "./pages/Accounts";
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
    validateSearch: (raw: Record<string, unknown>): { tab?: SettingsTab } =>
        SETTINGS_TABS.some((t) => t.id === raw.tab) ? { tab: raw.tab as SettingsTab } : {},
    component: SettingsPage,
});

export const router = createRouter({
    routeTree: root.addChildren([overview, transactionsRoute, accountsPage, transfer, orders, settingsRoute]),
    defaultPreload: false,
    scrollRestoration: true,
});

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
};
