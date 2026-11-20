import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FAST_KDF, KeyStore, NameTakenError, OldKeyStoreError, WrongSecretError } from "./keystore.js";

let dir: string;
let file: string;
let ks: KeyStore;

beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "mbm-keystore-"));
    file = path.join(dir, "keystore.json");
    ks = new KeyStore(file, FAST_KDF);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("key store", () => {
    it("unwraps the same data key with every user's password and with the recovery key", async () => {
        const { dataKey, recoveryKey } = await ks.create({ userId: 1, name: "Anna", password: "annas passwort" });
        await ks.setUser(dataKey, 2, "Ben", "bens passwort");
        expect((await ks.unlockWithPassword({ name: " anna " }, "annas passwort")).dataKey).toEqual(dataKey);
        expect(await ks.unlockWithPassword({ name: "BEN" }, "bens passwort")).toEqual({ dataKey, userId: 2 });
        expect((await ks.unlockWithPassword({ userId: 2 }, "bens passwort")).dataKey).toEqual(dataKey);
        expect(await ks.unlockWithRecoveryKey(recoveryKey.toLowerCase().replaceAll("-", " "))).toEqual(dataKey);
    });

    it("refuses a wrong password, another user's password and an unknown name", async () => {
        const { dataKey } = await ks.create({ userId: 1, name: "Anna", password: "annas passwort" });
        await ks.setUser(dataKey, 2, "Ben", "bens passwort");
        await expect(ks.unlockWithPassword({ name: "Anna" }, "falsch")).rejects.toThrow(WrongSecretError);
        await expect(ks.unlockWithPassword({ name: "Anna" }, "bens passwort")).rejects.toThrow(WrongSecretError);
        await expect(ks.unlockWithPassword({ name: "Clara" }, "annas passwort")).rejects.toThrow(WrongSecretError);
        await expect(ks.unlockWithRecoveryKey("AAAA-BBBB")).rejects.toThrow(WrongSecretError);
    });

    it("keeps neither names nor passwords readable", async () => {
        await ks.create({ userId: 1, name: "Anna", password: "annas passwort" });
        const text = readFileSync(file, "utf8").toLowerCase();
        expect(text).not.toContain("anna");
        expect(text).not.toContain("passwort");
    });

    it("follows a new password and a removed user", async () => {
        const { dataKey, recoveryKey } = await ks.create({ userId: 1, name: "Anna", password: "annas passwort" });
        await ks.setUser(dataKey, 2, "Ben", "bens passwort");
        await ks.setUser(dataKey, 1, "Anna", "neues passwort");
        await expect(ks.unlockWithPassword({ name: "Anna" }, "annas passwort")).rejects.toThrow(WrongSecretError);
        expect((await ks.unlockWithPassword({ name: "Anna" }, "neues passwort")).userId).toBe(1);

        await expect(ks.setUser(dataKey, 3, "Ben", "claras passwort")).rejects.toThrow(NameTakenError);

        ks.removeUser(2);
        await expect(ks.unlockWithPassword({ name: "Ben" }, "bens passwort")).rejects.toThrow(WrongSecretError);
        await expect(ks.unlockWithPassword({ userId: 2 }, "bens passwort")).rejects.toThrow(WrongSecretError);

        const next = await ks.replaceRecoveryKey(dataKey);
        await expect(ks.unlockWithRecoveryKey(recoveryKey)).rejects.toThrow(WrongSecretError);
        expect(await ks.unlockWithRecoveryKey(next)).toEqual(dataKey);
    });

    it("does not accept a slot moved to another user", async () => {
        const { dataKey } = await ks.create({ userId: 1, name: "Anna", password: "annas passwort" });
        await ks.setUser(dataKey, 2, "Ben", "bens passwort");
        // Ben's slot under Anna's id: Ben's password must not pass as Anna's
        const content = JSON.parse(readFileSync(file, "utf8")) as { users: { userId: number }[] };
        content.users = content.users.filter((u) => u.userId === 2).map((u) => ({ ...u, userId: 1 }));
        writeFileSync(file, JSON.stringify(content));
        await expect(ks.unlockWithPassword({ userId: 1 }, "bens passwort")).rejects.toThrow(WrongSecretError);
    });

    it("refuses a key store of the old format", () => {
        writeFileSync(file, JSON.stringify({ version: 1, passphrase: {}, recovery: {} }));
        expect(() => ks.check()).toThrow(OldKeyStoreError);
    });
});
