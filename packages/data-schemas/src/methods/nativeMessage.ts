import { parseNativeMessageReference } from 'librechat-data-provider';
import type { NativeSignatures } from 'librechat-data-provider';
import type { MediaOwnerScope } from '~/types/media';
import { mediaScopeFilter, positiveMediaLimit } from '~/utils/media';
import { createMessageModel } from '~/models/message';
import { createFileModel } from '~/models/file';

export type NativeMessageFile = {
  file_id: string;
  filename: string;
  filepath: string;
  type: string;
  bytes: number;
  source?: string;
  storageKey?: string;
  storageRegion?: string;
};
export type NativeMessagePart =
  | { kind: 'text'; text: string; thoughtSignature?: string }
  | { kind: 'image'; file: NativeMessageFile; thoughtSignature?: string };
export interface NativeMessageMethods {
  getNativeMessageParts(input: {
    scope: MediaOwnerScope;
    conversationId: string;
    references: readonly { continuationRef: string; fileId?: string }[];
    limit: number;
  }): Promise<Array<NativeMessagePart | null>>;
}

/** Replay belongs to the owning assistant Message and ordinary File records. */
export function createNativeMessageMethods(
  mongoose: typeof import('mongoose'),
): NativeMessageMethods {
  const Message = createMessageModel(mongoose);
  const File = createFileModel(mongoose);
  return {
    async getNativeMessageParts({ scope, conversationId, references, limit }) {
      const scoped = mediaScopeFilter(scope);
      positiveMediaLimit(limit);
      if (!conversationId || references.length > limit)
        throw new Error('Invalid native message replay scope or batch');
      if (!references.length) return [];
      const owner = { user: scoped.ownerId, tenantId: scoped.tenantId };
      const now = new Date();
      const refs = references.map(({ continuationRef }) => continuationRef);
      const messages = await Message.find({
        ...owner,
        conversationId,
        isCreatedByUser: false,
        isUserSubmitted: { $ne: true },
        'content.native_media.continuationRef': { $in: refs },
        $or: [{ expiredAt: null }, { expiredAt: { $gt: now } }],
      })
        .select({ content: 1, 'metadata.nativeSignatures': 1 })
        .limit(limit)
        .lean();
      const parts = new Map<
        string,
        { text?: string; fileId?: string; signature: NativeSignatures[string] }
      >();
      for (const message of messages) {
        const signatures = message.metadata?.nativeSignatures as NativeSignatures | undefined;
        if (!signatures || !Array.isArray(message.content)) continue;
        for (const value of message.content) {
          if (!value || typeof value !== 'object') continue;
          const part = value as {
            type?: string;
            text?: string;
            native_media?: { continuationRef?: string };
            image_file?: { file_id?: string };
          };
          const ref = part.native_media?.continuationRef;
          if (!ref || !refs.includes(ref)) continue;
          const parsed = parseNativeMessageReference(ref);
          const signature = parsed && signatures[parsed.index];
          if (
            !signature ||
            (signature.thoughtSignature != null && typeof signature.thoughtSignature !== 'string')
          )
            continue;
          if (
            part.type === 'text' &&
            typeof part.text === 'string' &&
            signature.text === part.text
          ) {
            parts.set(ref, { text: part.text, signature });
          } else if (part.type === 'image_file' && typeof part.image_file?.file_id === 'string') {
            parts.set(ref, { fileId: part.image_file.file_id, signature });
          }
        }
      }
      const fileIds = [
        ...new Set([...parts.values()].flatMap((part) => (part.fileId ? [part.fileId] : []))),
      ];
      const files = fileIds.length
        ? await File.find({
            ...owner,
            file_id: { $in: fileIds },
            $or: [{ expiredAt: null }, { expiredAt: { $gt: now } }],
          })
            .select({
              file_id: 1,
              filename: 1,
              filepath: 1,
              type: 1,
              bytes: 1,
              source: 1,
              storageKey: 1,
              storageRegion: 1,
            })
            .lean()
        : [];
      const byId = new Map(files.map((file) => [file.file_id, file]));
      return references.map(({ continuationRef, fileId }) => {
        const part = parts.get(continuationRef);
        if (!part) return null;
        if (part.text != null && !fileId)
          return {
            kind: 'text',
            text: part.text,
            thoughtSignature: part.signature.thoughtSignature,
          };
        const file = part.fileId && byId.get(part.fileId);
        if (!file || (fileId && fileId !== file.file_id) || file.type !== part.signature.mimeType)
          return null;
        return { kind: 'image', file, thoughtSignature: part.signature.thoughtSignature };
      });
    },
  };
}
