/**
 * The message list is the screen's heaviest part and the welcome screen never shows it, so it
 * loads through a dynamic import: exporting it statically would put the message renderer in the
 * components entry, which every page loads before its first paint. The app may wrap this in its
 * own lazy boundary; `ChatPane` suspends the column while it loads.
 */
export function loadScreenMessages(): Promise<typeof import('./messages')> {
  return import('./messages');
}
