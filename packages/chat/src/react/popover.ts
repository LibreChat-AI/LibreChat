import { useCallback } from 'react';
import type { CommandRange } from '../core/textarea';

/** Creates a callback ref that focuses the popover input and transfers command text into search. */
const useInitPopoverInput = ({
  inputRef,
  textAreaRef,
  commandChar,
  preserveTextAfterCursor = false,
  commandRange,
  setSearchValue,
  setOpen,
}: {
  inputRef: React.MutableRefObject<HTMLInputElement | null>;
  textAreaRef: React.MutableRefObject<HTMLTextAreaElement | null>;
  commandChar: string;
  preserveTextAfterCursor?: boolean;
  /** Keep the draft intact while the picker searches this token. */
  commandRange?: CommandRange;
  setSearchValue: (value: string) => void;
  setOpen: (value: boolean) => void;
}): ((node: HTMLInputElement | null) => void) =>
  useCallback(
    (node: HTMLInputElement | null) => {
      inputRef.current = node;
      if (!node) {
        return;
      }
      const textarea = textAreaRef.current;
      const text = textarea?.value;
      const selectionStart = textarea?.selectionStart;
      node.focus();
      setOpen(true);
      if (!textarea || typeof text !== 'string' || typeof selectionStart !== 'number') {
        return;
      }
      if (commandRange) {
        setSearchValue(text.slice(commandRange.start + commandChar.length, commandRange.end));
        return;
      }
      if (!text.startsWith(commandChar) || selectionStart < commandChar.length) {
        return;
      }
      const commandEnd = preserveTextAfterCursor ? selectionStart : text.length;
      if (commandEnd > commandChar.length) {
        setSearchValue(text.slice(commandChar.length, commandEnd));
      }
      textarea.value = preserveTextAfterCursor ? text.slice(selectionStart) : '';
      textarea.setSelectionRange(0, 0);
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    },
    [
      inputRef,
      textAreaRef,
      commandChar,
      preserveTextAfterCursor,
      commandRange,
      setSearchValue,
      setOpen,
    ],
  );

export default useInitPopoverInput;
