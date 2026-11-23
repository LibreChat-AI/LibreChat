import sharp from 'sharp';
import type { Artifacts, FormattedContent } from '~/mcp/types';

/**
 * Downscales an image buffer until its encoded size fits within `maxBytes`,
 * preserving the original aspect ratio and image format.
 *
 * Encoded size scales roughly with pixel area, so each pass targets the square
 * root of the size ratio (with a safety margin) and re-encodes from the source
 * buffer to avoid cumulative quality loss. The input is returned unchanged when
 * it already fits, when `maxBytes` is not positive, or when the buffer cannot be
 * decoded as a raster image.
 *
 * @param inputBuffer - The source image buffer.
 * @param maxBytes - The maximum allowed encoded size, in bytes.
 * @returns A buffer that fits within `maxBytes` when achievable, otherwise the
 *   smallest buffer produced.
 */
export async function resizeImageToFit(inputBuffer: Buffer, maxBytes: number): Promise<Buffer> {
  if (maxBytes <= 0 || inputBuffer.length <= maxBytes) {
    return inputBuffer;
  }

  let width: number | undefined;
  let height: number | undefined;
  try {
    ({ width, height } = await sharp(inputBuffer).metadata());
  } catch {
    return inputBuffer;
  }

  if (!width || !height) {
    return inputBuffer;
  }

  let scale = 1;
  let output = inputBuffer;

  for (let attempt = 0; attempt < 6 && output.length > maxBytes; attempt++) {
    scale *= Math.sqrt(maxBytes / output.length) * 0.9;
    const targetWidth = Math.max(1, Math.round(width * scale));
    const targetHeight = Math.max(1, Math.round(height * scale));

    output = await sharp(inputBuffer)
      .resize({ width: targetWidth, height: targetHeight, fit: 'inside', withoutEnlargement: true })
      .toBuffer();

    if (targetWidth <= 1 && targetHeight <= 1) {
      break;
    }
  }

  return output;
}

// Bedrock accepts at most 5 MiB of base64 per image, including encoding expansion.
const MAX_IMAGE_BYTES = Math.floor((5 * 1024 * 1024) / 4) * 3;

/** Keep original generation bytes for storage and a bounded copy for model input. */
export async function createImageToolArtifact(input: Buffer): Promise<NonNullable<Artifacts>> {
  const { format } = await sharp(input).metadata();
  if (format !== 'png' && format !== 'jpeg' && format !== 'webp' && format !== 'gif') {
    throw new Error('Unsupported generated image format');
  }
  const modelImage = await resizeImageToFit(input, MAX_IMAGE_BYTES);
  if (modelImage.length > MAX_IMAGE_BYTES) {
    throw new Error('Generated image exceeds the model image limit');
  }
  const content: FormattedContent[] = [
    {
      type: 'image_url',
      image_url: { url: `data:image/${format};base64,${modelImage.toString('base64')}` },
    },
  ];
  if (modelImage === input) {
    return { content };
  }
  return {
    content,
    imageAttachments: [
      {
        type: 'image_url',
        image_url: { url: `data:image/${format};base64,${input.toString('base64')}` },
      },
    ],
  };
}

/** Existing storage policy applies to originals, including configured resolution. */
export function getImageAttachmentContent(artifact: NonNullable<Artifacts>): FormattedContent[] {
  return artifact.imageAttachments ?? artifact.content ?? [];
}
