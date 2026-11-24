// What the forms for passwords, codes and the recovery key have in common.

import { ApiFailure, errorText } from "./api";
import { focusFirstError, type FieldErrors } from "./fields";

export const MIN_PASSWORD = 12;
export const PASSWORD_HINT = `Mindestens ${MIN_PASSWORD} Zeichen.`;

export function passwordProblem(pw: string): string | undefined {
    if (!pw) return "Bitte ein Passwort eingeben.";
    return pw.length < MIN_PASSWORD ? `Das Passwort braucht mindestens ${MIN_PASSWORD} Zeichen.` : undefined;
}

type SecretKind = "password" | "code" | "recoveryKey";

const KIND_OF_ERROR = new Map<string, SecretKind>([
    ["wrong_password", "password"],
    ["wrong_code", "code"],
    ["code_used", "code"],
    ["totp_missing", "code"],
    ["wrong_recovery_key", "recoveryKey"],
]);

/** Shows a wrong password, code or key at its own field and empties it; true = handled. */
export function showSecretError(
    err: unknown,
    setErrors: (update: (errors: FieldErrors) => FieldErrors) => void,
    fields: Partial<Record<SecretKind, { id: string; clear: () => void }>>,
): boolean {
    if (!(err instanceof ApiFailure)) return false;
    const kind = KIND_OF_ERROR.get(err.code);
    const field = kind && fields[kind];
    if (!field) return false;
    const message = errorText(err);
    setErrors((errors) => ({ ...errors, [field.id]: message }));
    field.clear();
    focusFirstError({ [field.id]: message });
    return true;
}
