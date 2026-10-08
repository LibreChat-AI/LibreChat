/** Every image format browsers render, so a configured path is never mistaken for a provider name. */
const IMAGE_EXTENSION =
  /\.(apng|avif|bmp|cur|gif|ico|jfif|jpe?g|pjp|pjpeg|png|svg|webp)(?:[?#].*)?$/i;

export function isImageURL(iconURL?: string | null): iconURL is string {
  if (!iconURL) {
    return false;
  }

  if (/^https?:\/\//i.test(iconURL) || /^data:image\/[a-z0-9.+-]+/i.test(iconURL)) {
    return true;
  }

  if (iconURL.startsWith('//')) {
    return /^\/\/[^/]/.test(iconURL);
  }

  return iconURL.startsWith('/') || IMAGE_EXTENSION.test(iconURL);
}

export function isSvgIcon(iconURL?: string | null): iconURL is string {
  if (!iconURL) {
    return false;
  }

  if (/^data:image\/svg\+xml/i.test(iconURL)) {
    return true;
  }

  const path = iconURL.split(/[?#]/)[0];
  return /\.svg$/i.test(path);
}

/**
 * True for a `data:` URI or same-origin URL, so theme detection never fetches a
 * remote icon from every viewer's browser. `new URL` resolves every non-`data:`
 * value: `/\attacker.example/icon.svg` looks root-relative but loads cross-origin.
 */
export function isSameOriginOrDataIcon(iconURL?: string | null): iconURL is string {
  if (!iconURL) {
    return false;
  }

  if (/^data:/i.test(iconURL)) {
    return true;
  }

  if (typeof window === 'undefined') {
    return false;
  }

  try {
    return new URL(iconURL, window.location.href).origin === window.location.origin;
  } catch {
    return false;
  }
}
