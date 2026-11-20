import type { Migration } from "./index.js";

// The schema of the first version. Before it, the migrations were consolidated into this one
// (last on 2026-11-20); columns keep the order those migrations left them in.
export const initial: Migration = {
    name: "0001-initial",
    up: (db) => {
        db.exec(`
            -- Users and their sessions -------------------------------------------------------

            CREATE TABLE users (
                id INTEGER PRIMARY KEY,
                name TEXT NOT NULL UNIQUE COLLATE NOCASE,
                totp_secret TEXT,              -- sealed with the field key
                totp_last_step INTEGER,
                created_at TEXT NOT NULL,
                last_login_at TEXT,
                sealed_user_key TEXT           -- user key (seals bank logins), sealed with the password (scrypt)
            );

            CREATE TABLE devices (
                id INTEGER PRIMARY KEY,
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                name TEXT NOT NULL,
                kind TEXT NOT NULL CHECK (kind IN ('web', 'device')),
                token_hash TEXT NOT NULL UNIQUE,
                created_at TEXT NOT NULL,
                last_seen_at TEXT,
                revoked_at TEXT,
                idle_locked_at TEXT,           -- set while the session is locked after inactivity
                sealed_user_key TEXT,          -- user key, sealed per session with its token (HKDF)
                password_at TEXT               -- last password entry; a transfer asks again after a while
            );

            CREATE TABLE user_settings (
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                scope TEXT NOT NULL CHECK (scope IN ('all', 'web', 'macos')),
                key TEXT NOT NULL,
                value TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                PRIMARY KEY (user_id, scope, key)
            );

            CREATE TABLE dashboard_cards (
                id INTEGER PRIMARY KEY,
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                position INTEGER NOT NULL,
                type TEXT NOT NULL,
                width INTEGER NOT NULL CHECK (width BETWEEN 1 AND 12),    -- columns of a 12-column grid
                height INTEGER CHECK (height IS NULL OR height BETWEEN 2 AND 12),  -- rows; empty follows the content
                title TEXT,
                config TEXT NOT NULL
            );

            -- Accounts ---------------------------------------------------------------------------

            CREATE TABLE account_groups (
                id INTEGER PRIMARY KEY,
                parent_id INTEGER REFERENCES account_groups(id) ON DELETE SET NULL,
                name TEXT NOT NULL,
                icon TEXT NOT NULL,
                color TEXT NOT NULL,
                position INTEGER NOT NULL,
                info_attributes TEXT NOT NULL DEFAULT '[]',  -- JSON: [{ key, value }]
                info_notes TEXT NOT NULL DEFAULT ''
            );

            CREATE TABLE accounts (
                id INTEGER PRIMARY KEY,
                connection_id INTEGER,          -- bank connection; empty for offline accounts
                external_id TEXT,
                iban TEXT,
                bic TEXT,
                card_number TEXT,               -- credit cards: full card number, shown instead of the IBAN
                name TEXT NOT NULL,
                currency TEXT NOT NULL DEFAULT 'EUR',
                kind TEXT NOT NULL CHECK (kind IN ('giro', 'savings', 'credit_card', 'loan', 'offline')),
                reference_account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
                group_id INTEGER REFERENCES account_groups(id) ON DELETE SET NULL,
                icon TEXT NOT NULL,
                color TEXT NOT NULL,
                position INTEGER NOT NULL,
                hidden INTEGER NOT NULL DEFAULT 0,
                opening_balance INTEGER,
                created_at TEXT NOT NULL,
                info_attributes TEXT NOT NULL DEFAULT '[]',  -- JSON: [{ key, value }]
                info_notes TEXT NOT NULL DEFAULT '',
                orders_fetched_at TEXT          -- last successful fetch of the account's orders; NULL: never
            );
            CREATE UNIQUE INDEX accounts_external ON accounts (connection_id, external_id) WHERE connection_id IS NOT NULL;

            -- Bookings -----------------------------------------------------------------------------

            CREATE TABLE imports (
                id INTEGER PRIMARY KEY,
                account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
                file_name TEXT NOT NULL,
                imported_at TEXT NOT NULL,
                user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
                rows INTEGER NOT NULL,
                imported INTEGER NOT NULL,
                skipped INTEGER NOT NULL,
                column_map TEXT NOT NULL
            );

            -- AUTOINCREMENT: booking ids are never handed out again. Otherwise SQLite reuses the ids
            -- of deleted rows, and a fetch replaces all pending bookings: a client still holding such
            -- an id (an open detail view, a cached list) would meet a different booking under it.
            CREATE TABLE transactions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
                fingerprint TEXT,
                booking_date TEXT NOT NULL,
                value_date TEXT,
                amount INTEGER NOT NULL,
                currency TEXT NOT NULL DEFAULT 'EUR',
                counterparty_name TEXT NOT NULL DEFAULT '',
                counterparty_iban TEXT,
                remittance TEXT NOT NULL DEFAULT '',
                end_to_end_id TEXT,
                status TEXT NOT NULL CHECK (status IN ('booked', 'pending')),
                raw TEXT,
                first_seen_at TEXT NOT NULL,
                source TEXT NOT NULL CHECK (source IN ('bank', 'manual', 'import')),
                import_id INTEGER REFERENCES imports(id) ON DELETE SET NULL,
                counter_transaction_id INTEGER REFERENCES transactions(id) ON DELETE SET NULL,
                created_by INTEGER REFERENCES users(id) ON DELETE SET NULL
            );
            CREATE INDEX transactions_account_date ON transactions (account_id, booking_date);
            CREATE INDEX transactions_date ON transactions (booking_date);
            CREATE INDEX transactions_import ON transactions (import_id);

            -- Categories ---------------------------------------------------------------------------

            CREATE TABLE categories (
                id INTEGER PRIMARY KEY,
                parent_id INTEGER REFERENCES categories(id) ON DELETE CASCADE,
                name TEXT NOT NULL,
                icon TEXT NOT NULL,
                color TEXT,
                position INTEGER NOT NULL,
                excluded_from_stats INTEGER NOT NULL DEFAULT 0,
                counter_default INTEGER NOT NULL DEFAULT 0,   -- preset category of counter bookings
                info_attributes TEXT NOT NULL DEFAULT '[]',   -- JSON: [{ key, value }]
                info_notes TEXT NOT NULL DEFAULT ''
            );

            -- Where "Ohne Kategorie" sits in the category tree: below parent_id (NULL = top level),
            -- at position among its siblings (NULL = last). At most one row; none means top level, last.
            CREATE TABLE uncategorized_slot (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                parent_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
                position INTEGER
            );

            CREATE TABLE category_rules (
                id INTEGER PRIMARY KEY,
                query TEXT NOT NULL,            -- search syntax of the transaction list
                category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
                position INTEGER NOT NULL,
                active INTEGER NOT NULL DEFAULT 1,
                created_at TEXT NOT NULL
            );

            -- One row per share of a booking, so split bookings need no rebuild later.
            -- Until then every booking has at most one row with the full amount.
            CREATE TABLE transaction_categories (
                transaction_id INTEGER NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
                category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
                amount INTEGER NOT NULL,
                source TEXT NOT NULL CHECK (source IN ('rule', 'manual', 'auto')),
                rule_id INTEGER REFERENCES category_rules(id) ON DELETE SET NULL,
                PRIMARY KEY (transaction_id, category_id)
            );
            CREATE INDEX transaction_categories_category ON transaction_categories (category_id);

            CREATE TABLE activity_log (
                id INTEGER PRIMARY KEY,
                created_at TEXT NOT NULL,
                user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
                user_name TEXT,                 -- kept when the user is removed
                device_id INTEGER REFERENCES devices(id) ON DELETE SET NULL,
                action TEXT NOT NULL,
                target TEXT,
                details TEXT
            );

            -- Bank accesses: shared bank connections, one login per user and connection, which
            -- login reaches which account, balances and fetch runs ------------------------------

            CREATE TABLE bank_connections (
                id INTEGER PRIMARY KEY,
                name TEXT NOT NULL,
                connector TEXT NOT NULL DEFAULT 'fints',
                bank_name TEXT NOT NULL,
                blz TEXT NOT NULL,
                bic TEXT,
                fints_url TEXT NOT NULL,
                icon TEXT NOT NULL,
                color TEXT NOT NULL,
                created_at TEXT NOT NULL,
                UNIQUE (blz, fints_url)
            );

            CREATE TABLE bank_logins (
                id INTEGER PRIMARY KEY,
                connection_id INTEGER NOT NULL REFERENCES bank_connections(id) ON DELETE CASCADE,
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                login_hint TEXT NOT NULL,             -- e.g. "••••7731", shown instead of the login name
                sealed_credentials TEXT,              -- JSON { userId, customerId, pin }, sealed with the user key
                sealed_connector_state TEXT,          -- connector state, sealed with the user key
                save_pin INTEGER NOT NULL DEFAULT 1,  -- 0: the PIN is asked for at every fetch
                tan_method TEXT,
                tan_method_name TEXT,
                tan_medium TEXT,
                status TEXT NOT NULL DEFAULT 'setup'
                    CHECK (status IN ('setup', 'ready', 'credentials_lost', 'pin_wrong', 'error')),
                last_sync_at TEXT,
                last_error TEXT,
                created_at TEXT NOT NULL,
                UNIQUE (connection_id, user_id)
            );

            -- What a login may do per account
            CREATE TABLE bank_login_accounts (
                login_id INTEGER NOT NULL REFERENCES bank_logins(id) ON DELETE CASCADE,
                account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
                account_ref TEXT NOT NULL,            -- JSON: how the connector addresses the account
                allowed_operations TEXT NOT NULL,     -- JSON: capabilities the bank reports for this login
                last_seen_at TEXT,
                missing_since TEXT,
                PRIMARY KEY (login_id, account_id)
            );

            -- Accounts the bank reports that stay out of MBM: not taken over when offered, or
            -- detached from their bank access. A fetch no longer reports them as new.
            CREATE TABLE bank_ignored_accounts (
                connection_id INTEGER NOT NULL REFERENCES bank_connections(id) ON DELETE CASCADE,
                external_id TEXT NOT NULL,
                created_at TEXT NOT NULL,
                PRIMARY KEY (connection_id, external_id)
            );

            CREATE TABLE balances (
                account_id INTEGER PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
                amount INTEGER NOT NULL,
                currency TEXT NOT NULL,
                booked_at TEXT,
                pending INTEGER,
                available INTEGER,
                credit_line INTEGER,
                fetched_at TEXT NOT NULL
            );

            CREATE TABLE sync_runs (
                id INTEGER PRIMARY KEY,
                connection_id INTEGER REFERENCES bank_connections(id) ON DELETE CASCADE,
                login_id INTEGER REFERENCES bank_logins(id) ON DELETE SET NULL,
                user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
                account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL,  -- empty: whole access
                started_at TEXT NOT NULL,
                finished_at TEXT,
                trigger TEXT NOT NULL,
                result TEXT,
                new_transactions INTEGER NOT NULL DEFAULT 0,
                details TEXT
            );

            -- Orders: standing orders and scheduled transfers as the bank holds them. Every fetch
            -- replaces the orders of an account; nothing here is edited locally -----------------

            CREATE TABLE standing_orders (
                id INTEGER PRIMARY KEY,
                account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
                bank_order_id TEXT,
                payee_name TEXT NOT NULL,
                payee_iban TEXT NOT NULL,
                payee_bic TEXT,
                amount INTEGER NOT NULL,              -- cents, not negative
                remittance TEXT NOT NULL,
                unit TEXT NOT NULL CHECK (unit IN ('month', 'week')),
                every INTEGER NOT NULL,               -- every n months or weeks
                execution_day INTEGER NOT NULL,       -- month: 1–30, 97–99 counted from the end; week: 1 (Monday) – 7
                first_date TEXT NOT NULL,
                last_date TEXT,
                can_change INTEGER,                   -- NULL: the bank does not say
                can_delete INTEGER,
                fetched_at TEXT NOT NULL
            );
            CREATE INDEX standing_orders_account ON standing_orders(account_id);

            CREATE TABLE scheduled_transfers (
                id INTEGER PRIMARY KEY,
                account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
                bank_order_id TEXT,
                payee_name TEXT NOT NULL,
                payee_iban TEXT NOT NULL,
                payee_bic TEXT,
                amount INTEGER NOT NULL,
                remittance TEXT NOT NULL,
                execution_date TEXT NOT NULL,
                can_change INTEGER,
                can_delete INTEGER,
                fetched_at TEXT NOT NULL
            );
            CREATE INDEX scheduled_transfers_account ON scheduled_transfers(account_id);

            -- Transfers with their state (see services/transfers.ts) and the list of payees -----

            CREATE TABLE transfers (
                id INTEGER PRIMARY KEY,
                request_id TEXT NOT NULL UNIQUE,         -- from the client: a second request with it is the same transfer
                account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
                login_id INTEGER REFERENCES bank_logins(id) ON DELETE SET NULL,
                created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
                created_by_name TEXT NOT NULL,
                payee_name TEXT NOT NULL,
                payee_iban TEXT NOT NULL,
                payee_bic TEXT,
                amount INTEGER NOT NULL,                  -- cents, more than 0
                remittance TEXT NOT NULL,
                end_to_end_id TEXT NOT NULL UNIQUE,
                instant INTEGER NOT NULL DEFAULT 0,
                execution TEXT NOT NULL DEFAULT 'now' CHECK (execution IN ('now', 'date', 'standing')),
                status TEXT NOT NULL CHECK (status IN ('submitting', 'awaiting_vop_confirm', 'awaiting_tan', 'executed', 'rejected', 'failed', 'cancelled', 'unknown')),
                vop_result TEXT,
                vop_name TEXT,                            -- the name the payee's bank holds (close match)
                vop_reason TEXT,
                vop_text TEXT,                            -- the bank's explanation
                vop_structured INTEGER NOT NULL DEFAULT 0,
                bank_message TEXT,
                bank_reference TEXT,
                unconfirmed INTEGER NOT NULL DEFAULT 0,   -- instant: arrival not confirmed yet
                transaction_id INTEGER REFERENCES transactions(id) ON DELETE SET NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                finished_at TEXT
            );
            CREATE INDEX transfers_account ON transfers(account_id);
            CREATE INDEX transfers_created ON transfers(created_at);

            CREATE TABLE payees (
                id INTEGER PRIMARY KEY,
                name TEXT NOT NULL,
                iban TEXT NOT NULL UNIQUE,
                bic TEXT,
                last_used_at TEXT,
                created_at TEXT NOT NULL
            );
        `);
    },
};
