/** Inserts text at the caret as an undoable edit when the browser allows it. */
export function insertTextAtCursor(element: HTMLTextAreaElement, textToInsert: string): void {
  element.focus();
  if (window.getSelection() && document.queryCommandSupported('insertText')) {
    document.execCommand('insertText', false, textToInsert);
    return;
  }
  console.warn('insertTextAtCursor: document.execCommand is not supported');
  const startPos = element.selectionStart;
  const endPos = element.selectionEnd;
  const beforeText = element.value.substring(0, startPos);
  const afterText = element.value.substring(endPos);
  element.value = beforeText + textToInsert + afterText;
  element.selectionStart = element.selectionEnd = startPos + textToInsert.length;
  element.dispatchEvent(new Event('input', { bubbles: true }));
}

/**
 * Recalculates a textarea's height after a change the browser did not measure,
 * such as a newline inserted at the caret.
 */
export function forceResize(element: HTMLTextAreaElement | null): void {
  if (!element) {
    return;
  }
  element.style.height = 'auto';
  element.style.height = `${element.scrollHeight}px`;
}

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
