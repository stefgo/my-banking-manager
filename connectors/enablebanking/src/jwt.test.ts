import { generateKeyPairSync, verify } from "node:crypto";
import { describe, expect, it } from "vitest";
import { readPrivateKey, signToken, TOKEN_TTL_SECONDS } from "./jwt.js";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

describe("signToken", () => {
    it("signs header and claims as Enable Banking expects", () => {
        const token = signToken("app-id", readPrivateKey(pem), 1_000_000);
        const [h, p, s] = token.split(".");
        expect(JSON.parse(Buffer.from(h!, "base64url").toString())).toEqual({ typ: "JWT", alg: "RS256", kid: "app-id" });
        expect(JSON.parse(Buffer.from(p!, "base64url").toString())).toEqual({
            iss: "enablebanking.com",
            aud: "api.enablebanking.com",
            iat: 1_000_000,
            exp: 1_000_000 + TOKEN_TTL_SECONDS,
        });
        expect(verify("sha256", Buffer.from(`${h}.${p}`), publicKey, Buffer.from(s!, "base64url"))).toBe(true);
    });

    it("stays within the lifetime Enable Banking accepts", () => {
        expect(TOKEN_TTL_SECONDS).toBeLessThanOrEqual(86_400);
    });
});

describe("readPrivateKey", () => {
    it("refuses a key that is not RSA", () => {
        const ec = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
        expect(() => readPrivateKey(ec)).toThrow(/RSA/);
    });

    it("refuses a public key", () => {
        expect(() => readPrivateKey(publicKey.export({ type: "spki", format: "pem" }).toString())).toThrow();
    });
});
