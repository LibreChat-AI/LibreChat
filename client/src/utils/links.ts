/**
 * Opens `url` in a new tab the way a `target="_blank"` link does, without giving the new page an
 * opener or a referrer. Call it synchronously inside the user's click: `window.open` with a
 * `noopener,noreferrer` features string asks WebKit for a popup window, which Safari opens as a
 * separate window and an iOS home-screen web app does not open at all.
 */
export function openInNewTab(url: string): void {
  const link = document.createElement('a');
  link.href = url;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  document.body.appendChild(link);
  link.click();
  link.remove();
}
