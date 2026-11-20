// Writes FinTS segments (Formals H.1): escapes syntax characters, writes binary data as
// @len@…, and cuts off empty trailing components and elements (H.1.5).

import { FintsSyntaxError, type ComponentInput, type ElementInput, type Segment } from "./types.js";

const SYNTAX_CHARS = /[?@:+']/g;

/** One segment as latin1 text, including the end character. */
export function serializeSegment(segment: Segment | (Omit<Segment, "elements"> & { elements: ElementInput[] })): string {
    const head = [segment.id, String(segment.number), String(segment.version)];
    if (segment.ref !== undefined) head.push(String(segment.ref));
    const elements = segment.elements.map(serializeElement);
    while (elements.length > 0 && elements[elements.length - 1] === "") elements.pop();
    return [head.join(":"), ...elements].join("+") + "'";
}

function serializeElement(element: ElementInput): string {
    const components = Array.isArray(element) ? element.map(serializeComponent) : [serializeComponent(element)];
    while (components.length > 0 && components[components.length - 1] === "") components.pop();
    return components.join(":");
}

function serializeComponent(c: ComponentInput): string {
    if (c === null || c === undefined) return "";
    if (c instanceof Uint8Array) return `@${c.length}@${Buffer.from(c).toString("latin1")}`;
    const text = typeof c === "number" ? String(c) : c.trim();
    // eslint-disable-next-line no-control-regex
    if (/[^\x00-\xff]/.test(text)) throw new FintsSyntaxError("Text outside ISO 8859-1");
    return text.replace(SYNTAX_CHARS, "?$&");
}

/** Text to bytes as sent over the wire (ISO 8859-1). */
export const toWire = (text: string): Buffer => Buffer.from(text, "latin1");
