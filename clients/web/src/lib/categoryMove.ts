// Moving rows of the category tree. Indexes count "Ohne Kategorie" among the new siblings; the
// server keeps it between its neighbours when categories around it change.

import { routes } from "@mbm/shared";
import { call } from "./api";
import { useAction } from "./queries";

export function useCategoryMove() {
    const action = useAction();
    return {
        category: (id: number, parentId: number | null, index: number) =>
            action.run(() => call(routes.moveCategory, { body: { id, parentId, index } }), { topics: ["categories"] }),
        /** Bookings without a category then belong to the new parent: lists and figures change. */
        none: (parentId: number | null, index: number) =>
            action.run(() => call(routes.moveUncategorized, { body: { parentId, index } }), { topics: ["categories", "transactions"] }),
    };
}
