import { atom } from 'jotai';

/**
 * Bumped by `useNavigateToConvo` every time it starts a navigation —
 * `navigateToConvo` itself and `supersedeNavigation`. A component with its
 * own cancellation guard (keyed on a saved chat's id or a draft's composer
 * token) subscribes to this value so a navigation that has only just
 * started, before the target conversation commits, also cancels a pending
 * continuation.
 */
export const navigationGenerationAtom = atom(0);
