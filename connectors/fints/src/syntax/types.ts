// FinTS 3.0 delimiter syntax (Formals, chapter H.1).
//
// The syntax knows no types: a data element group (DEG) is just several components separated
// by ':', and a DEG nested in a DEG is flattened into the same list. So every element is a list
// of components; a plain data element (DE) has exactly one. Which component means what is up
// to the segment definitions (src/segments).

/** One component: text (already unescaped) or binary data (@len@…). */
export type Component = string | Uint8Array;

/** One data element or data element group, between two '+'. Never empty: an omitted DE is [""]. */
export type Element = Component[];

export interface Segment {
    /** Segment identifier, e.g. "HKIDN". */
    id: string;
    /** Number within the message, starting with 1 at the message header. */
    number: number;
    version: number;
    /** Reference segment: the customer segment a bank segment answers. */
    ref?: number;
    /** The elements after the segment header. */
    elements: Element[];
}

/** A segment to send; the message assigns the number. */
export interface SegmentInput {
    id: string;
    version: number;
    elements: ElementInput[];
}

/** What a builder may pass for one element: absent, one value, or the components of a DEG. */
export type ElementInput = ComponentInput | ComponentInput[];
export type ComponentInput = string | number | Uint8Array | null | undefined;

export class FintsSyntaxError extends Error {
    constructor(message: string, readonly position?: number) {
        super(position === undefined ? message : `${message} (position ${position})`);
        this.name = "FintsSyntaxError";
    }
}
