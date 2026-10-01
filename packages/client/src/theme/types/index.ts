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
  /** The shared Badge's label ink; follows `rgb-text-primary` when a theme omits it. */
  'rgb-badge-label'?: string;
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
  /** Links inside rendered Markdown. Falls back to the mode's `rgb-link`, or in dark to
   *  `rgb-text-primary`, when a theme names that and not this. */
  'rgb-link-prose'?: string;
  'rgb-accent-primary'?: string;
  'rgb-accent-primary-hover'?: string;

  // Ring colors
  'rgb-ring-primary'?: string;
  'rgb-focus-outline'?: string;
  'rgb-focus-control'?: string;

  // Header colors
  'rgb-header-primary'?: string;
  'rgb-header-hover'?: string;
  'rgb-header-button-hover'?: string;

  // Surface colors
  'rgb-surface-active'?: string;
  'rgb-surface-active-alt'?: string;
  'rgb-surface-hover'?: string;
  'rgb-surface-hover-alt'?: string;
  /** Fill of a neutral control while pressed; follows `rgb-surface-hover` when a theme omits it. */
  'rgb-surface-pressed'?: string;
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
  /** An OGDialog title's ink; follows `rgb-text-primary` when a theme omits it. */
  'rgb-dialog-title'?: string;
  'rgb-surface-overlay'?: string;
  /** Scrims, chips and progress drawn over the user's own media (a lightbox, an image preview,
   *  an upload in progress), and the ink and hover tint on them. They frame the image rather
   *  than the page, so every bundled theme keeps them black and white in both modes. */
  'rgb-surface-media-overlay'?: string;
  'rgb-text-on-media'?: string;
  'rgb-surface-submit'?: string;
  'rgb-surface-submit-hover'?: string;
  'rgb-surface-destructive'?: string;
  'rgb-surface-destructive-hover'?: string;
  'rgb-surface-chat'?: string;
  'rgb-surface-code'?: string;
  'rgb-surface-code-body'?: string;
  /** The backdrop a QR code is scanned against; keep it light in every mode. */
  'rgb-surface-qr'?: string;
  'rgb-surface-inverted'?: string;
  'rgb-surface-inverted-hover'?: string;
  /** Fill of an inverted control while pressed; follows `rgb-surface-inverted-hover` when omitted. */
  'rgb-surface-inverted-pressed'?: string;
  /** The Button's primary fill and its hover; they follow `rgb-surface-inverted` and its hover
   *  when omitted, which the checkbox and switch keep painting. */
  'rgb-button-primary'?: string;
  'rgb-button-primary-hover'?: string;
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
  /** The boundary of a form control (field, select trigger, OTP slot). Owes the
   *  3:1 non-text floor on every canvas, so it is kept apart from the separator
   *  roles above, which stay quiet. */
  'rgb-border-control'?: string;
  /** A field's edge while it holds focus, under `fieldFocusStyle: 'border'`; follows
   *  `rgb-focus-control` when a theme omits it. */
  'rgb-border-field-focus'?: string;
  /** Disabled fill, ink and edge. Painted only under the `fill` disabled style. */
  'rgb-surface-disabled'?: string;
  'rgb-text-disabled'?: string;
  'rgb-border-disabled'?: string;

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

  /** The default user avatar's fill and glyph, drawn when a user has no image. The glyph follows
   *  `rgb-text-primary` in a theme that does not set it, as it did before it had a role. */
  'rgb-avatar-fill'?: string;
  'rgb-avatar-text'?: string;
  /** Behind an agent or assistant avatar while its image loads or where it is transparent. */
  'rgb-avatar-placeholder'?: string;
  /** The hairline around the default avatar, drawn at 10% so it only shows against a dark page. */
  'rgb-avatar-edge'?: string;
  /** The three tones of in-app artwork, such as the file drop zone's illustration. */
  'rgb-illustration-subtle'?: string;
  'rgb-illustration'?: string;
  'rgb-illustration-strong'?: string;
  /** File-type tiles: one fill per kind of file and the ink of the glyph drawn on them. */
  'rgb-file-document'?: string;
  'rgb-file-sheet'?: string;
  'rgb-file-code'?: string;
  'rgb-file-artifact'?: string;
  'rgb-file-audio'?: string;
  'rgb-file-video'?: string;
  'rgb-file-generic'?: string;
  'rgb-file-ink'?: string;

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
  /** The switch's knob in both states, painted over the unchecked track and the checked fill. */
  'rgb-switch-thumb'?: string;
  /** Column names in a table header, over its `surface-secondary` fill. */
  'rgb-table-header-text'?: string;
  /** The opaque fill of a header whose cells stick on their own, the dialog surface by default. */
  'rgb-table-header-fill'?: string;

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
  '--badge-label': string;
  '--text-warning': string;
  '--text-destructive': string;
  '--shimmer-base': string;
  '--shimmer-dip': string;
  '--link': string;
  '--link-hover': string;
  '--link-visited': string;
  '--link-prose': string;
  '--accent-primary': string;
  '--accent-primary-hover': string;
  '--ring-primary': string;
  '--focus-outline': string;
  '--focus-control': string;
  '--header-primary': string;
  '--header-hover': string;
  '--header-button-hover': string;
  '--surface-active': string;
  '--surface-active-alt': string;
  '--surface-hover': string;
  '--surface-hover-alt': string;
  '--surface-pressed': string;
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
  '--dialog-title': string;
  '--surface-overlay': string;
  '--surface-media-overlay': string;
  '--text-on-media': string;
  '--surface-submit': string;
  '--surface-submit-hover': string;
  '--surface-destructive': string;
  '--surface-destructive-hover': string;
  '--surface-chat': string;
  '--surface-code': string;
  '--surface-code-body': string;
  '--surface-qr': string;
  '--surface-inverted': string;
  '--surface-inverted-hover': string;
  '--surface-inverted-pressed': string;
  '--button-primary': string;
  '--button-primary-hover': string;
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
  '--border-control': string;
  '--border-field-focus': string;
  '--surface-disabled': string;
  '--text-disabled': string;
  '--border-disabled': string;
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
  '--avatar-fill': string;
  '--avatar-text': string;
  '--avatar-placeholder': string;
  '--avatar-edge': string;
  '--illustration-subtle': string;
  '--illustration': string;
  '--illustration-strong': string;
  '--file-document': string;
  '--file-sheet': string;
  '--file-code': string;
  '--file-artifact': string;
  '--file-audio': string;
  '--file-video': string;
  '--file-generic': string;
  '--file-ink': string;

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
  '--switch-thumb': string;
  '--table-header-text': string;
  '--table-header-fill': string;

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
  'badge-label'?: string;
  'text-warning'?: string;
  'text-destructive'?: string;
  link?: string;
  'link-hover'?: string;
  'link-visited'?: string;
  'link-prose'?: string;
  'accent-primary'?: string;
  'accent-primary-hover'?: string;
  'ring-primary'?: string;
  'focus-outline'?: string;
  'focus-control'?: string;
  'header-primary'?: string;
  'header-hover'?: string;
  'header-button-hover'?: string;
  'surface-active'?: string;
  'surface-active-alt'?: string;
  'surface-hover'?: string;
  'surface-hover-alt'?: string;
  'surface-pressed'?: string;
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
  'dialog-title'?: string;
  'surface-overlay'?: string;
  'surface-media-overlay'?: string;
  'text-on-media'?: string;
  'surface-submit'?: string;
  'surface-submit-hover'?: string;
  'surface-destructive'?: string;
  'surface-destructive-hover'?: string;
  'surface-chat'?: string;
  'surface-code'?: string;
  'surface-code-body'?: string;
  'surface-qr'?: string;
  'surface-inverted'?: string;
  'surface-inverted-hover'?: string;
  'surface-inverted-pressed'?: string;
  'button-primary'?: string;
  'button-primary-hover'?: string;
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
  'border-control'?: string;
  'border-field-focus'?: string;
  'surface-disabled'?: string;
  'text-disabled'?: string;
  'border-disabled'?: string;
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
  'avatar-fill'?: string;
  'avatar-text'?: string;
  'avatar-placeholder'?: string;
  'avatar-edge'?: string;
  'illustration-subtle'?: string;
  illustration?: string;
  'illustration-strong'?: string;
  'file-document'?: string;
  'file-sheet'?: string;
  'file-code'?: string;
  'file-artifact'?: string;
  'file-audio'?: string;
  'file-video'?: string;
  'file-generic'?: string;
  'file-ink'?: string;

  'series-1'?: string;
  'series-2'?: string;
  'series-3'?: string;
  'series-4'?: string;
  'series-5'?: string;
  'series-6'?: string;
  'series-7'?: string;
  'switch-unchecked'?: string;
  'switch-thumb'?: string;
  'table-header-text'?: string;
  'table-header-fill'?: string;
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
  /** The corners of a menu panel (`.popover-ui`), a tooltip and a tab trigger, apart from the
   *  control and surface radii; their defaults are the literals those primitives drew. */
  menuRadius: string;
  tooltipRadius: string;
  tabRadius: string;
  radiusSm: string;
  radiusMd: string;
  radiusLg: string;
  radiusXl: string;
  radius2xl: string;
  radius3xl: string;
  controlHeight: string;
  /** A theme-sized control's inline padding and icon-to-label gap; they follow `spaceNormal` and
   *  `spaceCompact` when a theme names those and not these. */
  controlPaddingX: string;
  controlGap: string;
  /** A theme-sized control's label weight, and the Button's default and `sm` heights. */
  controlFontWeight: string;
  buttonHeight: string;
  buttonHeightSm: string;
  /**
   * A form field's height, and its focus treatment: `ring` draws the keyboard-only focus ring,
   * `border` swaps the field's edge to `border-field-focus` on any focus, and keyboard focus adds
   * a 1px ring in that color so the indicator keeps a 2px perimeter.
   */
  fieldHeight: string;
  /** The field's vertical padding, which has to leave its line room inside `fieldHeight`. */
  fieldPaddingY: string;
  fieldFocusStyle: 'ring' | 'border';
  /** The keyboard focus outline's width and its offset from the element's edge, apart from the
   *  heavier outline the contrast modes keep. */
  focusRingWidth: string;
  focusRingOffset: string;
  /** A field label's size, leading and weight. The size follows `textSm` when a theme omits it,
   *  and the default weight is `inherit`. */
  labelSize: string;
  labelLeading: string;
  labelFontWeight: string;
  switchWidth: string;
  switchHeight: string;
  tableCellSpaceY: string;
  tableRowStroke: string;
  spaceCompact: string;
  spaceNormal: string;
  /** `dim` fades a disabled control to half opacity; `fill` paints it in the disabled roles. */
  disabledStyle: 'dim' | 'fill';
  fontFamily: string;
  monoFontFamily: string;
  /** Headings; follows `fontFamily` when a theme omits it. */
  displayFontFamily: string;
  /** The `text-*` scale: size and line height per step, Tailwind's own values by default. */
  textXs: string;
  textSm: string;
  textBase: string;
  textLg: string;
  textXl: string;
  text2xl: string;
  leadingXs: string;
  leadingSm: string;
  leadingBase: string;
  leadingLg: string;
  leadingXl: string;
  leading2xl: string;
  /**
   * An OGDialog's edge stroke width (painted in `border-light`), inline padding and title to
   * description gap, and its title's size, leading, weight and family. The title follows `textLg`
   * and `displayFontFamily` when a theme omits its size and family.
   */
  dialogStroke: string;
  dialogPaddingX: string;
  dialogHeaderGap: string;
  dialogTitleSize: string;
  dialogTitleLeading: string;
  dialogTitleFontWeight: string;
  dialogTitleFontFamily: string;
  /** Opacity of `surface-overlay` under OGDialog, AlertDialog and Dialog, in that order. */
  scrimOpacity: string;
  alertScrimOpacity: string;
  modalScrimOpacity: string;
  elevationSurface: string;
  /** The lift a dragged badge takes while it is held. */
  elevationDrag: string;
  shadow2xs: string;
  shadowXs: string;
  shadowSm: string;
  shadowMd: string;
  shadowLg: string;
  shadowXl: string;
  shadow2xl: string;
  /** The menu panel's and the tooltip's shadows. Their dark defaults differ from the light ones,
   *  and the light menu shadow follows `shadowLg` when a theme names only that. */
  menuShadow: string;
  tooltipShadow: string;
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
