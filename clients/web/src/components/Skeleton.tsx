// Grey placeholders while a list or card loads for the first time; refetches keep the old data.

/** Rows like bookings (symbol, two lines, amount) or plain rows (two lines). */
export function SkeletonRows({ rows = 6, plain = false }: { rows?: number; plain?: boolean }) {
    return (
        <div className="skel-list" aria-busy="true" aria-label="Wird geladen">
            {Array.from({ length: rows }, (_, i) => (
                <div key={i} className={`skel-row ${plain ? "plain" : ""}`}>
                    {!plain && <span className="skel skel-av" />}
                    <span className="skel-lines">
                        <span className="skel" style={{ width: `${48 + ((i * 17) % 30)}%` }} />
                        <span className="skel skel-sm" style={{ width: `${28 + ((i * 11) % 22)}%` }} />
                    </span>
                    {!plain && <span className="skel skel-amt" />}
                </div>
            ))}
        </div>
    );
}

/** A card of the overview while the profile loads. */
export function SkeletonCard({ tall = false }: { tall?: boolean }) {
    return (
        <section className={`panel skel-card ${tall ? "tall" : ""}`} aria-busy="true" aria-label="Wird geladen">
            <span className="skel" style={{ width: "34%" }} />
            <span className="skel skel-big" style={{ width: "52%" }} />
            <span className="skel skel-sm" style={{ width: "70%" }} />
        </section>
    );
}
