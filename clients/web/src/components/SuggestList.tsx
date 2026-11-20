import type { SuggestList as List } from "../lib/useSuggest";

/** The suggestions below a search or rule field; the field keeps the focus. */
export function SuggestList({ list }: { list: List | null }) {
    if (!list) return null;
    return (
        <div className="suggest" role="listbox" id={list.id} aria-label="Vorschläge">
            {list.items.map((s, i) => (
                <div
                    key={s.label}
                    id={`${list.id}-${i}`}
                    role="option"
                    aria-selected={i === list.active}
                    className={`pop-item ${i === list.active ? "on" : ""}`}
                    // Keep the focus in the field
                    onMouseDown={(e) => {
                        e.preventDefault();
                        list.take(i);
                    }}
                >
                    {/* Field names in the font of the search syntax, names as they are */}
                    <span className={s.label.endsWith(":") ? "mono" : undefined}>{s.label}</span>
                    {s.hint && <small>{s.hint}</small>}
                </div>
            ))}
            <div className="suggest-foot">
                <span className="kbd">Tab</span> übernehmen · <span className="kbd">Esc</span> schließen
            </div>
        </div>
    );
}
