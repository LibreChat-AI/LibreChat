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
