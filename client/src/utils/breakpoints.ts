/** Viewport width, in baseline pixels, below which navigation becomes the drawer. */
export const DRAWER_MAX_WIDTH = 768;

/**
 * Below this artifacts render as a fixed sheet rather than a resizable panel. Every
 * layout owner reads this one value: `Artifacts` positions itself, while its two hosts
 * decide whether to reserve a panel for it, so a threshold they did not share left the
 * conversation squeezed beside an empty panel with the sheet overlaying the viewport.
 */
export const ARTIFACTS_SHEET_MAX_WIDTH = 868;

const BASE_FONT_SIZE = 16;

/**
 * Deliberately not `getRemScale` from `@librechat/client`: this module is pulled in by
 * `~/store`, which nearly every suite loads, and many of them replace that package with
 * a partial mock. React consumers go through `useDrawerViewport`, which does use the
 * shared hook.
 */
const readRemScale = (): number => {
  if (typeof document === 'undefined' || typeof getComputedStyle !== 'function') {
    return 1;
  }
  const rootFontSize = parseFloat(getComputedStyle(document.documentElement).fontSize);
  return Number.isFinite(rootFontSize) && rootFontSize > 0 ? rootFontSize / BASE_FONT_SIZE : 1;
};

/**
 * Layouts here are sized in rem, so a breakpoint has to compare the viewport in the same
 * units. Every consumer of a given breakpoint builds its query from here: a hook that
 * owns a layout's state and the controls that reveal its affordances have to agree, or a
 * viewport between the fixed and scaled breakpoints picks the wide layout while its
 * rem-sized contents no longer fit the space that layout gives them.
 */
export const scaledMaxWidthQuery = (baselinePx: number, remScale: number): string =>
  `(max-width: ${baselinePx * remScale}px)`;

export const drawerMediaQuery = (remScale: number): string =>
  scaledMaxWidthQuery(DRAWER_MAX_WIDTH, remScale);

/** Read synchronously where a hook cannot run: `useMediaQuery` only resolves after paint. */
export const isDrawerViewport = (): boolean =>
  typeof window !== 'undefined' && window.matchMedia(drawerMediaQuery(readRemScale())).matches;
