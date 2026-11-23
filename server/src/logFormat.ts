// Shown elsewhere in the line (level, time) or not at all (pid, hostname)
const NOT_A_FIELD = new Set(["level", "time", "pid", "hostname"]);

/** Keeps plain strings readable and escapes anything that could break the line. */
function formatValue(value: unknown): string {
    const json = JSON.stringify(value) ?? String(value);
    return typeof value === "string" && json === `"${value}"` ? value : json;
}

function errorStack(err: unknown): string | undefined {
    if (typeof err !== "object" || err === null || !("stack" in err)) return undefined;
    return typeof err.stack === "string" ? err.stack : undefined;
}

/** Terminal log message with its fields on the same line: `unlocked (userId: 1)`. A stack trace follows below. */
export function formatLogMessage(log: Record<string, unknown>, messageKey: string): string {
    const stack = errorStack(log.err);
    const fields = Object.entries(log)
        .filter(([key]) => key !== messageKey && !NOT_A_FIELD.has(key) && !(key === "err" && stack))
        .map(([key, value]) => `${key}: ${formatValue(value)}`);
    const message = typeof log[messageKey] === "string" ? log[messageKey] : "";
    const line = fields.length > 0 ? `${message} (${fields.join(", ")})`.trimStart() : message;
    return stack ? `${line}\n    ${stack.replaceAll("\n", "\n    ")}` : line;
}

/** Readable terminal output, or undefined (plain JSON) where the dev-only printer is not installed, as in Docker images. */
export async function createPrettyOutput(load = () => import("pino-pretty")) {
    try {
        const { default: pretty } = await load();
        // In-process, because a worker transport cannot receive the format function
        return pretty({ translateTime: "SYS:HH:MM:ss", ignore: "pid,hostname", hideObject: true, messageFormat: formatLogMessage, sync: true });
    } catch (e) {
        if (typeof e === "object" && e !== null && "code" in e && e.code === "ERR_MODULE_NOT_FOUND") return undefined;
        throw e;
    }
}
