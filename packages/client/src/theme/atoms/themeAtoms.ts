// This file is kept for backward compatibility but is no longer used internally.
// Theme state is now managed via React useState + localStorage in ThemeProvider.

import { WritableAtom } from 'jotai';
import { atomWithStorage, RESET } from 'jotai/utils';
import { IThemeRGB } from '../types';

/**
 * @deprecated Use ThemeContext instead. This atom is no longer used internally.
 */
export const themeModeAtom: WritableAtom<
  string,
  [string | typeof RESET | ((prev: string) => string | typeof RESET)],
  void
> = atomWithStorage<string>('color-theme', 'system', undefined, {
  getOnInit: true,
});

/**
 * @deprecated Use ThemeContext instead. This atom is no longer used internally.
 */
export const themeColorsAtom: WritableAtom<
  IThemeRGB | undefined,
  [
    | IThemeRGB
    | typeof RESET
    | ((prev: IThemeRGB | undefined) => IThemeRGB | typeof RESET | undefined)
    | undefined,
  ],
  void
> = atomWithStorage<IThemeRGB | undefined>('theme-colors', undefined, undefined, {
  getOnInit: true,
});

/**
 * @deprecated Use ThemeContext instead. This atom is no longer used internally.
 */
export const themeNameAtom: WritableAtom<
  string | undefined,
  [
    | string
    | typeof RESET
    | ((prev: string | undefined) => string | typeof RESET | undefined)
    | undefined,
  ],
  void
> = atomWithStorage<string | undefined>('theme-name', undefined, undefined, {
  getOnInit: true,
});
