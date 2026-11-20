// The bank's explanation of the verification of payee may carry a little markup (Messages – VoP,
// Data Dictionary „Aufklärungstext“): paragraphs, line breaks, bold, italic, underline, lists and
// links. It is turned into a tree here and rendered by <BankText> as React elements, never as HTML.

export type BankTag = "p" | "br" | "b" | "i" | "u" | "ul" | "ol" | "li" | "a";
export type BankNode = string | { tag: BankTag; children: BankNode[] };

const TAG = /<(\/?)(p|br|b|i|u|ul|ol|li|a)\b[^>]*>/gi;

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'" };
const decode = (s: string): string => s.replace(/&(amp|lt|gt|quot|apos|nbsp|#39);/g, (_, e: string) => ENTITIES[e]!);

/** The text as a tree; unknown tags stay text, unclosed ones end with the text. */
export function parseBankText(src: string): BankNode[] {
    const root: { tag: "root"; children: BankNode[] } = { tag: "root", children: [] };
    const stack: { tag: string; children: BankNode[] }[] = [root];
    const top = () => stack[stack.length - 1]!;
    const text = (s: string) => {
        if (s) top().children.push(decode(s));
    };
    let last = 0;
    for (const m of src.matchAll(TAG)) {
        text(src.slice(last, m.index));
        last = m.index + m[0].length;
        const tag = m[2]!.toLowerCase() as BankTag;
        if (tag === "br") {
            top().children.push({ tag, children: [] });
        } else if (m[1] !== "/") {
            const node = { tag, children: [] as BankNode[] };
            top().children.push(node);
            stack.push(node);
        } else {
            const at = stack.map((n) => n.tag).lastIndexOf(tag);
            if (at > 0) stack.length = at;
        }
    }
    text(src.slice(last));
    return root.children;
}
