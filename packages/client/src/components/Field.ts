import { disabledFillClasses } from '~/utils/theme';

/**
 * The shared appearance of a form control: border, radius, type scale and focus
 * treatment. Owned here so `Input`, `Textarea`, and the select/combobox triggers
 * that have to sit beside them in a form cannot drift apart as the theme evolves.
 * Callers compose a variant rather than restating these classes locally. The
 * border is `border-control` because it is the only edge the control has, so a
 * palette can raise it to the 3:1 non-text floor without touching separators.
 * A theme whose `fieldFocusStyle` is `border` focuses the field by swapping that edge to
 * `border-field-focus`; keyboard focus adds a 1px ring in the same color, so the indicator keeps
 * the 2px perimeter the app holds as its focus floor. The value inks in `field-text`, and a theme
 * whose `fieldFillStyle` is `fill` paints the field in `field-fill`, which a disabled field keeps
 * under the pointer too; by default it stays clear.
 */
export const fieldBase: string = `lc-field flex w-full rounded-lg border border-border-control px-3 py-theme-field-y text-sm text-field-text theme-field-fill:bg-field-fill theme-field-fill:disabled:hover:bg-field-fill placeholder:text-text-secondary focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus-control theme-field-border:focus:border-border-field-focus theme-field-border:focus-visible:ring-1 theme-field-border:focus-visible:ring-border-field-focus disabled:cursor-not-allowed disabled:opacity-50 ${disabledFillClasses}`;

/** A single-line control sized to sit in a form row, matching `Input`. */
export const fieldControl: string = `${fieldBase} h-theme-field bg-transparent`;

/**
 * A variant that owns its fill restates it under `theme-field-fill:` too, because that variant's
 * `bg-field-fill` (and its disabled-hover twin) would otherwise outrank the variant's own `bg-*`
 * in a theme that fills fields.
 */
export const fieldFillTransparent: string =
  'bg-transparent theme-field-fill:bg-transparent theme-field-fill:disabled:hover:bg-transparent';

/** A field that sits inside a frame which owns the fill, the border and the focus indicator, so it draws none of them. */
export const fieldFlush: string = `${fieldFillTransparent} border-0 focus-visible:ring-0 theme-field-border:focus-visible:ring-0`;

/** Marks a control outside `.lc-field` whose own ring, or surrounding frame, is its focus indicator, so the app's global textarea outline stays off it. */
export const FIELD_OWN_FOCUS: string = 'lc-own-focus';

/** A field marked `aria-invalid` draws its border in the destructive role, over the caller's border colour. */
export const fieldInvalid: string =
  'aria-invalid:border-border-destructive theme-field-border:focus:aria-invalid:border-border-destructive';

/** A field set into a list or popover edge to edge, filling its row and leaving the frame to the host. */
export const fieldEmbedded: string =
  'bg-surface-tertiary-alt theme-field-fill:bg-surface-tertiary-alt theme-field-fill:disabled:hover:bg-surface-tertiary-alt h-auto w-full border-0 p-2 rounded-none text-sm text-text-primary';
