import { RefreshCw } from "lucide-react";
import { moduleRows, runtimeRows, useVersions, type ModuleTone } from "../../lib/versions";
import { SkeletonRows } from "../../components/Skeleton";
import { Ic } from "../../components/icons";

const DOT: Record<ModuleTone, string> = { ok: "dot", attn: "dot attn", off: "dot off" };

/** Versions of all modules of this installation, with the state of the connectors. */
export function VersionsTab() {
    const versions = useVersions();
    const v = versions.data;
    if (!v) {
        return (
            <section className="panel">
                <SkeletonRows rows={4} plain />
            </section>
        );
    }
    return (
        <>
            <section className="panel" aria-label="Module">
                <div className="panel-head">
                    <h3>Module</h3>
                </div>
                <div className="fs-list fs-status">
                    {moduleRows(v).map((r) => (
                        <div className="fs-row" key={r.key}>
                            <span className={DOT[r.tone]} />
                            <span className="fs-main">
                                <b>{r.label}</b>
                                {r.details.length > 0 && <small>{r.details.join(" · ")}</small>}
                            </span>
                            <span className={r.tone === "attn" ? "fs-state attn" : "fs-state"}>{r.state}</span>
                            {r.outdated ? (
                                <button type="button" className="mini" aria-label="Neu laden" title="Neu laden" onClick={() => location.reload()}>
                                    <Ic icon={RefreshCw} size={15} />
                                </button>
                            ) : (
                                <span />
                            )}
                        </div>
                    ))}
                </div>
            </section>
            <section className="panel" aria-label="Laufzeit">
                <div className="panel-head">
                    <h3>Laufzeit</h3>
                </div>
                <div className="row-list">
                    {runtimeRows(v).map((r) => (
                        <div className="row-item" key={r.label}>
                            <b>{r.label}</b>
                            <span className="fs-state">{r.value}</span>
                        </div>
                    ))}
                </div>
            </section>
        </>
    );
}
