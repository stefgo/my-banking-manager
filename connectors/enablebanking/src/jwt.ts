// The token Enable Banking expects on every request: a JWT signed with the application's private
// key (RS256, "kid" = application ID). Made fresh for each call; nothing is kept.

import { createPrivateKey, sign, type KeyObject } from "node:crypto";

/** Lifetime of a token. Enable Banking accepts at most 24 hours. */
export const TOKEN_TTL_SECONDS = 3600;

const base64url = (data: string | Buffer): string => Buffer.from(data).toString("base64url");

/** The private key from its PEM text; throws if it is not a private RSA key. */
export function readPrivateKey(pem: string): KeyObject {
    const key = createPrivateKey({ key: pem, format: "pem" });
    if (key.asymmetricKeyType !== "rsa") throw new Error("The key is not an RSA key.");
    return key;
}

export function signToken(applicationId: string, key: KeyObject, nowSeconds = Math.floor(Date.now() / 1000)): string {
    const header = { typ: "JWT", alg: "RS256", kid: applicationId };
    const payload = { iss: "enablebanking.com", aud: "api.enablebanking.com", iat: nowSeconds, exp: nowSeconds + TOKEN_TTL_SECONDS };
    const data = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
    return `${data}.${base64url(sign("sha256", Buffer.from(data), key))}`;
}
