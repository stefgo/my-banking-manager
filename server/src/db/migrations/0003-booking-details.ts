import type { Migration } from "./index.js";

// Booking text and ultimate party (e.g. the shop of a card payment) of bank bookings as columns.
// Bookings fetched before stay without them.
export const bookingDetails: Migration = {
    name: "0003-booking-details",
    up: (db) => {
        db.exec(`
            ALTER TABLE transactions ADD COLUMN booking_text TEXT NOT NULL DEFAULT '';
            ALTER TABLE transactions ADD COLUMN ultimate_party TEXT NOT NULL DEFAULT '';
        `);
    },
};
