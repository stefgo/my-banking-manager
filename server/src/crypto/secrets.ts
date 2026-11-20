// TOTP, tokens and single encrypted fields (TOTP secret, later the PIN). Passwords are checked
// against the key store (crypto/keystore.ts), not here.

import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";

// ---------- TOTP (RFC 6238: SHA-1, 30 s, 6 digits) ----------

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buf: Buffer): string {
    let bits = 0;
    let value = 0;
    let out = "";
    for (const byte of buf) {
        value = (value << 8) | byte;
        bits += 8;
        while (bits >= 5) {
            out += B32[(value >>> (bits - 5)) & 31];
            bits -= 5;
        }
    }
    if (bits > 0) out += B32[(value << (5 - bits)) & 31];
    return out;
}

export function base32Decode(s: string): Buffer {
    const clean = s.toUpperCase().replace(/[^A-Z2-7]/g, "");
    let bits = 0;
    let value = 0;
    const out: number[] = [];
    for (const ch of clean) {
        value = (value << 5) | B32.indexOf(ch);
        bits += 5;
        if (bits >= 8) {
            out.push((value >>> (bits - 8)) & 255);
            bits -= 8;
        }
    }
    return Buffer.from(out);
}

export const newTotpSecret = (): string => base32Encode(randomBytes(20));

export function totpCode(secret: string, step: number): string {
    const counter = Buffer.alloc(8);
    counter.writeBigUInt64BE(BigInt(step));
    const mac = createHmac("sha1", base32Decode(secret)).update(counter).digest();
    const offset = mac[mac.length - 1]! & 0xf;
    const bin = (mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
    return String(bin).padStart(6, "0");
}

export const totpStep = (now = Date.now()): number => Math.floor(now / 30_000);

/**
 * Checks a code against the current step and one step either side. Returns the matched step,
 * or null. A step at or before `lastStep` is refused, so a code works only once.
 */
export function verifyTotp(secret: string, code: string, lastStep: number | null, now = Date.now()): number | null {
    const current = totpStep(now);
    for (const step of [current, current - 1, current + 1]) {
        if (lastStep !== null && step <= lastStep) continue;
        const expected = Buffer.from(totpCode(secret, step));
        const given = Buffer.from(code.padStart(6, "0").slice(0, 6));
        if (timingSafeEqual(expected, given)) return step;
    }
    return null;
}

export const totpUri = (secret: string, user: string): string =>
    `otpauth://totp/${encodeURIComponent(`My Banking Manager:${user}`)}?secret=${secret}&issuer=${encodeURIComponent("My Banking Manager")}&algorithm=SHA1&digits=6&period=30`;

// ---------- Tokens ----------

export const newToken = (): string => randomBytes(32).toString("base64url");
export const hashToken = (token: string): string => createHash("sha256").update(token).digest("hex");

// ---------- Encrypted fields ----------

/** Encrypts single values with a key derived from the data key (AES-256-GCM). */
export class FieldCipher {
    private readonly key: Buffer;

    constructor(dataKey: Buffer) {
        this.key = Buffer.from(hkdfSync("sha256", dataKey, Buffer.alloc(0), Buffer.from("mbm-fields-v1"), 32));
    }

    seal(plain: string): string {
        const iv = randomBytes(12);
        const cipher = createCipheriv("aes-256-gcm", this.key, iv);
        const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
        return `v1.${iv.toString("base64")}.${cipher.getAuthTag().toString("base64")}.${data.toString("base64")}`;
    }

    open(sealed: string): string {
        const [v, iv, tag, data] = sealed.split(".");
        if (v !== "v1" || !iv || !tag || data === undefined) throw new Error("unknown field format");
        const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(iv, "base64"));
        decipher.setAuthTag(Buffer.from(tag, "base64"));
        return Buffer.concat([decipher.update(Buffer.from(data, "base64")), decipher.final()]).toString("utf8");
    }
}
