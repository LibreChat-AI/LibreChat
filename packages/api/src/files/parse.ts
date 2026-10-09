import path from 'path';
import { URL } from 'url';

const imageExtensionRegex = /\.(jpg|jpeg|png|gif|bmp|tiff|svg|webp)$/i;

/**
 * Extracts the image basename from a given URL.
 *
 * @param urlString - The URL string from which the image basename is to be extracted.
 * @returns The basename of the image file from the URL.
 * Returns an empty string if the URL does not contain a valid image basename.
 */
export function getImageBasename(urlString: string): string {
  try {
    const url = new URL(urlString);
    const basename = path.basename(url.pathname);

    return imageExtensionRegex.test(basename) ? basename : '';
  } catch {
    // If URL parsing fails, return an empty string
    return '';
  }
}

/**
 * Extracts the basename of a file from a given URL.
 *
 * @param urlString - The URL string from which the file basename is to be extracted.
 * @returns The basename of the file from the URL.
 * Returns an empty string if the URL parsing fails.
 */
export function getFileBasename(urlString: string): string {
  try {
    const url = new URL(urlString);
    return path.basename(url.pathname);
  } catch {
    // If URL parsing fails, return an empty string
    return '';
  }
}
