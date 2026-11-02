import { useState } from 'react';
import { cn, TextareaAutosize, useRemScale } from '@librechat/client';
import type { FocusEvent, MouseEvent, MutableRefObject, TextareaHTMLAttributes } from 'react';
import ComposerWaveform from '../bar/Waveform';
import CollapseChat from '../CollapseChat';
import useVisualRowCount from './rows';

/** The textarea's resting height in pixels at the default root font size. */
const INITIAL_HEIGHT = 44;

export interface ComposerFieldProps {
  /** Receives the textarea element alongside the host's own ref. */
  textAreaRef: MutableRefObject<HTMLTextAreaElement | null>;
  /** The host's ref callback for the textarea, such as a form library's registration. */
  inputRef?: (element: HTMLTextAreaElement | null) => void;
  /** The textarea's accessible name. */
  ariaLabel: string;
  /** The textarea's attributes and handlers, passed through unchanged. */
  textareaProps: Omit<
    TextareaHTMLAttributes<HTMLTextAreaElement>,
    'className' | 'style' | 'rows' | 'aria-label' | 'aria-labelledby'
  > & { 'data-testid'?: string };
  /** The draft, so the field can tell when it grows past three rows. */
  value: string;
  /** Dictation is listening into an empty draft: the waveform stands in for the placeholder. */
  listening: boolean;
  /** Dictation is hearing speech right now. */
  dictationActive: boolean;
  /** The draft is locked behind a question card: kept to one line and not selectable. */
  locked: boolean;
}

/** The composer's text field: grows with the draft up to a cap, can be collapsed to one faded
 *  line once the draft passes three rows, and expands again on focus or click. */
export default function ComposerField({
  textAreaRef,
  inputRef,
  ariaLabel,
  textareaProps,
  value,
  listening,
  dictationActive,
  locked,
}: ComposerFieldProps): React.JSX.Element {
  const remScale = useRemScale();
  const [isCollapsed, setIsCollapsed] = useState(false);
  const rowCount = useVisualRowCount(textAreaRef, value, remScale);
  const compact = isCollapsed || locked;
  const { onFocus, onClick, ...rest } = textareaProps;

  const expand = () => {
    if (isCollapsed) {
      setIsCollapsed(false);
    }
  };

  return (
    <div className="flex">
      <div className={cn('relative flex-1', compact && 'mask-b-from-60% mask-b-to-90%')}>
        <TextareaAutosize
          {...rest}
          aria-label={ariaLabel}
          ref={(element) => {
            inputRef?.(element);
            textAreaRef.current = element;
          }}
          rows={1}
          onFocus={(e: FocusEvent<HTMLTextAreaElement>) => {
            expand();
            onFocus?.(e);
          }}
          onClick={(e: MouseEvent<HTMLTextAreaElement>) => {
            expand();
            onClick?.(e);
          }}
          style={{ height: INITIAL_HEIGHT * remScale }}
          variant="composer"
          data-listening={listening || undefined}
          data-locked={locked || undefined}
          className={compact ? 'max-h-13' : 'max-h-[45vh] md:max-h-[55vh]'}
        />
        {listening && (
          <ComposerWaveform
            active={dictationActive}
            className="pointer-events-none absolute inset-x-5 inset-y-2"
          />
        )}
        <div className="absolute inset-e-2 bottom-1 z-10">
          <CollapseChat
            isCollapsed={isCollapsed}
            isScrollable={rowCount > 3 && !locked}
            setIsCollapsed={setIsCollapsed}
          />
        </div>
      </div>
    </div>
  );
}
