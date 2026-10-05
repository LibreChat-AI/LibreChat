import { useEffect, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  dataService,
  MutationKeys,
  mediaUploadResponseSchema,
  mediaURLUploadResponseSchema,
} from 'librechat-data-provider';
import type { MediaURLUploadRequest } from 'librechat-data-provider';
import type { MediaQueryScope } from './queries';
import { cacheMediaAssets } from './files';

type Upload<TBody> = { body: TBody; signal: AbortSignal };

/** File and URL uploads belong to the current editor and cannot outlive it. */
export function useMediaUpload(
  host: Pick<MediaQueryScope, 'isCurrentSession' | 'userId'>,
  ownerKey: string,
) {
  const client = useQueryClient();
  const [uploading, setUploading] = useState(false);
  const controller = useRef<AbortController>();
  const currentKey = useRef(ownerKey);
  currentKey.current = ownerKey;
  const file = useMutation([MutationKeys.uploadMedia, 'file'], async (input: Upload<FormData>) =>
    mediaUploadResponseSchema.parse(await dataService.uploadMedia(input.body, input.signal)),
  );
  const url = useMutation(
    [MutationKeys.uploadMedia, 'url'],
    async (input: Upload<MediaURLUploadRequest>) =>
      mediaURLUploadResponseSchema.parse(
        await dataService.uploadMediaURL(input.body, input.signal),
      ),
  );
  useEffect(() => {
    setUploading(false);
    return () => controller.current?.abort();
  }, [ownerKey]);
  const cancel = () => {
    controller.current?.abort();
    setUploading(false);
  };
  async function run<T>(load: (signal: AbortSignal) => Promise<T>): Promise<T | undefined> {
    controller.current?.abort();
    const request = new AbortController();
    controller.current = request;
    const current = () =>
      !request.signal.aborted && host.isCurrentSession() && currentKey.current === ownerKey;
    setUploading(true);
    try {
      const result = await load(request.signal);
      return current() ? result : undefined;
    } catch (error) {
      if (current()) throw error;
      return undefined;
    } finally {
      if (current()) setUploading(false);
    }
  }
  return {
    uploading,
    cancel,
    uploadFile: async (body: FormData) => {
      const result = await run((signal) => file.mutateAsync({ body, signal }));
      if (result) cacheMediaAssets(client, host.userId, [result.file]);
      return result;
    },
    uploadURL: async (body: MediaURLUploadRequest) => {
      const result = await run((signal) => url.mutateAsync({ body, signal }));
      if (result) cacheMediaAssets(client, host.userId, [result.file]);
      return result;
    },
  };
}
