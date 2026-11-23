import { describe, expect, it } from "vitest";
import { createPrettyOutput, formatLogMessage } from "./logFormat.js";

const base = { level: 30, time: 1, pid: 2, hostname: "host" };

describe("formatLogMessage", () => {
    it("puts fields behind the message on one line", () => {
        expect(formatLogMessage({ ...base, msg: "unlocked", userId: 1 }, "msg")).toBe("unlocked (userId: 1)");
        expect(formatLogMessage({ ...base, msg: "refused", origin: "http://a.test", port: 80 }, "msg")).toBe("refused (origin: http://a.test, port: 80)");
    });

    it("leaves a message without fields unchanged", () => {
        expect(formatLogMessage({ ...base, msg: "started" }, "msg")).toBe("started");
    });

    it("shows the stack trace of an error below the line", () => {
        const err = { type: "Error", message: "boom", stack: "Error: boom\n    at run" };
        expect(formatLogMessage({ ...base, msg: "request failed", err, reqId: "req-1" }, "msg")).toBe("request failed (reqId: req-1)\n    Error: boom\n        at run");
    });

    it("keeps an error without a stack trace as a field", () => {
        expect(formatLogMessage({ ...base, msg: "failed", err: "boom" }, "msg")).toBe("failed (err: boom)");
    });

    it("keeps every entry on one line", () => {
        expect(formatLogMessage({ ...base, msg: "failed", reason: "a\nb" }, "msg")).toBe('failed (reason: "a\\nb")');
        expect(formatLogMessage({ ...base, msg: "invalid", issues: [{ path: ["x"] }] }, "msg")).toBe('invalid (issues: [{"path":["x"]}])');
    });
});

describe("createPrettyOutput", () => {
    it("falls back to plain output when the printer is not installed", async () => {
        const missing = Object.assign(new Error("Cannot find package"), { code: "ERR_MODULE_NOT_FOUND" });
        await expect(createPrettyOutput(() => Promise.reject(missing))).resolves.toBeUndefined();
    });

    it("does not hide other load failures", async () => {
        await expect(createPrettyOutput(() => Promise.reject(new Error("broken")))).rejects.toThrow("broken");
    });
});
