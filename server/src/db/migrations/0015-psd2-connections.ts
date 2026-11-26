import type { Migration } from "./index.js";

// Bank accesses over PSD2 (connector "enablebanking"): a bank as Enable Banking names it (aspsp and
// country) instead of bank code and FinTS address, and per login when its approval at the bank ends.
// - bank_connections: columns aspsp and country, empty for FinTS. The bank is unique per kind:
//   FinTS by bank code and address, PSD2 by aspsp and country (before: UNIQUE (blz, fints_url)).
// - bank_logins: status consent_needed (approval missing, ended or revoked) and consent_until.
// Both tables are rebuilt for that; the columns keep their order, ids and links stay.
export const psd2Connections: Migration = {
    name: "0015-psd2-connections",
    foreignKeysOff: true,
    up: (db) => {
        db.exec(`
            CREATE TABLE bank_connections_new (
                id INTEGER PRIMARY KEY,
                name TEXT NOT NULL,
                connector TEXT NOT NULL DEFAULT 'fints' CHECK (connector IN ('fints', 'enablebanking')),
                bank_name TEXT NOT NULL,
                blz TEXT NOT NULL,                  -- FinTS; empty for PSD2
                bic TEXT,
                fints_url TEXT NOT NULL,            -- FinTS; empty for PSD2
                icon TEXT NOT NULL,
                color TEXT NOT NULL,
                created_at TEXT NOT NULL,
                aspsp TEXT NOT NULL DEFAULT '',     -- PSD2: the bank as Enable Banking names it; empty for FinTS
                country TEXT NOT NULL DEFAULT '',   -- PSD2: its country (DE, …); empty for FinTS
                CHECK ((connector = 'fints') = (aspsp = '' AND country = '')),
                CHECK ((connector = 'fints') = (blz <> '' AND fints_url <> ''))
            );
            INSERT INTO bank_connections_new (id, name, connector, bank_name, blz, bic, fints_url, icon, color, created_at)
                SELECT id, name, connector, bank_name, blz, bic, fints_url, icon, color, created_at FROM bank_connections;
            DROP TABLE bank_connections;
            ALTER TABLE bank_connections_new RENAME TO bank_connections;
            CREATE UNIQUE INDEX bank_connections_fints ON bank_connections (blz, fints_url) WHERE connector = 'fints';
            CREATE UNIQUE INDEX bank_connections_psd2 ON bank_connections (aspsp, country) WHERE connector = 'enablebanking';

            CREATE TABLE bank_logins_new (
                id INTEGER PRIMARY KEY,
                connection_id INTEGER NOT NULL REFERENCES bank_connections(id) ON DELETE CASCADE,
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                login_hint TEXT NOT NULL,             -- e.g. "••••7731", shown instead of the login name
                sealed_credentials TEXT,              -- FinTS: JSON { loginName, customerId, pin }; PSD2: JSON { applicationId, privateKey }; sealed with the user key
                sealed_connector_state TEXT,          -- connector state, sealed with the user key
                save_pin INTEGER NOT NULL DEFAULT 1,  -- 0: the PIN is asked for at every fetch
                tan_method TEXT,
                tan_method_name TEXT,
                tan_medium TEXT,
                status TEXT NOT NULL DEFAULT 'setup'
                    CHECK (status IN ('setup', 'ready', 'credentials_lost', 'pin_wrong', 'error', 'consent_needed')),
                last_sync_at TEXT,
                last_error TEXT,
                created_at TEXT NOT NULL,
                consent_until TEXT,                   -- PSD2: when the approval at the bank ends; NULL for FinTS and before the first approval
                UNIQUE (connection_id, user_id)
            );
            INSERT INTO bank_logins_new (id, connection_id, user_id, login_hint, sealed_credentials, sealed_connector_state, save_pin, tan_method, tan_method_name, tan_medium, status, last_sync_at, last_error, created_at)
                SELECT id, connection_id, user_id, login_hint, sealed_credentials, sealed_connector_state, save_pin, tan_method, tan_method_name, tan_medium, status, last_sync_at, last_error, created_at FROM bank_logins;
            DROP TABLE bank_logins;
            ALTER TABLE bank_logins_new RENAME TO bank_logins;
        `);
    },
};
