/**
 * Insert text at the cursor position in a textarea.
 */
export function insertTextAtCursor(element: HTMLTextAreaElement, textToInsert: string) {
  element.focus();

  // Use the browser's built-in undoable actions if possible
  if (window.getSelection() && document.queryCommandSupported('insertText')) {
    document.execCommand('insertText', false, textToInsert);
  } else {
    console.warn('insertTextAtCursor: document.execCommand is not supported');
    const startPos = element.selectionStart;
    const endPos = element.selectionEnd;
    const beforeText = element.value.substring(0, startPos);
    const afterText = element.value.substring(endPos);
    element.value = beforeText + textToInsert + afterText;
    element.selectionStart = element.selectionEnd = startPos + textToInsert.length;
    const event = new Event('input', { bubbles: true });
    element.dispatchEvent(event);
  }
}

/**
 * Necessary resize helper for edge cases where paste doesn't update the container height.
 *
 1) Resetting the height to 'auto' forces the component to recalculate height based on its current content

 2) Forcing a reflow. Accessing offsetHeight will cause a reflow of the page,
    ensuring that the reset height takes effect before resetting back to the scrollHeight.
    This step is necessary because changes to the DOM do not instantly cause reflows.

 3) Reseting back to scrollHeight reads and applies the ideal height for the current content dynamically
 */
export const forceResize = (element: HTMLTextAreaElement | null) => {
  if (!element) {
    return;
  }
  element.style.height = 'auto';
  element.style.height = `${element.scrollHeight}px`;
};

/**
 * Remove the specified character from the end of the textarea's text if it's present.
 * This function ensures that the specified character is only removed if it's the last character.
 *
 * @param {HTMLTextAreaElement} textarea - The textarea element where text manipulation will occur.
 * @param {string} charToRemove - The character to remove if it's the last character in the textarea's value.
 */
export function removeCharIfLast(textarea: HTMLTextAreaElement, charToRemove: string) {
  if (textarea.value.endsWith(charToRemove)) {
    textarea.value = textarea.value.slice(0, -1);
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  }

  textarea.focus();
}

/**
 * Check if the textarea is scrollable.
 * @param element
 * @returns
 */
export const checkIfScrollable = (element: HTMLTextAreaElement | null) => {
  if (!element) {
    return false;
  }
  return element.scrollHeight > element.clientHeight;
};
