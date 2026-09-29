import {
  forwardRef,
  RefAttributes,
  ForwardRefExoticComponent,
  useLayoutEffect,
  useState,
} from 'react';
import { useAtomValue } from 'jotai';
import { cx } from 'class-variance-authority';
import ReactTextareaAutosize from 'react-textarea-autosize';
import type { TextareaAutosizeProps } from 'react-textarea-autosize';
import type { FocusOutline } from './Focus';
import { focusOutlineVariants } from './Focus';
import { chatDirectionAtom } from '~/store';

type BaseTextareaAutosizeProps = Omit<TextareaAutosizeProps, 'aria-label' | 'aria-labelledby'> & {
  focusOutline?: FocusOutline;
};

/** A field marked `aria-invalid` draws its border in the destructive role, over the caller's border colour. */
const invalidBorder = 'aria-invalid:border-border-destructive';

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
  ({ focusOutline, className, ...props }, ref) => {
    const [, setIsRerendered] = useState(false);
    const chatDirection = useAtomValue(chatDirectionAtom).toLowerCase();
    useLayoutEffect(() => setIsRerendered(true), []);
    return (
      <ReactTextareaAutosize
        dir={chatDirection}
        {...props}
        className={
          cx(focusOutlineVariants({ focusOutline }), invalidBorder, className) || undefined
        }
        ref={ref}
      />
    );
  },
);
