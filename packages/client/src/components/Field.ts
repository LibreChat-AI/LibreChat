/**
 * The shared appearance of a form control: border, radius, type scale and focus
 * treatment. Owned here so `Input`, `Textarea`, and the select/combobox triggers
 * that have to sit beside them in a form cannot drift apart as the theme evolves.
 * Callers compose a variant rather than restating these classes locally. The
 * border is `border-control` because it is the only edge the control has, so a
 * palette can raise it to the 3:1 non-text floor without touching separators.
 */
export const fieldBase: string =
  'lc-field flex w-full rounded-lg border border-border-control px-3 py-2 text-sm text-text-primary placeholder:text-text-secondary focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-text-primary disabled:cursor-not-allowed disabled:opacity-50';

/** A single-line control sized to sit in a form row, matching `Input`. */
export const fieldControl: string = `${fieldBase} h-10 bg-transparent`;
