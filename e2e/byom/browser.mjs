/** Native acceptance sends turns with Enter, including after reloads. */
export function initializeBrowser() {
  localStorage.setItem('enterToSend', 'true');
}
