import {
  forwardRef,
  RefAttributes,
  ForwardRefExoticComponent,
  useLayoutEffect,
  useState,
} from 'react';
import ReactTextareaAutosize from 'react-textarea-autosize';
import type { TextareaAutosizeProps } from 'react-textarea-autosize';
import type { FocusOutline } from './Focus';
import {
  fieldBase,
  fieldFlush,
  fieldInvalid,
  fieldEmbedded,
  FIELD_OWN_FOCUS,
  fieldFillTransparent,
} from './Field';
import { focusOutlineVariants } from './Focus';
import { cn } from '~/utils';
import './Field.css';

/** A rounded editor box of its own, such as a prompt or message editor. */
const framed = `${FIELD_OWN_FOCUS} rounded-xl border border-border-medium bg-transparent text-text-primary placeholder:text-text-secondary focus-visible:ring-2 focus-visible:ring-focus-control`;

/** The chat composer's draft: no frame of its own (the composer surface draws it), the composer
 *  type scale, and a max height that eases as the draft collapses. `data-listening` hides the
 *  caret and placeholder while dictation stands in for them; `data-locked` stops selection. */
const composer =
  'composer-text m-0 w-full resize-none overflow-y-auto bg-transparent px-5 py-3.25 md:py-3.5 placeholder:text-text-tertiary scrollbar-hover focus:outline-hidden focus:ring-0 focus:ring-offset-0 transition-[max-height] duration-200 motion-reduce:transition-none disabled:cursor-not-allowed data-listening:caret-transparent data-listening:placeholder:text-transparent data-locked:select-none';

/** The control is bare by default and the caller draws it. `field` is a form field like `Textarea`,
 *  with its outline and focus ring, that grows with its text. `framed` is the bordered, rounded
 *  editor box, `flush` draws no border or ring because the surrounding frame owns the indicator,
 *  `embedded` fills a list or popover row edge to edge, and `composer` is the chat draft. */
const AUTOSIZE_VARIANTS: Record<
  'default' | 'field' | 'framed' | 'flush' | 'embedded' | 'composer',
  string
> = {
  default: '',
  field: `${fieldBase} ${fieldFillTransparent}`,
  framed,
  flush: `${FIELD_OWN_FOCUS} ${fieldFlush}`,
  embedded: fieldEmbedded,
  composer,
};

type BaseTextareaAutosizeProps = Omit<TextareaAutosizeProps, 'aria-label' | 'aria-labelledby'> & {
  focusOutline?: FocusOutline;
  variant?: keyof typeof AUTOSIZE_VARIANTS;
};

export type TextareaAutosizePropsWithAria =
  | (BaseTextareaAutosizeProps & {
      'aria-label': string;
      'aria-labelledby'?: never;
    })
  | (BaseTextareaAutosizeProps & {
      'aria-labelledby': string;
      'aria-label'?: never;
    });

export const TextareaAutosize: ForwardRefExoticComponent<
  TextareaAutosizePropsWithAria & RefAttributes<HTMLTextAreaElement>
> = forwardRef<HTMLTextAreaElement, TextareaAutosizePropsWithAria>(
  ({ focusOutline, variant = 'default', className, dir = 'auto', ...props }, ref) => {
    const [, setIsRerendered] = useState(false);
    useLayoutEffect(() => setIsRerendered(true), []);
    return (
      <ReactTextareaAutosize
        dir={dir}
        {...props}
        className={
          cn(
            focusOutlineVariants({ focusOutline }),
            fieldInvalid,
            AUTOSIZE_VARIANTS[variant],
            className,
          ) || undefined
        }
        ref={ref}
      />
    );
  },
);
