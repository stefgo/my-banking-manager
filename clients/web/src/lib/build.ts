// Which build of the web client runs in this window. The server writes it into index.html and
// reports the one it delivers in its status; after an update the two differ.

/** Build of this window; null under the Vite dev server, which writes none. */
export const OWN_BUILD = typeof document === "undefined" ? null : (document.querySelector<HTMLMetaElement>('meta[name="mbm-build"]')?.content ?? null);

/** True when the server delivers another web client than the one in this window. */
export function isOutdated(own: string | null, server: string | null | undefined): boolean {
    return !!own && !!server && own !== server;
}

/** True when no text field of the page holds input, so that a reload loses nothing. */
export function nothingTyped(): boolean {
    const fields = document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("textarea, input:not([type=checkbox]):not([type=radio]):not([type=hidden])");
    return [...fields].every((f) => !f.value);
}
