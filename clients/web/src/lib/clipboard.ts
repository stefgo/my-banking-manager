import { ui } from "./ui";

/** Copies a text and says whether it worked. */
export function copyText(text: string): void {
    void navigator.clipboard?.writeText(text).then(
        () => ui.toast("Kopiert"),
        () => ui.toast("Kopieren nicht möglich", "error"),
    );
}
