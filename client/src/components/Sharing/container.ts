import { createContext } from 'react';

/**
 * The element a role menu portals into, so it stays inside a modal dialog's focus trap yet is not
 * clipped by the dialog's own scroll area. Null outside such a dialog, where the menu stays in place.
 */
export const MenuContainerContext = createContext<HTMLElement | null>(null);
