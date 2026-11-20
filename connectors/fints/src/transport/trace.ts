// Opt-in structure trace for diagnosing banks (MBM_FINTS_TRACE=1): which segments go back and
// forth, return codes and the shape of the UPD. Never contents: no names, numbers, amounts,
// return code texts or parameters, and nothing of what we send beyond segment ids.

import { parseSegments } from "../syntax/parse.js";
import { bytes, text } from "../syntax/formats.js";
import type { Segment } from "../syntax/types.js";
import type { Transport } from "./http.js";

function segmentsOf(data: Uint8Array): Segment[] {
    const out: Segment[] = [];
    for (const s of parseSegments(data)) {
        const inner = s.id === "HNVSD" ? bytes(s.elements[0]) : null;
        if (inner) out.push(...parseSegments(inner));
        else out.push(s);
    }
    return out;
}

/** Number of allowed business transactions in a HIUPD (elements starting with a segment id). */
const jobsOf = (s: Segment): number => s.elements.slice(8).filter((e) => /^[A-Z]{4,6}$/.test(text(e, 0))).length;

/** One line per message: segment ids with version, then return codes and the UPD's shape. */
export function describe(data: Uint8Array): string {
    let segments: Segment[];
    try {
        segments = segmentsOf(data);
    } catch {
        return "(not parseable)";
    }
    const ids = segments.filter((s) => !["HNHBK", "HNHBS", "HNSHK", "HNSHA", "HNVSK"].includes(s.id)).map((s) => `${s.id}:${s.version}${s.ref ? `>${s.ref}` : ""}`);
    const parts = [ids.join(" ")];
    const codes = segments
        .filter((s) => s.id === "HIRMG" || s.id === "HIRMS")
        .map((s) => `${s.id === "HIRMG" ? "G" : `S${s.ref ?? ""}`}=` + s.elements.map((e) => text(e, 0)).join(","));
    if (codes.length) parts.push(`codes ${codes.join(" ")}`);
    const hiupa = segments.find((s) => s.id === "HIUPA");
    if (hiupa) {
        const hiupd = segments.filter((s) => s.id === "HIUPD");
        const shape = hiupd.map((s) => `v${s.version}[${text(s.elements[0], 0) ? "Nr" : "-"}${text(s.elements[1]) ? "+IBAN" : ""}${jobsOf(s) ? `+${jobsOf(s)}GV` : ""}]`);
        parts.push(`UPD version ${text(hiupa.elements[1])}, usage ${text(hiupa.elements[2])}, ${hiupd.length} HIUPD ${shape.join(" ")}`);
    }
    return parts.join(" | ");
}

export function traced(inner: Transport, log: (line: string) => void = (l) => console.error(l)): Transport {
    let n = 0;
    return {
        async send(message) {
            const i = ++n;
            log(`[fints-trace] ${i} → ${describe(message)}`);
            const answer = await inner.send(message);
            log(`[fints-trace] ${i} ← ${describe(answer)}`);
            return answer;
        },
    };
}
