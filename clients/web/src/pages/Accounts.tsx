import { useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { DEFAULT_TX_SEARCH } from "../lib/search";
import { useTxHome } from "../lib/useTxHome";
import { NARROW_QUERY, useMedia } from "../lib/media";
import { ui } from "../lib/ui";
import { Ic } from "../components/icons";
import { AccountsSection, CategoriesSection } from "../shell/TreeSections";

/**
 * Accounts and categories on the phone, where the sidebar is hidden. Wider, the sidebar shows the
 * trees, so the page leads to the transactions.
 */
export function AccountsPage() {
    const narrow = useMedia(NARROW_QUERY);
    const navigate = useNavigate();
    const [view, setView] = useState<"acc" | "cat">("acc");
    const home = useTxHome();
    useEffect(() => {
        if (!narrow) void navigate({ to: "/transactions", search: home, replace: true });
    }, [narrow, navigate, home]);
    return (
        <>
            <div className="page-head">
                <div>
                    <h1>Konten</h1>
                    <p className="muted">Tippen öffnet die Umsätze, langes Drücken das Menü</p>
                </div>
                <div className="head-actions">
                    <button className="btn" onClick={() => ui.open({ kind: "addAccount" })}>
                        <Ic icon={Plus} size={16} />
                        Konto hinzufügen
                    </button>
                </div>
            </div>
            <div className="seg" role="group" aria-label="Ansicht" style={{ justifySelf: "start" }}>
                <button aria-pressed={view === "acc"} onClick={() => setView("acc")}>Konten</button>
                <button aria-pressed={view === "cat"} onClick={() => setView("cat")}>Kategorien</button>
            </div>
            <section className="panel trees-panel">
                {view === "acc" ? <AccountsSection search={DEFAULT_TX_SEARCH} title="Konten und Gruppen" /> : <CategoriesSection search={DEFAULT_TX_SEARCH} />}
            </section>
        </>
    );
}
