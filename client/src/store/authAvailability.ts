import { atom } from 'jotai';

/** Set when the last session check could not be confirmed (503/5xx/network on refresh); the
 *  account must not be treated as logged out and the app must not render as if it were. */
export const authSessionUnavailableAtom = atom<boolean>(false);
