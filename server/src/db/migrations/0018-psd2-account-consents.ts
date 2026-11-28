import type { Migration } from "./index.js";

// A PSD2 access may hold several approvals of one user at the bank (PayPal: one per PayPal account),
// each with its own end.
// - bank_login_accounts.consent_until: when the approval that reaches the account ends; NULL for
//   FinTS and for links made before. bank_logins.consent_until is now the end of the last approval.
export const psd2AccountConsents: Migration = {
    name: "0018-psd2-account-consents",
    up: (db) => {
        db.exec(`ALTER TABLE bank_login_accounts ADD COLUMN consent_until TEXT;`);
    },
};
