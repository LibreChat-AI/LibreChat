import sharp from 'sharp';
import { EModelEndpoint } from 'librechat-data-provider';
import type { FormatEnum, ResizeOptions, Sharp } from 'sharp';
import { resolveImageMimeType } from './mime';

export type ImageResolution = string | { percentage?: number; px?: number };

/** Shared pipeline; callers own streaming, byte limits, and output lifetime. */
export function createImageTransform({
  input,
  resize,
  format,
  rotate = false,
  timeoutMs,
}: {
  input?: Buffer;
  resize?: ResizeOptions;
  format?: keyof FormatEnum;
  rotate?: boolean;
  timeoutMs?: number;
}): Sharp {
  const transform = input ? sharp(input) : sharp();
  if (rotate) transform.rotate();
  if (resize) transform.resize(resize);
  if (timeoutMs != null) transform.timeout({ seconds: Math.max(1, Math.ceil(timeoutMs / 1_000)) });
  if (format) transform.toFormat(format);
  return transform;
}

export async function resizeImageBuffer(
  inputBuffer: Buffer,
  resolution: ImageResolution,
  endpoint: string,
): Promise<{ buffer: Buffer; bytes: number; width: number; height: number; type?: string }> {
  const maxLowRes = 512;
  const maxShortSideHighRes = 768;
  const maxLongSideHighRes = endpoint === EModelEndpoint.anthropic ? 1568 : 2000;

  let customPercent: number | undefined, customPx: number | undefined;
  if (resolution && typeof resolution === 'object') {
    if (typeof resolution.percentage === 'number') {
      customPercent = resolution.percentage;
    } else if (typeof resolution.px === 'number') {
      customPx = resolution.px;
    }
  }

  let newWidth, newHeight;
  const resizeOptions: ResizeOptions = { fit: 'inside', withoutEnlargement: true };

  if (customPercent != null || customPx != null) {
    // percentage-based resize
    const metadata = await sharp(inputBuffer).metadata();
    if (customPercent != null) {
      newWidth = Math.round(metadata.width! * (customPercent / 100));
      newHeight = Math.round(metadata.height! * (customPercent / 100));
    } else {
      // pixel max on both sides
      newWidth = Math.min(metadata.width!, customPx!);
      newHeight = Math.min(metadata.height!, customPx!);
    }
    resizeOptions.width = newWidth;
    resizeOptions.height = newHeight;
  } else if (resolution === 'low') {
    resizeOptions.width = maxLowRes;
    resizeOptions.height = maxLowRes;
  } else if (resolution === 'high') {
    const metadata = await sharp(inputBuffer).metadata();
    const isWidthShorter = metadata.width! < metadata.height!;

    if (isWidthShorter) {
      // Width is the shorter side
      newWidth = Math.min(metadata.width!, maxShortSideHighRes);
      // Calculate new height to maintain aspect ratio
      newHeight = Math.round((metadata.height! / metadata.width!) * newWidth);
      // Ensure the long side does not exceed the maximum allowed
      if (newHeight > maxLongSideHighRes) {
        newHeight = maxLongSideHighRes;
        newWidth = Math.round((metadata.width! / metadata.height!) * newHeight);
      }
    } else {
      // Height is the shorter side
      newHeight = Math.min(metadata.height!, maxShortSideHighRes);
      // Calculate new width to maintain aspect ratio
      newWidth = Math.round((metadata.width! / metadata.height!) * newHeight);
      // Ensure the long side does not exceed the maximum allowed
      if (newWidth > maxLongSideHighRes) {
        newWidth = maxLongSideHighRes;
        newHeight = Math.round((metadata.height! / metadata.width!) * newWidth);
      }
    }

    resizeOptions.width = newWidth;
    resizeOptions.height = newHeight;
  } else {
    throw new Error('Invalid resolution parameter');
  }

  const { data: resizedBuffer, info } = await createImageTransform({
    input: inputBuffer,
    rotate: true,
    resize: resizeOptions,
  }).toBuffer({ resolveWithObject: true });
  const metadata = await sharp(resizedBuffer).metadata();
  return {
    buffer: resizedBuffer,
    bytes: resizedBuffer.length,
    width: info.width,
    height: info.height,
    type: resolveImageMimeType(metadata),
  };
}

export async function resizeAndConvert({
  inputBuffer,
  desiredFormat,
  width = 150,
}: {
  inputBuffer: Buffer;
  desiredFormat: keyof FormatEnum;
  width?: number;
}): Promise<{ buffer: Buffer; width: number; height: number; bytes: number }> {
  const { data: buffer, info } = await createImageTransform({
    input: inputBuffer,
    resize: { width },
    format: desiredFormat,
  }).toBuffer({ resolveWithObject: true });
  return { buffer, width: info.width, height: info.height, bytes: buffer.length };
}
