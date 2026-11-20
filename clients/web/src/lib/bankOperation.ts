// Bank calls that may pause for an approval (pushTAN in the app, or a TAN to type in).

import { useState } from "react";
import { routes, type ConnectorChallenge } from "@mbm/shared";
import { call, errorText } from "./api";

export type BankOutcome<T> = { status: "done"; data: T } | { status: "approval"; operationId: string; challenge: ConnectorChallenge };
type Pending = { operationId: string; challenge: ConnectorChallenge; done: (data: unknown) => void };

/**
 * `outcome` hands a finished call's data to `done`, or keeps the approval the bank asks for in
 * `approval` (the props of `<Approval>`) and calls `done` once it is given.
 */
export function useBankOperation(onError: (text: string) => void) {
    const [pending, setPending] = useState<Pending | null>(null);

    const outcome = <T>(o: BankOutcome<T>, done: (data: T) => void): void => {
        if (o.status === "done") done(o.data);
        else setPending({ operationId: o.operationId, challenge: o.challenge, done: done as (d: unknown) => void });
    };
    /** True when the operation is over. */
    const finish = (o: BankOutcome<unknown>): boolean => {
        if (!pending) return true;
        if (o.status === "approval") {
            setPending({ ...pending, challenge: o.challenge });
            return false;
        }
        setPending(null);
        pending.done(o.data);
        return true;
    };
    const failed = (err: unknown): true => {
        setPending(null);
        onError(errorText(err));
        return true;
    };

    const approval = pending && {
        challenge: pending.challenge,
        poll: async () => {
            try {
                return finish(await call(routes.bankOperation, { params: { id: pending.operationId } }));
            } catch (err) {
                return failed(err);
            }
        },
        submitTan: async (tan: string) => {
            try {
                finish(await call(routes.bankOperationTan, { params: { id: pending.operationId }, body: { tan } }));
            } catch (err) {
                failed(err);
            }
        },
        onCancel: () => {
            void call(routes.cancelBankOperation, { params: { id: pending.operationId } }).catch(() => undefined);
            setPending(null);
        },
    };

    return { pending: pending !== null, outcome, approval };
}
