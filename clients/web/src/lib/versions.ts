// Versions of all modules of the installation, for „Einstellungen → Versionen“.

import { useQuery } from "@tanstack/react-query";
import { routes, type VersionsResponse } from "@mbm/shared";
import { call } from "./api";
import { isOutdated, OWN_BUILD } from "./build";

/** Asked anew each time the tab opens: the server asks the connectors then. */
export const useVersions = () => useQuery({ queryKey: ["versions"], queryFn: () => call(routes.versions), staleTime: 0 });

/** The connectors MBM knows, in this order; one that is not configured is shown as such. */
export const CONNECTORS = [
    { name: "fints", label: "FinTS-Konnektor" },
    { name: "enablebanking", label: "Enable-Banking-Konnektor" },
] as const;

export type ModuleTone = "ok" | "attn" | "off";

export interface ModuleRow {
    key: string;
    label: string;
    /** Version, or what stands in its place ("nicht erreichbar"). */
    state: string;
    details: string[];
    tone: ModuleTone;
    /** The web client in this window is older than the one the server delivers. */
    outdated?: boolean;
}

/** One row per module: server, web client and the known connectors. */
export function moduleRows(v: VersionsResponse, ownBuild: string | null = OWN_BUILD): ModuleRow[] {
    const outdated = isOutdated(ownBuild, v.webBuild);
    const web: ModuleRow = {
        key: "web",
        label: "Web-Client",
        state: outdated ? "veraltet" : v.server,
        details: v.webBuild
            ? [`Build ${ownBuild ?? v.webBuild}`, outdated ? `Der Server liefert Build ${v.webBuild}` : "vom Server ausgeliefert"]
            : ["Nicht vom Server ausgeliefert (Entwicklung)"],
        tone: outdated ? "attn" : "ok",
        outdated,
    };
    const connectors = CONNECTORS.map(({ name, label }): ModuleRow => {
        const c = v.connectors.find((x) => x.name === name);
        if (!c) return { key: name, label, state: "nicht eingerichtet", details: [], tone: "off" };
        const mode = c.embedded ? "Im Server eingebettet" : "Eigener Dienst";
        if (!c.reachable) return { key: name, label, state: "nicht erreichbar", details: [mode, "Abrufe sind erst möglich, wenn er antwortet."], tone: "attn" };
        const product = name === "fints" && !c.productConfigured ? ["Keine Produkt-ID eingetragen (MBM_FINTS_PRODUCT_ID)"] : [];
        return { key: name, label, state: c.version ?? "–", details: [mode, ...product], tone: product.length ? "attn" : "ok" };
    });
    return [{ key: "server", label: "My Banking Manager", state: v.server, details: ["Server"], tone: "ok" }, web, ...connectors];
}

/** Runtime and database below the modules. */
export function runtimeRows(v: VersionsResponse): { label: string; value: string }[] {
    return [
        { label: "Node.js", value: v.node },
        { label: "SQLite", value: v.sqlite },
        { label: "SQLite3 Multiple Ciphers", value: v.sqliteCiphers },
        { label: "Datenbankschema", value: v.schema ?? "–" },
    ];
}

/** All versions as plain text, e.g. for an error report. Holds no bank or personal data. */
export function versionsText(v: VersionsResponse, ownBuild: string | null = OWN_BUILD): string {
    const modules = moduleRows(v, ownBuild).map((r) => [`${r.label}: ${r.state}`, ...r.details].join(" · "));
    const runtime = runtimeRows(v).map((r) => `${r.label}: ${r.value}`);
    return [...modules, ...runtime].join("\n");
}
