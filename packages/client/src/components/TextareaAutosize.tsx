import {
  forwardRef,
  RefAttributes,
  ForwardRefExoticComponent,
  useLayoutEffect,
  useState,
} from 'react';
import { useAtomValue } from 'jotai';
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
import { chatDirectionAtom } from '~/store';
import { cn } from '~/utils';
import './Field.css';

/** A rounded editor box of its own, such as a prompt or message editor. */
const framed = `${FIELD_OWN_FOCUS} rounded-xl border border-border-medium bg-transparent text-text-primary placeholder:text-text-secondary focus-visible:ring-2 focus-visible:ring-focus-control`;

/** The control is bare by default and the caller draws it. `field` is a form field like `Textarea`,
 *  with its outline and focus ring, that grows with its text. `framed` is the bordered, rounded
 *  editor box, `flush` draws no border or ring because the surrounding frame owns the indicator,
 *  and `embedded` fills a list or popover row edge to edge. */
const AUTOSIZE_VARIANTS: Record<'default' | 'field' | 'framed' | 'flush' | 'embedded', string> = {
  default: '',
  field: `${fieldBase} ${fieldFillTransparent}`,
  framed,
  flush: `${FIELD_OWN_FOCUS} ${fieldFlush}`,
  embedded: fieldEmbedded,
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
  ({ focusOutline, variant = 'default', className, ...props }, ref) => {
    const [, setIsRerendered] = useState(false);
    const chatDirection = useAtomValue(chatDirectionAtom).toLowerCase();
    useLayoutEffect(() => setIsRerendered(true), []);
    return (
      <ReactTextareaAutosize
        dir={chatDirection}
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
