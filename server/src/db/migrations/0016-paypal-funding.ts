import type { Migration } from "./index.js";

// PayPal reports a payment, not where its money came from. MBM adds that booking itself (a debit
// from bank account or card, or the credit of "Pay in 30 days"), pointing to the payment with
// funding_of_id; it goes when the payment goes.
// accounts.refetch_all: the next fetch of the account reaches back as far as the bank allows, once.
// PayPal accounts get it, so that the bookings already stored get the marks the connector now sends
// (repayment, payout, refund of a rejected payment); a fingerprint keeps them from coming twice.
export const paypalFunding: Migration = {
    name: "0016-paypal-funding",
    up: (db) => {
        db.exec(`
            ALTER TABLE transactions ADD COLUMN funding_of_id INTEGER REFERENCES transactions(id) ON DELETE CASCADE;
            CREATE INDEX transactions_funding_of ON transactions (funding_of_id);
            ALTER TABLE accounts ADD COLUMN refetch_all INTEGER NOT NULL DEFAULT 0 CHECK (refetch_all IN (0, 1));
            UPDATE accounts SET refetch_all = 1
             WHERE connection_id IN (SELECT id FROM bank_connections WHERE connector = 'enablebanking' AND lower(aspsp) = 'paypal');
        `);
    },
};
