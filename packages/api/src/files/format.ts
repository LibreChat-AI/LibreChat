import path from 'path';
import sharp from 'sharp';
import type { FormatEnum } from 'sharp';

type ImageFormatInput = {
  buffer: Buffer;
  type?: string;
  fileName: string;
  outputType: string;
};

/** Normalizes resized bytes and their filename to the configured output format. */
export async function convertImageBuffer({
  buffer,
  type,
  fileName,
  outputType,
}: ImageFormatInput): Promise<{ buffer: Buffer; fileName: string }> {
  const extension = path.extname(fileName);
  const targetExtension = `.${outputType}`;
  if (extension.toLowerCase() === targetExtension && type === `image/${outputType}`) {
    return { buffer, fileName };
  }

  return {
    buffer: await sharp(buffer)
      .toFormat(outputType as keyof FormatEnum)
      .toBuffer(),
    fileName: `${path.basename(fileName, extension)}${targetExtension}`,
  };
}
