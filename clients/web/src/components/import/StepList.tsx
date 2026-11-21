import { Fragment } from "react";
import { Check } from "lucide-react";
import { Ic } from "../icons";

/** The steps of a flow, those before `at` done. With `onPick`, a step that is done can be opened. */
export function StepList({ steps, at, onPick }: { steps: readonly string[]; at: number; onPick?: ((index: number) => void) | undefined }) {
    return (
        <ol className="steps tf" aria-label="Schritte">
            {steps.map((s, i) => {
                const label = (
                    <>
                        <span className="n">{i < at ? <Ic icon={Check} size={13} /> : i + 1}</span>
                        {s}
                    </>
                );
                return (
                    <Fragment key={s}>
                        {i > 0 && <li className="step-sep" aria-hidden="true" />}
                        <li className={`step ${i < at ? "done" : i === at ? "on" : ""}`} aria-current={i === at ? "step" : undefined}>
                            {onPick && i < at ? <button type="button" className="step-link" onClick={() => onPick(i)}>{label}</button> : label}
                        </li>
                    </Fragment>
                );
            })}
        </ol>
    );
}
