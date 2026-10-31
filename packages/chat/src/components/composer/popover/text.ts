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
