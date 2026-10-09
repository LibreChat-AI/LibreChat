import { importWithRecovery } from '~/lib/assets/lazy';
const HEIC_MIME_TYPES = new Set(['image/heic', 'image/heif']);
const HEIC_EXTENSION_REGEX = /\.(heic|heif)$/i;
type HeicToModule = typeof import('heic-to');

let heicConverterPromise: Promise<HeicToModule> | null = null;

const loadHeicConverter = async (): Promise<HeicToModule> => {
  heicConverterPromise ??= importWithRecovery(() => import('heic-to')).catch((error) => {
    heicConverterPromise = null;
    throw error;
  });
  return heicConverterPromise;
};

const hasHEICMetadata = (file: File): boolean =>
  HEIC_MIME_TYPES.has(file.type.toLowerCase()) || HEIC_EXTENSION_REGEX.test(file.name);

/**
 * Check if a file is in HEIC format
 * @param file - The file to check
 * @returns Promise<boolean> - True if the file is HEIC
 */
export const isHEICFile = async (file: File): Promise<boolean> => {
  if (!hasHEICMetadata(file)) {
    return false;
  }

  try {
    const { isHeic } = await loadHeicConverter();
    return await isHeic(file);
  } catch (error) {
    console.warn('Error checking if file is HEIC:', error);
    // Fallback to mime type check
    return file.type === 'image/heic' || file.type === 'image/heif';
  }
};

/**
 * Convert HEIC file to JPEG
 * @param file - The HEIC file to convert
 * @param quality - JPEG quality (0-1), default is 0.9
 * @param onProgress - Optional callback to track conversion progress
 * @returns Promise<File> - The converted JPEG file
 */
export const convertHEICToJPEG = async (
  file: File,
  quality: number = 0.9,
  onProgress?: (progress: number) => void,
): Promise<File> => {
  try {
    // Report conversion start
    onProgress?.(0.3);

    const { heicTo } = await loadHeicConverter();
    const convertedBlob = await heicTo({
      blob: file,
      type: 'image/jpeg',
      quality,
    });

    // Report conversion completion
    onProgress?.(0.8);

    // Create a new File object with the converted blob
    const convertedFile = new File([convertedBlob], file.name.replace(/\.(heic|heif)$/i, '.jpg'), {
      type: 'image/jpeg',
      lastModified: file.lastModified,
    });

    // Report file creation completion
    onProgress?.(1.0);

    return convertedFile;
  } catch (error) {
    console.error('Error converting HEIC to JPEG:', error);
    throw new Error('Failed to convert HEIC image to JPEG');
  }
};

/**
 * Process a file, converting it from HEIC to JPEG if necessary
 * @param file - The file to process
 * @param quality - JPEG quality for conversion (0-1), default is 0.9
 * @param onProgress - Optional callback to track conversion progress
 * @returns Promise<File> - The processed file (converted if it was HEIC, original otherwise)
 */
export const processFileForUpload = async (
  file: File,
  quality: number = 0.9,
  onProgress?: (progress: number) => void,
): Promise<File> => {
  const isHEIC = await isHEICFile(file);

  if (isHEIC) {
    console.log('HEIC file detected, converting to JPEG...');
    return convertHEICToJPEG(file, quality, onProgress);
  }

  return file;
};
