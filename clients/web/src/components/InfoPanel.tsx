import { Copy, NotebookPen, NotebookText } from "lucide-react";
import type { Info } from "@mbm/shared";
import { copyText } from "../lib/clipboard";
import { hasInfo } from "../lib/info";
import { Ic } from "./icons";

/** "Infos" in the header of the transaction list: shows and hides the panel below. */
export function InfoToggle({ info, open, onToggle }: { info: Info; open: boolean; onToggle: () => void }) {
    const n = info.attributes.length;
    const note = info.notes.trim() !== "";
    return (
        <button className="btn btn-sm" aria-pressed={open} onClick={onToggle}>
            <Ic icon={NotebookText} size={14} />
            Infos
            {n > 0 && <span className="muted">{n}</span>}
            {note && (
                <>
                    <span className="info-dot" title="Mit Notiz" />
                    <span className="sr-only">, mit Notiz</span>
                </>
            )}
        </button>
    );
}

/** The label/value pairs and the note of an account, a group or a category. */
export function InfoPanel({ info, onEdit }: { info: Info; onEdit: () => void }) {
    if (!hasInfo(info)) {
        return (
            <div className="info-panel info-empty">
                <p className="muted small">Noch keine Infos, etwa Kundennummer, Ansprechpartner oder eine Notiz.</p>
                <button className="btn btn-sm" onClick={onEdit}>
                    <Ic icon={NotebookPen} size={14} />
                    Infos hinzufügen
                </button>
            </div>
        );
    }
    const notes = info.notes.trim();
    return (
        <div className="info-panel">
            <div className={`info-cols ${info.attributes.length && notes ? "two" : ""}`}>
                {info.attributes.length > 0 && (
                    <dl className="d-list info-list">
                        {info.attributes.map((a) => (
                            <div key={a.key}>
                                <dt>{a.key}</dt>
                                <dd>
                                    <span className="info-val">{a.value || <span className="faint">–</span>}</span>
                                    {a.value && (
                                        <button className="copy" aria-label={`${a.key} kopieren`} title="Kopieren" onClick={() => copyText(a.value)}>
                                            <Ic icon={Copy} size={14} />
                                        </button>
                                    )}
                                </dd>
                            </div>
                        ))}
                    </dl>
                )}
                {notes && (
                    <div className="info-note">
                        <span className="label">Notiz</span>
                        <p>{notes}</p>
                    </div>
                )}
            </div>
            <div>
                <button className="btn btn-sm" onClick={onEdit}>
                    <Ic icon={NotebookPen} size={14} />
                    Bearbeiten
                </button>
            </div>
        </div>
    );
}
