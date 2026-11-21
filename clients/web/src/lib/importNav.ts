// Opens the import page from places without a router hook (menus). The router registers itself
// here, so this file does not import it and the pages can use it without a cycle.

let go: ((accountId?: number) => void) | null = null;

export function registerImportNavigation(navigate: (accountId?: number) => void): void {
    go = navigate;
}

export const openImport = (accountId?: number): void => go?.(accountId);
