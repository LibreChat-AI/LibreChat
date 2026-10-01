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
 * whose `fieldFillStyle` is `fill` paints the field in `field-fill`; by default it stays clear.
 */
export const fieldBase: string = `lc-field flex w-full rounded-lg border border-border-control px-3 py-theme-field-y text-sm text-field-text theme-field-fill:bg-field-fill placeholder:text-text-secondary focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus-control theme-field-border:focus:border-border-field-focus theme-field-border:focus-visible:ring-1 theme-field-border:focus-visible:ring-border-field-focus disabled:cursor-not-allowed disabled:opacity-50 ${disabledFillClasses}`;

/** A single-line control sized to sit in a form row, matching `Input`. */
export const fieldControl: string = `${fieldBase} h-theme-field bg-transparent`;
