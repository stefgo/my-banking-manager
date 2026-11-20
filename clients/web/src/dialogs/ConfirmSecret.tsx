import { useState } from "react";
import { KeyRound, ShieldCheck } from "lucide-react";
import { errorText } from "../lib/api";
import { codeProblem, fieldProps } from "../lib/fields";
import { ui, type Dialog } from "../lib/ui";
import { Button, Modal } from "../components/common";
import { CodeInput, Field } from "../components/form";

type Props = Omit<Extract<Dialog, { kind: "confirmSecret" }>, "kind">;

/**
 * Confirms a step with the code from the authenticator app or the password. A wrong entry shows
 * at the field and the dialog stays open; the fifth wrong one signs the session out (server).
 */
export function ConfirmSecretDialog({ secret, title, text, confirm, danger, run, onDone }: Props) {
    const [value, setValue] = useState("");
    const [error, setError] = useState<string | undefined>();
    const [busy, setBusy] = useState(false);
    const submit = async (e: React.FormEvent) => {
        e.preventDefault();
        const problem = secret === "code" ? codeProblem(value) : value ? undefined : "Bitte das Passwort eingeben.";
        if (problem) return setError(problem);
        setBusy(true);
        try {
            await run(value);
            ui.close();
            onDone?.();
        } catch (err) {
            setError(errorText(err));
            setValue("");
        } finally {
            setBusy(false);
        }
    };
    return (
        <Modal title={title} onClose={() => ui.close()} narrow>
            <form className="form-grid" style={{ gap: 16 }} onSubmit={submit} noValidate>
                <p className="muted">{text}</p>
                {secret === "code" ? (
                    <CodeInput id="secret-confirm" label="Dein Code aus der Authenticator-App" value={value} onChange={setValue} error={error} />
                ) : (
                    <Field id="secret-confirm" label="Dein Passwort" error={error}>
                        <input
                            className="inp"
                            type="password"
                            autoComplete="current-password"
                            autoFocus
                            value={value}
                            onChange={(e) => setValue(e.target.value)}
                            {...fieldProps("secret-confirm", error)}
                        />
                    </Field>
                )}
                <div className="actions">
                    <button type="button" className="btn btn-ghost" onClick={() => ui.close()}>Abbrechen</button>
                    <Button className={danger ? "btn-danger" : "btn-primary"} type="submit" busy={busy} icon={secret === "code" ? ShieldCheck : KeyRound}>
                        {confirm}
                    </Button>
                </div>
            </form>
        </Modal>
    );
}
