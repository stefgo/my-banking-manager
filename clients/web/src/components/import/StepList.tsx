import { Fragment } from "react";
import { Check } from "lucide-react";
import { Ic } from "../icons";

/** The steps of a flow, those before `at` done. */
export function StepList({ steps, at }: { steps: readonly string[]; at: number }) {
    return (
        <ol className="steps tf" aria-label="Schritte">
            {steps.map((s, i) => (
                <Fragment key={s}>
                    {i > 0 && <li className="step-sep" aria-hidden="true" />}
                    <li className={`step ${i < at ? "done" : i === at ? "on" : ""}`} aria-current={i === at ? "step" : undefined}>
                        <span className="n">{i < at ? <Ic icon={Check} size={13} /> : i + 1}</span>
                        {s}
                    </li>
                </Fragment>
            ))}
        </ol>
    );
}
