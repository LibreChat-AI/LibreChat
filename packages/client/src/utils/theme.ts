import { invalidateRemScale } from './remScale';

/**
 * The disabled appearance a `fill` theme paints (`disabledStyle: 'fill'`): the
 * disabled fill, ink, placeholder and edge at full opacity. Every shared control
 * composes it beside its own `disabled:opacity-*`, which stays the default `dim`
 * treatment, so a theme's choice reaches every primitive at once. The hover pair
 * outranks a control's own `disabled:hover:*` reset, and descendants that own
 * their ink (a label, a glyph) take the disabled ink too.
 */
export const disabledFillClasses =
  'theme-disabled:border-border-disabled theme-disabled:bg-surface-disabled theme-disabled:text-text-disabled theme-disabled:placeholder:text-text-disabled theme-disabled:opacity-100 theme-disabled:hover:bg-surface-disabled theme-disabled:hover:text-text-disabled theme-disabled:[&_*]:text-text-disabled';

/**
 * The disabled ink alone, for a menu item, tab or row whose surface stays as it
 * is while disabled (Click UI's `genericMenu.item.color.*.disabled` keeps the
 * item's background and grays its text, icons included, since a row's icon
 * often owns its own color), and for a label that follows its control through
 * `peer`.
 */
export const disabledInkClasses =
  'theme-disabled:text-text-disabled theme-disabled:opacity-100 theme-disabled:[&_*]:text-text-disabled';
export const peerDisabledInkClasses =
  'peer-theme-disabled:text-text-disabled peer-theme-disabled:opacity-100 peer-theme-disabled:[&_svg]:text-text-disabled';

/** The same recipe for a wrapper around the disabled control rather than the control itself; the
 *  control inherits the ink and shows the fill through its transparent background, and the
 *  wrapper's own parts (OTP slots) take the disabled edge and ink. */
export const disabledWithinFillClasses =
  'theme-disabled-within:border-border-disabled theme-disabled-within:bg-surface-disabled theme-disabled-within:text-text-disabled theme-disabled-within:opacity-100 theme-disabled-within:[&_*]:border-border-disabled theme-disabled-within:[&_*]:text-text-disabled';

export const MIN_UI_SCALE = 0.5;
export const MAX_UI_SCALE = 1.5;
export const DEFAULT_UI_SCALE = 1;

const BASE_FONT_SIZE = 16;

/**
 * Expresses a pixel measurement in rem so elements sized from JavaScript follow
 * the UI scale. A fixed pixel size in a scaled layout gets squeezed by its flex
 * container, which distorts avatars and icons.
 */
export const pxToRem = (px: number): string => `${px / BASE_FONT_SIZE}rem`;

/**
 * Guards every consumer of the stored preference: a corrupted value must not be
 * able to render the app unusable, nor reach layout maths as NaN.
 */
export const clampUiScale = (scale: number): number => {
  if (typeof scale !== 'number' || !Number.isFinite(scale)) {
    return DEFAULT_UI_SCALE;
  }
  return Math.min(MAX_UI_SCALE, Math.max(MIN_UI_SCALE, scale));
};

/**
 * Scales the entire interface by driving the `--ui-scale` custom property, which
 * `style.css` feeds to the root font size.
 */
export const applyUiScale = (scale: number): void => {
  document.documentElement.style.setProperty('--ui-scale', String(clampUiScale(scale)));
  invalidateRemScale();
};

export const applyFontSize = (val: string): void => {
  const root = document.documentElement;
  const size = val.split('-')[1]; // This will be 'xs', 'sm', 'base', 'lg', or 'xl'

  switch (size) {
    case 'xs':
      root.style.setProperty('--markdown-font-size', '0.75rem'); // 12px
      break;
    case 'sm':
      root.style.setProperty('--markdown-font-size', '0.875rem'); // 14px
      break;
    case 'base':
      root.style.setProperty('--markdown-font-size', '1rem'); // 16px
      break;
    case 'lg':
      root.style.setProperty('--markdown-font-size', '1.125rem'); // 18px
      break;
    case 'xl':
      root.style.setProperty('--markdown-font-size', '1.25rem'); // 20px
      break;
  }
};

export const getInitialTheme = (): string => {
  if (typeof window !== 'undefined' && window.localStorage) {
    const storedPrefs = window.localStorage.getItem('color-theme');
    if (typeof storedPrefs === 'string') {
      return storedPrefs;
    }

    const userMedia = window.matchMedia('(prefers-color-scheme: dark)');
    if (userMedia.matches) {
      return 'dark';
    }
  }

  return 'light';
};
