// Form fields: every form shows its errors at the field and moves the focus to the first one.
// Submit buttons stay enabled; only while saving are they disabled.

/** Errors by field id, in the order of the form. */
export type FieldErrors = Partial<Record<string, string>>;

export const errorId = (id: string): string => `${id}-error`;
export const hintId = (id: string): string => `${id}-hint`;

/** Id and accessibility props of the control inside a `Field` with the same id. */
export function fieldProps(id: string, error?: string, hasHint = false) {
    return {
        id,
        "aria-invalid": error ? (true as const) : undefined,
        "aria-describedby": error ? errorId(id) : hasHint ? hintId(id) : undefined,
    };
}

export function hasErrors(errors: FieldErrors): boolean {
    return Object.values(errors).some(Boolean);
}

/** Focuses the first field with an error; true if there was one. */
export function focusFirstError(errors: FieldErrors): boolean {
    const first = Object.keys(errors).find((k) => errors[k]);
    if (!first) return false;
    // After the render that shows the messages
    setTimeout(() => document.getElementById(first)?.focus(), 0);
    return true;
}

/** Error text for a code from the authenticator app; undefined when it has six digits. */
export const codeProblem = (code: string): string | undefined => (/^\d{6}$/.test(code) ? undefined : "Bitte den 6-stelligen Code eingeben.");
