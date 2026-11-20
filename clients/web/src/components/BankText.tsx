import type { ReactNode } from "react";
import { parseBankText, type BankNode } from "../lib/bankText";

/**
 * The bank's explanation, shown unchanged. With `structured` its few allowed tags become React
 * elements; nothing of it is ever inserted as HTML. Links show their text only.
 */
export function BankText({ text, structured }: { text: string; structured: boolean }) {
    if (!structured) return <div className="bank-text plain">{text}</div>;
    return <div className="bank-text">{render(parseBankText(text))}</div>;
}

function render(nodes: BankNode[]): ReactNode[] {
    return nodes.map((n, i) => {
        if (typeof n === "string") return n;
        const kids = render(n.children);
        switch (n.tag) {
            case "br":
                return <br key={i} />;
            case "p":
                return <p key={i}>{kids}</p>;
            case "b":
                return <b key={i}>{kids}</b>;
            case "i":
                return <i key={i}>{kids}</i>;
            case "u":
                return <u key={i}>{kids}</u>;
            case "ul":
                return <ul key={i}>{kids}</ul>;
            case "ol":
                return <ol key={i}>{kids}</ol>;
            case "li":
                return <li key={i}>{kids}</li>;
            case "a":
                return <span key={i}>{kids}</span>;
        }
    });
}
