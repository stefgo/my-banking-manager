import { describe, expect, it } from "vitest";
import type { SyncRun } from "@mbm/shared";
import { syncingAccountIds } from "./bank";

const run = (patch: Partial<SyncRun>): SyncRun => ({
    id: "00000000-0000-4000-8000-000000000000",
    connectionId: 1,
    connectionName: "Testbank",
    status: "running",
    challenge: null,
    accountIds: [1, 2],
    newTransactions: 0,
    newAccounts: [],
    missingAccounts: [],
    consentEndedAccounts: [],
    ordersOnly: false,
    ordersMessage: null,
    foreignCurrency: 0,
    error: null,
    message: null,
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: null,
    ...patch,
});

describe("syncingAccountIds", () => {
    it("covers the accounts of running runs and of runs waiting for an approval", () => {
        expect([...syncingAccountIds([run({ accountIds: [1] }), run({ status: "approval", accountIds: [2] })])]).toEqual([1, 2]);
    });

    it("leaves out finished and failed runs", () => {
        expect(syncingAccountIds([run({ status: "done" }), run({ status: "error" })]).size).toBe(0);
    });

    it("leaves out runs for the orders alone", () => {
        expect(syncingAccountIds([run({ ordersOnly: true })]).size).toBe(0);
    });

    it("leaves out accounts the bank no longer reports", () => {
        expect([...syncingAccountIds([run({ missingAccounts: [2] })])]).toEqual([1]);
    });
});
