import path from 'path';
import sharp from 'sharp';
import { createHash } from 'node:crypto';
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
}: ImageFormatInput): Promise<{ buffer: Buffer; fileName: string; sha256: string }> {
  const extension = path.extname(fileName);
  const targetExtension = `.${outputType}`;
  const output =
    extension.toLowerCase() === targetExtension && type === `image/${outputType}`
      ? { buffer, fileName }
      : {
          buffer: await sharp(buffer)
            .toFormat(outputType as keyof FormatEnum)
            .toBuffer(),
          fileName: `${path.basename(fileName, extension)}${targetExtension}`,
        };
  return { ...output, sha256: createHash('sha256').update(output.buffer).digest('hex') };
}
