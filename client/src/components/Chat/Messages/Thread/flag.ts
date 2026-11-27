/**
 * Renderer switch for the message thread, read once per page load. The flat
 * renderer is the default; `VITE_FLAT_THREAD=false` at build time or
 * `LC_FLAT_THREAD=false` in localStorage falls back to the recursive one.
 */
function readFlag(): boolean {
  const fallback = import.meta.env.VITE_FLAT_THREAD !== 'false';
  try {
    const stored = localStorage.getItem('LC_FLAT_THREAD');
    return stored == null ? fallback : stored !== 'false';
  } catch {
    return fallback;
  }
}

export const FLAT_THREAD = readFlag();
