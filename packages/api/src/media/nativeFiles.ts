import { FileSources } from 'librechat-data-provider';
import type { NativeMessageFile, MediaOwnerScope } from '@librechat/data-schemas';
import type { GeneratedImageRequest } from '~/files/generated';
import type { MediaStrategyResolver } from './objects';
import { resolveDownloadPath } from '~/storage/path';
import { MediaServiceError } from './errors';

/** The repository authorizes the normal File before its existing strategy opens the bytes. */
export async function readNativeMessageImage(
  getStrategy: MediaStrategyResolver,
  request: GeneratedImageRequest,
  scope: MediaOwnerScope,
  file: NativeMessageFile,
  maxBytes: number,
): Promise<Buffer> {
  const source = file.source ?? FileSources.local;
  if (
    source !== FileSources.local &&
    source !== FileSources.s3 &&
    source !== FileSources.cloudfront &&
    source !== FileSources.firebase &&
    source !== FileSources.azure_blob
  ) {
    throw new MediaServiceError('unsupported', 422, 'Native image storage is unavailable.');
  }
  if (file.bytes > maxBytes)
    throw new MediaServiceError('invalid_request', 413, 'Native image exceeds its replay limit.');
  const stream = await getStrategy(source).getDownloadStream(
    Object.assign(Object.create(request), {
      user: { ...request.user, id: scope.ownerId, tenantId: scope.tenantId ?? undefined },
    }),
    resolveDownloadPath(file),
  );
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    for await (const value of stream) {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      bytes += chunk.length;
      if (bytes > maxBytes)
        throw new MediaServiceError(
          'invalid_request',
          413,
          'Native image exceeds its replay limit.',
        );
      chunks.push(chunk);
    }
  } finally {
    stream.destroy();
  }
  return Buffer.concat(chunks, bytes);
}
