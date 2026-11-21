/** Bank exports are often Windows-1252; UTF-8 is tried first and must decode without errors. */
export function decodeCsv(buf: ArrayBuffer, encoding: "auto" | "utf-8" | "windows-1252" = "auto"): string {
    if (encoding !== "auto") return new TextDecoder(encoding).decode(buf);
    try {
        return new TextDecoder("utf-8", { fatal: true }).decode(buf);
    } catch {
        return new TextDecoder("windows-1252").decode(buf);
    }
}
