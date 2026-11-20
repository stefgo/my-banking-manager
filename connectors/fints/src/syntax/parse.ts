// Reads FinTS messages (Formals H.1). Messages travel in ISO 8859-1, so one byte is one char:
// decoding as latin1 keeps binary data intact and lets us work on a string.

import { FintsSyntaxError, type Component, type Element, type Segment } from "./types.js";

const ESCAPE = "?";
const BINARY = "@";
const COMPONENT_END = ":";
const ELEMENT_END = "+";
const SEGMENT_END = "'";

/** Splits a message (or the content of HNVSD) into segments. */
export function parseSegments(data: Uint8Array | string): Segment[] {
    const s = typeof data === "string" ? data : Buffer.from(data).toString("latin1");
    const segments: Segment[] = [];
    let pos = 0;
    while (pos < s.length) {
        // Line breaks between segments are not part of the syntax, but some servers send them.
        if (s[pos] === "\r" || s[pos] === "\n") {
            pos++;
            continue;
        }
        const start = pos;
        const elements: Element[] = [];
        let element: Component[] = [];
        let text = "";
        let binary: Uint8Array | null = null;
        let ended = false;

        const endComponent = (): void => {
            element.push(binary ?? text);
            text = "";
            binary = null;
        };

        while (pos < s.length) {
            const ch = s[pos]!;
            if (ch === ESCAPE) {
                if (pos + 1 >= s.length) throw new FintsSyntaxError("Escape character at the end of the data", pos);
                text += s[pos + 1];
                pos += 2;
                continue;
            }
            if (ch === BINARY && text === "" && binary === null) {
                const lenEnd = s.indexOf(BINARY, pos + 1);
                const len = lenEnd < 0 ? NaN : Number(s.slice(pos + 1, lenEnd));
                if (!/^\d+$/.test(s.slice(pos + 1, lenEnd)) || !Number.isSafeInteger(len)) {
                    throw new FintsSyntaxError("Invalid length of binary data", pos);
                }
                const from = lenEnd + 1;
                if (from + len > s.length) throw new FintsSyntaxError("Binary data longer than the message", pos);
                binary = Buffer.from(s.slice(from, from + len), "latin1");
                pos = from + len;
                continue;
            }
            if (ch === COMPONENT_END) {
                endComponent();
                pos++;
                continue;
            }
            if (ch === ELEMENT_END) {
                endComponent();
                elements.push(element);
                element = [];
                pos++;
                continue;
            }
            if (ch === SEGMENT_END) {
                endComponent();
                elements.push(element);
                pos++;
                ended = true;
                break;
            }
            if (binary !== null) throw new FintsSyntaxError("Data after binary data", pos);
            text += ch;
            pos++;
        }
        if (!ended) throw new FintsSyntaxError("Segment without end character", start);
        segments.push(toSegment(elements, start));
    }
    return segments;
}

function toSegment(elements: Element[], position: number): Segment {
    const [head, ...rest] = elements;
    const [id, number, version, ref] = (head ?? []).map((c) => (typeof c === "string" ? c : null));
    if (!id || !/^[A-Z][A-Z0-9]{1,5}$/.test(id)) throw new FintsSyntaxError("Invalid segment identifier", position);
    const n = Number(number);
    const v = Number(version);
    if (!/^\d{1,3}$/.test(number ?? "") || !/^\d{1,3}$/.test(version ?? "")) {
        throw new FintsSyntaxError(`Invalid segment header of ${id}`, position);
    }
    const segment: Segment = { id, number: n, version: v, elements: rest };
    if (ref) {
        if (!/^\d{1,3}$/.test(ref)) throw new FintsSyntaxError(`Invalid reference segment in ${id}`, position);
        segment.ref = Number(ref);
    }
    return segment;
}
