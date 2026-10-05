import { MOBILE_DRAWER_ID } from './constants';

const overlaySelector = `[role="menu"], [role="listbox"], [role="dialog"]:not(#${MOBILE_DRAWER_ID})`;

export function shouldCloseSidebar(event: KeyboardEvent, root: Document): boolean {
  if (event.key !== 'Escape' || event.defaultPrevented) return false;
  // An overlay may already have unmounted by the time Escape reaches the document.
  if (event.composedPath().some((node) => node instanceof Element && node.matches(overlaySelector)))
    return false;
  return !Array.from(root.querySelectorAll(overlaySelector)).some(
    (node) => !node.closest('[hidden], [aria-hidden="true"], [inert]'),
  );
}
