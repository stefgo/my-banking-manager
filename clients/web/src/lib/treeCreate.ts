// Adding a group or category opens its name for editing at once, like a new folder in the Finder.

import { routes } from "@mbm/shared";
import { call } from "./api";
import type { useAction } from "./queries";
import { readLocalSetting, writeLocalSetting } from "./localSettings";
import { ui } from "./ui";

type Action = ReturnType<typeof useAction>;

/** Adds a group below `parentId` (null: top level), unfolds the parent and starts renaming. */
export async function createGroupAndRename(action: Action, parentId: number | null): Promise<void> {
    const g = await action.run(() => call(routes.createGroup, { body: { name: "Neue Gruppe", parentId } }), { topics: ["groups"] });
    if (!g) return;
    if (parentId !== null) writeLocalSetting("collapsedGroups", readLocalSetting("collapsedGroups").filter((id) => id !== parentId));
    ui.setEditing("acc", true);
    ui.setRenaming(`group:${g.id}`);
}

/** Adds a category below `parentId` (null: top level), unfolds the parent and starts renaming. */
export async function createCategoryAndRename(action: Action, parentId: number | null): Promise<void> {
    const name = parentId === null ? "Neue Kategorie" : "Neue Unterkategorie";
    const c = await action.run(() => call(routes.createCategory, { body: { name, parentId } }), { topics: ["categories"] });
    if (!c) return;
    if (parentId !== null) {
        const open = readLocalSetting("expandedCategories");
        if (!open.includes(parentId)) writeLocalSetting("expandedCategories", [...open, parentId]);
    }
    ui.setEditing("cat", true);
    ui.setRenaming(`category:${c.id}`);
}
