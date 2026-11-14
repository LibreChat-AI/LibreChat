import type { NavLink } from '~/common';

const AGENTS_ROUTE = /^\/agents(\/|$)/;

/**
 * The sidebar's selected panel outlives navigation, so memories opened in a chat would otherwise
 * stay beside the agents list. Memories belong to the chat context. The selection itself is left
 * alone, which reopens the panel on the way back to the chat.
 */
export function getRoutePanelLinks(pathname: string, links: NavLink[]): NavLink[] {
  return AGENTS_ROUTE.test(pathname) ? links.filter((link) => link.id !== 'memories') : links;
}
