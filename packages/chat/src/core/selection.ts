/** Selects everything inside the element an event landed on, as a double click on inline code does. */
export function selectContents(event: { target: EventTarget | null }): void {
  const range = document.createRange();
  range.selectNodeContents(event.target as Node);
  const selection = window.getSelection();
  if (!selection) {
    return;
  }
  selection.removeAllRanges();
  selection.addRange(range);
}
