/** Bank exports are often Windows-1252; UTF-8 is tried first and must decode without errors. */
export function decodeCsv(buf: ArrayBuffer): string {
    try {
        return new TextDecoder("utf-8", { fatal: true }).decode(buf);
    } catch {
        return new TextDecoder("windows-1252").decode(buf);
    }
}
