// A simulated FinTS bank for tests: speaks FinTS over local HTTP and answers by script.
// Its data is made up after the examples of the specification; it never holds real bank data.

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { readMessage, type BankMessage } from "../message/read.js";
import { serializeSegment, toWire } from "../syntax/serialize.js";
import type { ElementInput } from "../syntax/types.js";
import { hnhbk, hnhbs } from "../segments/envelope.js";

/** A segment the simulated bank sends. */
export interface BankSegment {
    id: string;
    version: number;
    ref?: number;
    elements: ElementInput[];
}

export interface SimContext {
    /** Dialog ID the bank assigned (a new one for a message with dialog ID "0"). */
    dialogId: string;
    /** Number of the segment with this id in the customer message. */
    numberOf(id: string): number | undefined;
}

/** Segments to answer with, or a fault: drop the connection, answer non-FinTS, or never answer. */
export type SimHandler = (message: BankMessage, ctx: SimContext) => BankSegment[] | "close" | "garbage" | "hang";

export interface BankSim {
    url: string;
    /** Every customer message the bank received, in order. */
    received: BankMessage[];
    close(): Promise<void>;
}

export async function startBankSim(handler: SimHandler): Promise<BankSim> {
    const received: BankMessage[] = [];
    let dialogs = 0;
    const server: Server = createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            let message: BankMessage;
            try {
                message = readMessage(Buffer.from(Buffer.concat(chunks).toString("latin1"), "base64"));
            } catch {
                res.statusCode = 500;
                res.end();
                return;
            }
            received.push(message);
            const dialogId = message.dialogId === "0" ? `SIMDIALOG${++dialogs}` : message.dialogId;
            const ctx: SimContext = {
                dialogId,
                numberOf: (id) => message.segments.find((s) => s.id === id)?.number,
            };
            const out = handler(message, ctx);
            if (out === "close") {
                req.socket.destroy();
                return;
            }
            if (out === "hang") return;
            if (out === "garbage") {
                res.end("not base64 at all!");
                return;
            }
            res.setHeader("content-type", "text/plain");
            res.end(Buffer.from(bankMessage(out, dialogId, message.messageNumber)).toString("base64"));
        });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    return {
        url: `http://127.0.0.1:${port}/fints`,
        received,
        close: () =>
            new Promise((resolve) => {
                server.close(() => resolve());
                server.closeAllConnections();
            }),
    };
}

/** Wraps bank segments in HNHBK (with Bezugsnachricht) and HNHBS, numbered from 2. */
export function bankMessage(segments: BankSegment[], dialogId: string, customerMessageNumber: number): Buffer {
    let n = 2;
    const body = segments.map((s) => serializeSegment({ ...s, number: n++ })).join("");
    // The bank numbers its messages itself; within one dialog that runs in step with the customer.
    const head = (size: number) => {
        const h = hnhbk(size, dialogId, customerMessageNumber);
        return serializeSegment({ ...h, number: 1, elements: [...h.elements, [dialogId, customerMessageNumber]] });
    };
    const tail = serializeSegment({ ...hnhbs(customerMessageNumber), number: n });
    const size = head(0).length + body.length + tail.length;
    return toWire(head(size) + body + tail);
}

// ---------- Ready-made answers ----------

export const SIM_BLZ = "12345678";

export const ok = (ref?: number, code = "0020", text = "Auftrag ausgeführt."): BankSegment =>
    ref === undefined ? { id: "HIRMG", version: 2, elements: [["0010", "", "Nachricht entgegengenommen."]] } : { id: "HIRMS", version: 2, ref, elements: [[code, "", text]] };

/** Bank parameters of the made-up "Simulationsbank". */
export function simBpd(version = 7, refHkvvb?: number): BankSegment[] {
    return [
        { id: "HIBPA", version: 3, ref: refHkvvb, elements: [version, ["280", SIM_BLZ], "Simulationsbank", 0, "1", "300", 0] },
        { id: "HIKOM", version: 4, ref: refHkvvb, elements: [["280", SIM_BLZ], 1, ["3", "banking.example.invalid/fints", "", "MIM", 1]] },
        { id: "HISHV", version: 3, ref: refHkvvb, elements: ["N", ["PIN", 1], ["RDH", 3]] },
        {
            id: "HIPINS",
            version: 1,
            ref: refHkvvb,
            elements: [1, 1, 0, [5, 20, 6, "Anmeldename", "Kunden-ID", "HKSAL", "J", "HKKAZ", "J", "HKCAZ", "J", "HKSPA", "N", "HKTAN", "N", "HKCCS", "J"]],
        },
        { id: "HISALS", version: 6, ref: refHkvvb, elements: [1, 1, 0] },
        { id: "HISALS", version: 7, ref: refHkvvb, elements: [1, 1, 0] },
        { id: "HIKAZS", version: 7, ref: refHkvvb, elements: [1, 1, 0, [365, "J", "N"]] },
        { id: "DIKKUS", version: 2, ref: refHkvvb, elements: [1, 1, 0, [90, "J"]] },
    ];
}
