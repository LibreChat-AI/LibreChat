/**
 * Defines the color channels. Passed to the context from each app.
 * RGB values should be in format "255 255 255" (space-separated)
 */
export interface IThemeRGB {
  // Text colors
  'rgb-text-primary'?: string;
  'rgb-text-secondary'?: string;
  'rgb-text-secondary-alt'?: string;
  'rgb-text-tertiary'?: string;
  'rgb-text-muted'?: string;
  'rgb-text-warning'?: string;
  'rgb-text-destructive'?: string;
  /** Bright and dipped stops of the in-flight label sweep (`.shimmer`). Their
   *  opacities stay in CSS as `--shimmer-*-alpha`, the way the border roles
   *  keep `--border-*-alpha`. */
  'rgb-shimmer-base'?: string;
  'rgb-shimmer-dip'?: string;

  // Link and accent colors
  'rgb-link'?: string;
  'rgb-link-hover'?: string;
  'rgb-link-visited'?: string;
  'rgb-accent-primary'?: string;
  'rgb-accent-primary-hover'?: string;

  // Ring colors
  'rgb-ring-primary'?: string;

  // Header colors
  'rgb-header-primary'?: string;
  'rgb-header-hover'?: string;
  'rgb-header-button-hover'?: string;

  // Surface colors
  'rgb-surface-active'?: string;
  'rgb-surface-active-alt'?: string;
  'rgb-surface-hover'?: string;
  'rgb-surface-hover-alt'?: string;
  'rgb-surface-composer-hover'?: string;
  'rgb-surface-primary'?: string;
  'rgb-chart-widget-surface'?: string;
  'rgb-chart-widget-stroke'?: string;
  'rgb-surface-primary-alt'?: string;
  'rgb-surface-primary-contrast'?: string;
  'rgb-surface-secondary'?: string;
  'rgb-surface-secondary-alt'?: string;
  'rgb-surface-tertiary'?: string;
  'rgb-surface-tertiary-alt'?: string;
  'rgb-surface-dialog'?: string;
  'rgb-surface-overlay'?: string;
  'rgb-surface-submit'?: string;
  'rgb-surface-submit-hover'?: string;
  'rgb-surface-destructive'?: string;
  'rgb-surface-destructive-hover'?: string;
  'rgb-surface-chat'?: string;
  'rgb-surface-code'?: string;
  'rgb-surface-inverted'?: string;
  'rgb-surface-inverted-hover'?: string;
  'rgb-text-inverted'?: string;
  'rgb-surface-fixed'?: string;
  'rgb-surface-fixed-hover'?: string;
  'rgb-text-fixed'?: string;

  // Border colors
  'rgb-border-light'?: string;
  'rgb-border-medium'?: string;
  'rgb-border-medium-alt'?: string;
  'rgb-border-heavy'?: string;
  'rgb-border-xheavy'?: string;
  'rgb-border-destructive'?: string;

  // Status colors
  'rgb-status-success'?: string;
  'rgb-status-success-subtle'?: string;
  'rgb-status-success-border'?: string;
  'rgb-status-success-strong'?: string;
  'rgb-status-info'?: string;
  'rgb-status-info-subtle'?: string;
  'rgb-status-info-border'?: string;
  'rgb-status-info-strong'?: string;
  'rgb-status-warning'?: string;
  'rgb-status-warning-subtle'?: string;
  'rgb-status-warning-border'?: string;
  'rgb-status-warning-strong'?: string;
  'rgb-status-error'?: string;
  'rgb-status-error-subtle'?: string;
  'rgb-status-error-border'?: string;
  'rgb-status-error-strong'?: string;
  'rgb-status-neutral'?: string;
  'rgb-status-neutral-subtle'?: string;
  'rgb-status-neutral-border'?: string;
  /**
   * Solid fill of the verified mark — the badge a first-party item carries next
   * to its name. The one status with no family around it: the mark is the only
   * thing it paints, so there is no subtle fill, border or text weight to go
   * with it. Blue rather than a reuse of `status-success-strong`, because a
   * green check is the selected/complete cue everywhere else in the product
   * (including the selected-tool check on the very same card) while blue is the
   * cross-product convention for provenance. It carries `text-on-status`.
   * A theme that repaints the mark's surroundings — the old
   * `status-success-strong` fill, the check, or the card surfaces — keeps the
   * mark on that success fill, which is what it wore before this token existed.
   */
  'rgb-status-verified'?: string;
  'rgb-text-on-status'?: string;

  // Brand colors
  'rgb-brand-purple'?: string;

  /**
   * Code syntax highlighting. Declared here rather than left as literals in the
   * stylesheet so a palette stays in one place, is covered by the registry's
   * completeness check, and can be contrast-tested.
   */
  'rgb-syntax-text'?: string;
  'rgb-syntax-comment'?: string;
  'rgb-syntax-meta'?: string;
  'rgb-syntax-builtin'?: string;
  'rgb-syntax-keyword'?: string;
  'rgb-syntax-string'?: string;
  'rgb-syntax-attr'?: string;
  'rgb-syntax-title'?: string;

  /**
   * Categorical data-visualisation scale. Slots carry series identity only — the
   * order is the colour-vision-deficiency safety mechanism and must not be
   * reshuffled. Reserved status colors never appear here.
   */
  'rgb-series-1'?: string;
  'rgb-series-2'?: string;
  'rgb-series-3'?: string;
  'rgb-series-4'?: string;
  'rgb-series-5'?: string;
  'rgb-series-6'?: string;
  'rgb-series-7'?: string;
  'rgb-series-8'?: string;

  /**
   * Unchecked track of the shared `Switch`. A control state rather than a
   * palette entry, but it lives here because the package's own control renders
   * it: left in the application stylesheet, a consumer of `@librechat/client`
   * got a switch with no track at all.
   */
  'rgb-switch-unchecked'?: string;

  // Presentation
  'rgb-presentation'?: string;
}

/**
 * Name of the CSS variables used in tailwind.config
 */
export interface IThemeVariables {
  '--text-primary': string;
  '--text-secondary': string;
  '--text-secondary-alt': string;
  '--text-tertiary': string;
  '--text-muted': string;
  '--text-warning': string;
  '--text-destructive': string;
  '--shimmer-base': string;
  '--shimmer-dip': string;
  '--link': string;
  '--link-hover': string;
  '--link-visited': string;
  '--accent-primary': string;
  '--accent-primary-hover': string;
  '--ring-primary': string;
  '--header-primary': string;
  '--header-hover': string;
  '--header-button-hover': string;
  '--surface-active': string;
  '--surface-active-alt': string;
  '--surface-hover': string;
  '--surface-hover-alt': string;
  '--surface-composer-hover': string;
  '--surface-primary': string;
  '--chart-widget-surface': string;
  '--chart-widget-stroke': string;
  '--surface-primary-alt': string;
  '--surface-primary-contrast': string;
  '--surface-secondary': string;
  '--surface-secondary-alt': string;
  '--surface-tertiary': string;
  '--surface-tertiary-alt': string;
  '--surface-dialog': string;
  '--surface-overlay': string;
  '--surface-submit': string;
  '--surface-submit-hover': string;
  '--surface-destructive': string;
  '--surface-destructive-hover': string;
  '--surface-chat': string;
  '--surface-code': string;
  '--surface-inverted': string;
  '--surface-inverted-hover': string;
  '--text-inverted': string;
  '--surface-fixed': string;
  '--surface-fixed-hover': string;
  '--text-fixed': string;
  '--border-light': string;
  '--border-light-alpha': string;
  '--border-medium': string;
  '--border-medium-alpha': string;
  '--border-medium-alt': string;
  '--border-heavy': string;
  '--border-heavy-alpha': string;
  '--border-xheavy': string;
  '--border-xheavy-alpha': string;
  '--border-destructive': string;
  '--status-success': string;
  '--status-success-subtle': string;
  '--status-success-border': string;
  '--status-success-strong': string;
  '--status-info': string;
  '--status-info-subtle': string;
  '--status-info-border': string;
  '--status-info-strong': string;
  '--status-warning': string;
  '--status-warning-subtle': string;
  '--status-warning-border': string;
  '--status-warning-strong': string;
  '--status-error': string;
  '--status-error-subtle': string;
  '--status-error-border': string;
  '--status-error-strong': string;
  '--status-neutral': string;
  '--status-neutral-subtle': string;
  '--status-neutral-border': string;
  '--status-verified': string;
  '--text-on-status': string;
  '--brand-purple': string;

  '--syntax-text': string;
  '--syntax-comment': string;
  '--syntax-meta': string;
  '--syntax-builtin': string;
  '--syntax-keyword': string;
  '--syntax-string': string;
  '--syntax-attr': string;
  '--syntax-title': string;

  '--series-1': string;
  '--series-2': string;
  '--series-3': string;
  '--series-4': string;
  '--series-5': string;
  '--series-6': string;
  '--series-7': string;
  '--series-8': string;

  '--switch-unchecked': string;

  '--presentation': string;
}

/**
 * Name of the defined colors in the Tailwind theme
 */
export interface IThemeColors {
  'text-primary'?: string;
  'text-secondary'?: string;
  'text-secondary-alt'?: string;
  'text-tertiary'?: string;
  'text-muted'?: string;
  'text-warning'?: string;
  'text-destructive'?: string;
  link?: string;
  'link-hover'?: string;
  'link-visited'?: string;
  'accent-primary'?: string;
  'accent-primary-hover'?: string;
  'ring-primary'?: string;
  'header-primary'?: string;
  'header-hover'?: string;
  'header-button-hover'?: string;
  'surface-active'?: string;
  'surface-active-alt'?: string;
  'surface-hover'?: string;
  'surface-hover-alt'?: string;
  'surface-composer-hover'?: string;
  'surface-primary'?: string;
  'chart-widget-surface'?: string;
  'chart-widget-stroke'?: string;
  'surface-primary-alt'?: string;
  'surface-primary-contrast'?: string;
  'surface-secondary'?: string;
  'surface-secondary-alt'?: string;
  'surface-tertiary'?: string;
  'surface-tertiary-alt'?: string;
  'surface-dialog'?: string;
  'surface-overlay'?: string;
  'surface-submit'?: string;
  'surface-submit-hover'?: string;
  'surface-destructive'?: string;
  'surface-destructive-hover'?: string;
  'surface-chat'?: string;
  'surface-code'?: string;
  'surface-inverted'?: string;
  'surface-inverted-hover'?: string;
  'text-inverted'?: string;
  'surface-fixed'?: string;
  'surface-fixed-hover'?: string;
  'text-fixed'?: string;
  'border-light'?: string;
  'border-medium'?: string;
  'border-medium-alt'?: string;
  'border-heavy'?: string;
  'border-xheavy'?: string;
  'border-destructive'?: string;
  'status-success'?: string;
  'status-success-subtle'?: string;
  'status-success-border'?: string;
  'status-success-strong'?: string;
  'status-info'?: string;
  'status-info-subtle'?: string;
  'status-info-border'?: string;
  'status-info-strong'?: string;
  'status-warning'?: string;
  'status-warning-subtle'?: string;
  'status-warning-border'?: string;
  'status-warning-strong'?: string;
  'status-error'?: string;
  'status-error-subtle'?: string;
  'status-error-border'?: string;
  'status-error-strong'?: string;
  'status-neutral'?: string;
  'status-neutral-subtle'?: string;
  'status-neutral-border'?: string;
  'status-verified'?: string;
  'text-on-status'?: string;
  'brand-purple'?: string;

  'series-1'?: string;
  'series-2'?: string;
  'series-3'?: string;
  'series-4'?: string;
  'series-5'?: string;
  'series-6'?: string;
  'series-7'?: string;
  'switch-unchecked'?: string;
  'series-8'?: string;
  presentation?: string;

  // Retained for excluded SidePanel/Agents + SidePanel/Builder (pending migration)
  background?: string;
  primary?: string;
  'primary-foreground'?: string;
  ring?: string;
}

export interface Theme {
  name: string;
  colors: IThemeRGB;
}

export type ThemeMode = 'light' | 'dark';

export interface IThemeAppearance {
  controlRadius: string;
  roundControlRadius: string;
  surfaceRadius: string;
  largeSurfaceRadius: string;
  controlHeight: string;
  spaceCompact: string;
  spaceNormal: string;
  fontFamily: string;
  elevationSurface: string;
  motionFast: string;
  motionNormal: string;
}

export interface ThemeModeDefinition {
  colors?: IThemeRGB;
  appearance?: Partial<IThemeAppearance>;
  /**
   * Brand overrides for this mode only, applied over the theme-wide `brands`.
   * A brand fill carries a glyph and has to stand out from the canvas, and both
   * of those flip between light and dark, so a single set cannot serve both at
   * enhanced contrast.
   */
  brands?: Partial<IThemeBrands>;
}

export interface IThemeBrands {
  'provider-openai': string;
  'provider-openai-gpt4': string;
  'provider-openai-reasoning': string;
  'provider-anthropic': string;
  'provider-azure': string;
  'provider-bedrock': string;
  'provider-foreground': string;
}

/** Versioned, data-only theme input. Missing values resolve against LibreChat defaults. */
export interface ThemeDefinition {
  version: 1;
  name: string;
  modes: Partial<Record<ThemeMode, ThemeModeDefinition>>;
  brands?: Partial<IThemeBrands>;
}

export interface ResolvedThemeDefinition {
  version: 1;
  name: string;
  mode: ThemeMode;
  colors: Required<IThemeRGB>;
  appearance: IThemeAppearance;
  brands: IThemeBrands;
}
