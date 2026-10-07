/**
 * The floating-label field of a sign-in form: a generous corner and edge, with the label resting
 * inside the field until the field is focused or filled, then lifting onto its top edge. The
 * label is the field's `peer`, so it follows the field's placeholder and focus state in CSS.
 * `webkit-dark-styles` keeps a browser's autofill from repainting the field.
 */
export const floatingField: string =
  'webkit-dark-styles peer h-auto w-full rounded-2xl border px-3.5 pb-2.5 pt-3 text-text-primary duration-200 motion-reduce:transition-none focus:border-accent-primary focus-visible:border-accent-primary';

export const floatingLabel: string =
  'absolute start-3 top-1.5 z-10 origin-[0] -translate-y-4 scale-75 transform bg-surface-primary px-2 text-sm text-text-secondary-alt duration-200 peer-placeholder-shown:top-1/2 peer-placeholder-shown:-translate-y-1/2 peer-placeholder-shown:scale-100 peer-focus:top-1.5 peer-focus:-translate-y-4 peer-focus:scale-75 peer-focus:px-2 peer-focus:text-accent-primary motion-reduce:transition-none rtl:peer-focus:left-auto rtl:peer-focus:translate-x-1/4';

export const floatingSecretButton: string =
  'size-9 rounded-xl text-text-secondary-alt hover:bg-transparent hover:text-text-primary';
