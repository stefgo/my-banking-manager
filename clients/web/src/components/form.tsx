import type { ReactNode } from "react";
import { AlertTriangle } from "lucide-react";
import { errorId, fieldProps, hintId } from "../lib/fields";
import { Ic } from "./icons";

/**
 * A labelled form field with hint and error below. The control inside takes the same `id` and
 * the props of `fieldProps(id, error, !!hint)`.
 */
export function Field({ id, label, hint, error, children }: { id: string; label: ReactNode; hint?: ReactNode; error?: string; children: ReactNode }) {
    return (
        <div className="field">
            <label className="flabel" htmlFor={id}>
                {label}
            </label>
            {children}
            {error ? (
                <p className="hint bad" id={errorId(id)}>
                    <Ic icon={AlertTriangle} size={14} />
                    <span>{error}</span>
                </p>
            ) : hint ? (
                <p className="hint" id={hintId(id)}>
                    {hint}
                </p>
            ) : null}
        </div>
    );
}

/** The 6-digit code from the authenticator app, digits only. */
export function CodeInput({
    id = "code",
    label = "Code aus der Authenticator-App",
    value,
    onChange,
    error,
    autoFocus = true,
}: {
    id?: string;
    label?: ReactNode;
    value: string;
    onChange: (v: string) => void;
    error?: string;
    autoFocus?: boolean;
}) {
    return (
        <Field id={id} label={label} error={error}>
            <input
                className="inp mono"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="\d{6}"
                maxLength={6}
                placeholder="6-stelliger Code"
                value={value}
                onChange={(e) => onChange(e.target.value.replace(/\D/g, ""))}
                autoFocus={autoFocus}
                {...fieldProps(id, error)}
            />
        </Field>
    );
}
