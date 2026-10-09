import { useCallback } from 'react';

/** Creates a callback ref that focuses the popover input and transfers command text into search. */
const useInitPopoverInput = ({
  inputRef,
  textAreaRef,
  commandChar,
  preserveTextAfterCursor = false,
  setSearchValue,
  setOpen,
}: {
  inputRef: React.MutableRefObject<HTMLInputElement | null>;
  textAreaRef: React.MutableRefObject<HTMLTextAreaElement | null>;
  commandChar: string;
  preserveTextAfterCursor?: boolean;
  setSearchValue: (value: string) => void;
  setOpen: (value: boolean) => void;
}) =>
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
    [inputRef, textAreaRef, commandChar, preserveTextAfterCursor, setSearchValue, setOpen],
  );

export default useInitPopoverInput;
