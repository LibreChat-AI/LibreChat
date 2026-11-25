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
