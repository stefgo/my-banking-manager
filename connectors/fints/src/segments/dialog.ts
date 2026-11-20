// Dialog segments of the customer (Formals C.3.1, C.4.2, C.5).

import type { SegmentInput } from "../syntax/types.js";
import { kik } from "./common.js";

/** Kunden-ID of the anonymous access (Formals C.5.1); never given to a real customer. */
export const ANONYMOUS_CUSTOMER_ID = "9999999999";

/** Identifikation (HKIDN v2). `systemRequired`: Kundensystem-Status 1 (PIN/TAN needs it). */
export const hkidn = (blz: string, customerId: string, systemId: string, systemRequired: boolean): SegmentInput => ({
    id: "HKIDN",
    version: 2,
    elements: [kik(blz), customerId, systemId, systemRequired ? "1" : "0"],
});

/** Product data sent in HKVVB; the name must be the registration number (Formals C.3.1.3). */
export interface Product {
    /** FinTS product registration number. */
    id: string;
    /** Product version, at most 5 characters. */
    version: string;
}

/** Verarbeitungsvorbereitung (HKVVB v3). Language 0 = the bank's default language. */
export const hkvvb = (bpdVersion: number, updVersion: number, product: Product, language = 0): SegmentInput => ({
    id: "HKVVB",
    version: 3,
    elements: [bpdVersion, updVersion, language, product.id, product.version.slice(0, 5)],
});

/** Dialogende (HKEND v1). */
export const hkend = (dialogId: string): SegmentInput => ({ id: "HKEND", version: 1, elements: [dialogId] });
