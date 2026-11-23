import type { FastifyInstance } from "fastify";
import { formatSignedCents, routes, todayIso } from "@mbm/shared";
import { handle, type AppContext } from "../http/route.js";
import * as accounts from "../services/accounts.js";
import * as categories from "../services/categories.js";
import * as importFormats from "../services/importFormats.js";
import * as imports from "../services/imports.js";
import * as orders from "../services/orders.js";
import * as profile from "../services/profile.js";
import * as rules from "../services/rules.js";
import * as tx from "../services/transactions.js";
import * as unread from "../services/unread.js";
import { logActivity } from "../services/users.js";

const OK = { ok: true as const };

export function registerDataRoutes(app: FastifyInstance, ctx: AppContext): void {
    const { events } = ctx;

    // ---------- Profile ----------

    handle(app, ctx, routes.profile, ({ db, session, query }) => {
        profile.ensureCards(db, session.userId);
        const settings = profile.readSettings(db, session.userId, query.client, ctx.config.profileDefaults[query.client]);
        return { settings, cards: profile.listCards(db, session.userId) };
    });

    handle(app, ctx, routes.clientSettings, ({ db, session, query }) =>
        profile.readSettings(db, session.userId, query.client, ctx.config.profileDefaults[query.client]),
    );

    handle(app, ctx, routes.setSetting, ({ db, session, params, query, body }) => {
        profile.writeSetting(db, session.userId, query.client, params.key, body.value);
        events.profileChanged(session.userId, session.deviceId);
        return OK;
    });

    handle(app, ctx, routes.createCard, ({ db, session, body }) => {
        const card = profile.createCard(db, session.userId, body);
        events.profileChanged(session.userId, session.deviceId);
        return card;
    });

    handle(app, ctx, routes.updateCard, ({ db, session, params, body }) => {
        const card = profile.updateCard(db, session.userId, params.id, body);
        events.profileChanged(session.userId, session.deviceId);
        return card;
    });

    handle(app, ctx, routes.deleteCard, ({ db, session, params }) => {
        profile.deleteCard(db, session.userId, params.id);
        events.profileChanged(session.userId, session.deviceId);
        return OK;
    });

    handle(app, ctx, routes.orderCards, ({ db, session, body }) => {
        db.transaction(() => profile.orderCards(db, session.userId, body.ids))();
        events.profileChanged(session.userId, session.deviceId);
        return OK;
    });

    handle(app, ctx, routes.resetCards, ({ db, session }) => {
        const cards = db.transaction(() => profile.resetCards(db, session.userId))();
        events.profileChanged(session.userId, session.deviceId);
        return cards;
    });

    // ---------- Groups and accounts ----------

    handle(app, ctx, routes.listGroups, ({ db }) => accounts.listGroups(db));

    handle(app, ctx, routes.createGroup, ({ db, body }) => {
        const group = accounts.createGroup(db, body);
        events.changed("groups");
        return group;
    });

    handle(app, ctx, routes.updateGroup, ({ db, params, body }) => {
        const group = accounts.updateGroup(db, params.id, body);
        events.changed("groups");
        return group;
    });

    handle(app, ctx, routes.deleteGroup, ({ db, params }) => {
        db.transaction(() => accounts.deleteGroup(db, params.id))();
        events.changed("groups", "accounts");
        return OK;
    });

    handle(app, ctx, routes.moveTreeNode, ({ db, body }) => {
        db.transaction(() => accounts.moveTreeNode(db, body))();
        events.changed("groups", "accounts");
        return OK;
    });

    handle(app, ctx, routes.listAccounts, ({ db }) => accounts.listAccounts(db));

    handle(app, ctx, routes.createOfflineAccount, ({ db, actor, body }) => {
        const account = accounts.createOfflineAccount(db, body);
        logActivity(db, actor, "account_created", account.name, "Offline-Konto");
        events.changed("accounts", "activity");
        return account;
    });

    handle(app, ctx, routes.updateAccount, ({ db, params, body }) => {
        const account = accounts.updateAccount(db, params.id, body);
        events.changed("accounts", "transactions");
        return account;
    });

    handle(app, ctx, routes.deleteAccount, ({ db, actor, params }) => {
        const row = db.transaction(() => accounts.deleteAccount(db, params.id))();
        logActivity(db, actor, "account_deleted", row.name);
        // A rule may have lost its account
        events.changed("accounts", "transactions", "categories", "rules", "activity");
        return OK;
    });

    handle(app, ctx, routes.reconcile, ({ db, actor, params, body }) => {
        const result = db.transaction(() => tx.reconcile(db, params.id, body.date, body.balance, actor.userId))();
        if (result.transactionId) {
            logActivity(db, actor, "reconcile", accounts.getAccount(db, params.id).name, `Differenz ${formatSignedCents(result.difference)}`);
            events.changed("accounts", "transactions", "categories", "activity");
        }
        return result;
    });

    // ---------- Transactions ----------

    handle(app, ctx, routes.listTransactions, ({ db, session, query }) => tx.listTransactions(db, query, session.userId));

    handle(app, ctx, routes.unreadCounts, ({ db, session }) => unread.unreadCounts(db, session.userId));

    handle(app, ctx, routes.markRead, ({ db, session, body }) => {
        const changed = db.transaction(() =>
            body.scope ? unread.markScopeRead(db, session.userId, body.scope) : unread.setUnread(db, session.userId, body.ids ?? [], body.unread),
        )();
        // Only this user's other devices: the asking one updates itself
        if (changed) events.changedForUser(session.userId, session.deviceId, "unread");
        return { changed };
    });

    handle(app, ctx, routes.createTransaction, ({ db, actor, params, body }) => {
        const t = db.transaction(() => tx.createManual(db, params.id, body, actor.userId))();
        events.changed("accounts", "transactions", "categories");
        return t;
    });

    handle(app, ctx, routes.updateTransaction, ({ db, params, body }) => {
        const t = db.transaction(() => tx.updateManual(db, params.id, body))();
        events.changed("accounts", "transactions", "categories");
        return t;
    });

    handle(app, ctx, routes.deleteTransaction, ({ db, params }) => {
        db.transaction(() => tx.deleteManual(db, params.id))();
        events.changed("accounts", "transactions", "categories");
        return OK;
    });

    handle(app, ctx, routes.assignCategory, ({ db, body }) => {
        const changed = db.transaction(() => tx.assignCategory(db, body.ids, body.categoryId))();
        events.changed("transactions", "categories");
        return { changed };
    });

    handle(app, ctx, routes.setTransactionEdit, ({ db, params, body }) => {
        const t = tx.setTransactionEdit(db, params.id, params.field, body.value);
        events.changed("transactions");
        return t;
    });

    handle(app, ctx, routes.clearTransactionEdit, ({ db, params }) => {
        const t = tx.clearTransactionEdit(db, params.id, params.field);
        events.changed("transactions");
        return t;
    });

    handle(app, ctx, routes.createCounterBooking, ({ db, actor, params, body }) => {
        const t = db.transaction(() => tx.createCounter(db, params.id, body.accountId, actor.userId, body.categoryId))();
        logActivity(db, actor, "counter_booking", accounts.getAccount(db, body.accountId).name, formatSignedCents(t.amount));
        events.changed("accounts", "transactions", "categories", "activity");
        return t;
    });

    handle(app, ctx, routes.deleteCounterBooking, ({ db, params }) => {
        db.transaction(() => tx.unlinkCounter(db, params.id))();
        events.changed("accounts", "transactions", "categories");
        return OK;
    });

    handle(app, ctx, routes.payees, ({ db, query }) => tx.payees(db, query.accountId));

    handle(app, ctx, routes.series, ({ db, query }) => {
        const today = todayIso();
        const points = tx.balanceSeries(db, query.scope, query.days, query.range, today, { from: query.from, to: query.to });
        const last = points.at(-1);
        // A forecast continues the line, so only a series that ends today has one
        const forecast = query.forecastDays > 0 && last?.date === today ? orders.forecast(db, accounts.accountsInScope(db, query.scope), last.balance, query.forecastDays, today) : [];
        return { points, forecast };
    });

    handle(app, ctx, routes.cashflow, ({ db, query }) => tx.cashflow(db, query.scope, query.from, query.to));

    handle(app, ctx, routes.categorySums, ({ db, query }) => ({ sums: tx.categorySums(db, query.scope, query.from, query.to) }));

    // ---------- Categories and rules ----------

    handle(app, ctx, routes.listCategories, ({ db }) => categories.listCategories(db));

    handle(app, ctx, routes.createCategory, ({ db, body }) => {
        const c = categories.createCategory(db, body);
        events.changed("categories");
        return c;
    });

    handle(app, ctx, routes.updateCategory, ({ db, params, body }) => {
        const c = db.transaction(() => categories.updateCategory(db, params.id, body))();
        events.changed("categories", "transactions");
        return c;
    });

    handle(app, ctx, routes.deleteCategory, ({ db, actor, params, query }) => {
        const c = db.transaction(() => categories.deleteCategory(db, params.id, query.moveTo))();
        logActivity(db, actor, "category_deleted", c.name);
        events.changed("categories", "transactions", "rules", "activity");
        return OK;
    });

    handle(app, ctx, routes.moveCategory, ({ db, body }) => {
        db.transaction(() => categories.moveCategory(db, body))();
        // Which bookings a subtree covers and which count in the figures may change
        events.changed("categories", "transactions");
        return OK;
    });

    handle(app, ctx, routes.moveUncategorized, ({ db, body }) => {
        db.transaction(() => categories.moveUncategorized(db, body))();
        // Bookings without a category now belong elsewhere: lists and figures change
        events.changed("categories", "transactions");
        return OK;
    });

    handle(app, ctx, routes.listRules, ({ db }) => rules.listRules(db));

    handle(app, ctx, routes.createRule, ({ db, body }) => {
        // Existing bookings change only once the user confirms the check of a run
        const id = rules.createRule(db, body);
        events.changed("rules");
        return rules.getRule(db, id);
    });

    handle(app, ctx, routes.updateRule, ({ db, params, body }) => {
        rules.updateRule(db, params.id, body);
        events.changed("rules");
        return rules.getRule(db, params.id);
    });

    handle(app, ctx, routes.deleteRule, ({ db, params }) => {
        rules.deleteRule(db, params.id);
        events.changed("rules");
        return OK;
    });

    handle(app, ctx, routes.orderRules, ({ db, body }) => {
        db.transaction(() => rules.orderRules(db, body.ids))();
        events.changed("rules");
        return OK;
    });

    handle(app, ctx, routes.testRule, ({ db, body }) => rules.testRule(db, body));

    handle(app, ctx, routes.previewRules, ({ db, query }) => rules.previewRules(db, query.ruleId, query.mode));

    handle(app, ctx, routes.applyRules, ({ db, actor, body }) => {
        const changed = db.transaction(() => {
            const n = rules.commitRuleRun(db, body);
            // Counts only: rule texts and booking values stay out of the log
            if (n) logActivity(db, actor, "rules_applied", null, `${n} Umsätze`);
            return n;
        })();
        if (changed) events.changed("transactions", "categories", "rules", "activity");
        return { changed };
    });

    // ---------- CSV import ----------

    handle(app, ctx, routes.importPreview, ({ db, params, body }) => imports.previewImport(db, params.id, body.content, { columns: body.columns, format: body.format }));

    handle(app, ctx, routes.importCommit, ({ db, actor, params, body }) => {
        const result = db.transaction(() =>
            imports.commitImport(db, params.id, body.fileName, body.content, { columns: body.columns, format: body.format }, actor.userId, body.createCategories, body.replaceCategoryLines, body.excludeLines),
        )();
        const created = result.createdCategories ? `, ${result.createdCategories} Kategorien angelegt` : "";
        const changed = result.recategorized ? `, ${result.recategorized} Kategorien geändert` : "";
        const categories = result.categoriesFilled ? `, ${result.categoriesFilled} Kategorien ergänzt` : "";
        const filled = result.bookingTextsFilled ? `, ${result.bookingTextsFilled} Umsatzarten ergänzt` : "";
        const details = result.detailsFilled ? `, ${result.detailsFilled} Details ergänzt` : "";
        const excluded = result.excluded ? `, ${result.excluded} abgewählt` : "";
        logActivity(db, actor, "import", accounts.getAccount(db, params.id).name, `${body.fileName}: ${result.imported} neu, ${result.skipped} schon vorhanden${created}${changed}${categories}${filled}${details}${excluded}`);
        events.changed("accounts", "transactions", "categories", "imports", "activity", "unread");
        return result;
    });

    handle(app, ctx, routes.listImports, ({ db }) => imports.listImports(db));

    handle(app, ctx, routes.listImportFormats, ({ db }) => importFormats.listImportFormats(db));

    handle(app, ctx, routes.detectImportFormat, ({ db, body }) => imports.detectImportFormat(db, body.content));

    handle(app, ctx, routes.createImportFormat, ({ db, body }) => {
        const format = importFormats.createImportFormat(db, body);
        events.changed("importFormats");
        return format;
    });

    handle(app, ctx, routes.updateImportFormat, ({ db, params, body }) => {
        const format = importFormats.updateImportFormat(db, params.id, body);
        events.changed("importFormats");
        return format;
    });

    handle(app, ctx, routes.deleteImportFormat, ({ db, params }) => {
        importFormats.deleteImportFormat(db, params.id);
        events.changed("importFormats");
        return OK;
    });

    handle(app, ctx, routes.undoImport, ({ db, actor, params }) => {
        const r = db.transaction(() => imports.undoImport(db, params.id))();
        if (r.removed > 0) logActivity(db, actor, "import_undone", r.fileName, `${r.removed} Buchungen entfernt`);
        else logActivity(db, actor, "import_removed", r.fileName);
        events.changed("accounts", "transactions", "categories", "imports", "activity");
        return OK;
    });
}
