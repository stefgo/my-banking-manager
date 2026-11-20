// Suggestions under a search or rule field (see lib/suggest.ts). Arrow keys pick, Tab takes the
// highlighted one, Enter only after picking with the arrows (in a form Enter still submits),
// Esc closes the list until the next input.

import { useId, useMemo, useState, type KeyboardEvent, type RefObject, type SyntheticEvent } from "react";
import { useAccounts, useCategoryIndex } from "./queries";
import { applySuggestion, suggest, type Suggestion } from "./suggest";

export interface SuggestList {
    id: string;
    items: Suggestion[];
    active: number;
    take: (i: number) => void;
}

export function useSuggest({ value, onChange, inputRef, mode = "search" }: { value: string; onChange: (text: string) => void; inputRef: RefObject<HTMLInputElement | null>; mode?: "search" | "rule" }) {
    const accounts = useAccounts().data;
    const { index } = useCategoryIndex();
    const ctx = useMemo(() => ({ categories: [...index.byId.values()].map((c) => c.name), accounts: (accounts ?? []).map((a) => a.name), mode }), [index, accounts, mode]);
    const [caret, setCaret] = useState<number | null>(null);
    const [active, setActive] = useState(0);
    const [picked, setPicked] = useState(false);
    const [closed, setClosed] = useState(false);
    const id = useId();
    const result = useMemo(() => (caret === null || closed ? null : suggest(value, caret, ctx)), [caret, closed, value, ctx]);
    const at = result ? Math.min(active, result.items.length - 1) : 0;

    const take = (i: number) => {
        if (!result) return;
        const next = applySuggestion(value, result, result.items[i]!);
        onChange(next.text);
        setActive(0);
        setPicked(false);
        requestAnimationFrame(() => {
            const el = inputRef.current;
            el?.focus();
            el?.setSelectionRange(next.caret, next.caret);
            setCaret(next.caret);
        });
    };

    const track = (e: SyntheticEvent<HTMLInputElement>) => setCaret(e.currentTarget.selectionStart);

    /** Handles a key for the list; true when it did, then the field must not handle it too. */
    const onKeyDown = (e: KeyboardEvent<HTMLInputElement>): boolean => {
        if (!result) return false;
        const n = result.items.length;
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            setActive(picked ? (at + (e.key === "ArrowDown" ? 1 : -1) + n) % n : e.key === "ArrowDown" ? 0 : n - 1);
            setPicked(true);
            return true;
        }
        if ((e.key === "Tab" && !e.shiftKey) || (e.key === "Enter" && picked)) {
            e.preventDefault();
            take(at);
            return true;
        }
        if (e.key === "Escape") {
            e.preventDefault();
            setClosed(true);
            return true;
        }
        return false;
    };

    /** Call on every input: a closed list opens again, the pick starts over. */
    const onInput = () => {
        setClosed(false);
        setActive(0);
        setPicked(false);
    };

    const inputProps = {
        role: "combobox" as const,
        "aria-autocomplete": "list" as const,
        "aria-expanded": !!result,
        "aria-controls": result ? id : undefined,
        "aria-activedescendant": result && picked ? `${id}-${at}` : undefined,
        onSelect: track,
        onFocus: track,
        onBlur: () => setCaret(null),
    };
    const list: SuggestList | null = result ? { id, items: result.items, active: at, take } : null;
    return { inputProps, onKeyDown, onInput, list };
}
