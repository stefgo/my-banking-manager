// Routes for transfers and payees.

import type { FastifyInstance } from "fastify";
import { routes } from "@mbm/shared";
import { handle, type AppContext } from "../http/route.js";
import { deletePayee, listPayees } from "../services/transfers.js";
import { markPasswordEntered } from "../services/users.js";

export function registerTransferRoutes(app: FastifyInstance, ctx: AppContext): void {
    const { events } = ctx;
    // Looked up per request, not once: tests replace the manager with shorter time limits
    const transfers = () => ctx.transfers;

    handle(app, ctx, routes.transferAccounts, ({ db, session }) => transfers().accounts(db, session.userId));

    handle(app, ctx, routes.createTransfer, async ({ db, session, body, userKey }) => {
        const key = userKey();
        try {
            return await transfers().start(db, session, key, body);
        } finally {
            key.fill(0);
        }
    });

    // Standing orders and scheduled transfers: changed and deleted at the bank like a transfer
    handle(app, ctx, routes.changeOrder, async ({ db, session, params, body, userKey }) => {
        const key = userKey();
        try {
            return await transfers().changeOrder(db, session, key, params.kind, params.id, body);
        } finally {
            key.fill(0);
        }
    });
    handle(app, ctx, routes.deleteOrder, async ({ db, session, params, body, userKey }) => {
        const key = userKey();
        try {
            return await transfers().deleteOrder(db, session, key, params.kind, params.id, body);
        } finally {
            key.fill(0);
        }
    });

    handle(app, ctx, routes.listTransfers, ({ db, session, query }) => transfers().list(db, session.userId, query));
    handle(app, ctx, routes.getTransfer, ({ db, session, params }) => transfers().view(db, params.id, session.userId));
    handle(app, ctx, routes.confirmTransfer, ({ session, params }) => transfers().confirm(params.id, session.userId));
    handle(app, ctx, routes.transferTan, ({ session, params, body }) => transfers().tan(params.id, session.userId, body.tan));
    handle(app, ctx, routes.cancelTransfer, ({ session, params }) => transfers().cancel(params.id, session.userId));

    handle(app, ctx, routes.listPayees, ({ db }) => listPayees(db));
    handle(app, ctx, routes.deletePayee, ({ db, params }) => {
        deletePayee(db, params.id);
        events.changed("payees");
        return { ok: true as const };
    });

    handle(app, ctx, routes.confirmPassword, async (req) => {
        // A wrong password counts against this session; the fifth signs it out
        await ctx.reauth.password(req, req.body.password);
        markPasswordEntered(ctx.vault.database, req.session.deviceId);
        return { ok: true as const };
    });
}
