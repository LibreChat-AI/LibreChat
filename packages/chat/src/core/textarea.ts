/** Drops the command character a popover was opened with when it still ends the draft, and puts
 *  the caret back in the textarea. */
export function removeCharIfLast(textarea: HTMLTextAreaElement, charToRemove: string): void {
  if (textarea.value.endsWith(charToRemove)) {
    textarea.value = textarea.value.slice(0, -1);
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  }

  textarea.focus();
}
export interface CommandRange {
  start: number;
  end: number;
}

/** The whitespace-delimited @ token ending at a collapsed caret, excluding email addresses. */
export function findMentionRange(
  text: string,
  start: number,
  end: number = start,
): CommandRange | undefined {
  if (start !== end || start < 1 || start > text.length) {
    return undefined;
  }
  const tokenStart = text.lastIndexOf('@', start - 1);
  if (tokenStart < 0 || (tokenStart > 0 && !/\s/.test(text[tokenStart - 1]))) {
    return undefined;
  }
  if (/\s/.test(text.slice(tokenStart + 1, start))) {
    return undefined;
  }
  return { start: tokenStart, end: start };
}
