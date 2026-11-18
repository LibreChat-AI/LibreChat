import { createHash } from 'node:crypto';
import { BedrockDocumentError } from './limits';

export interface StoredSteerOwner {
  steerId: string;
  sourceMessageId: string;
  /** Opaque legacy binding coordinate, not the current content-array position. */
  partIndex: number;
  fileIds: string[];
  digest: string;
  repaired: boolean;
}
function record(value: unknown): Record<string, unknown> | undefined {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
export function steerReference(
  value: unknown,
): { fileId: string; steerId?: string; sourceMessageId?: string; partIndex?: number } | undefined {
  const source = record(record(record(value)?.document)?.source);
  if (typeof source?.librechatFile !== 'string') return undefined;
  return {
    fileId: source.librechatFile,
    steerId: typeof source.librechatSteer === 'string' ? source.librechatSteer : undefined,
    sourceMessageId:
      typeof source.librechatSteerSource === 'string' ? source.librechatSteerSource : undefined,
    partIndex:
      typeof source.librechatSteerPart === 'number' ? source.librechatSteerPart : undefined,
  };
}
/** Fingerprint the provider-equivalent message without retaining data or allocating full decoded images. */
export function steerContentDigest(content: unknown): string {
  if (!Array.isArray(content) || content.length > 4096) throw new BedrockDocumentError();
  const hash = createHash('sha256');
  for (const value of content) {
    const part = record(value);
    if (!part) throw new BedrockDocumentError();
    if (typeof part.text === 'string') {
      hash.update(`text:${Buffer.byteLength(part.text)}:`);
      hash.update(part.text);
      continue;
    }
    const ref = steerReference(part);
    if (ref) {
      const document = record(part.document)!;
      hash.update(
        JSON.stringify([
          'document',
          ref.fileId,
          ref.steerId,
          ref.sourceMessageId,
          ref.partIndex,
          document.name,
          document.format,
        ]),
      );
      continue;
    }
    const image = record(part.image);
    const source = record(image?.source);
    if (source?.bytes instanceof Uint8Array) {
      hash.update(
        JSON.stringify([
          'image',
          image?.format,
          createHash('sha256').update(source.bytes).digest('hex'),
        ]),
      );
      continue;
    }
    const imageUrl =
      typeof part.image_url === 'string' ? part.image_url : record(part.image_url)?.url;
    if (typeof imageUrl === 'string') {
      const match = /^data:image\/(\w+);base64,/.exec(imageUrl);
      if (!match) throw new BedrockDocumentError();
      const bytes = createHash('sha256');
      const start = match[0].length;
      for (let offset = start; offset < imageUrl.length; offset += 65536)
        bytes.update(Buffer.from(imageUrl.slice(offset, offset + 65536), 'base64'));
      hash.update(
        JSON.stringify(['image', match[1] === 'jpg' ? 'jpeg' : match[1], bytes.digest('hex')]),
      );
      continue;
    }
    throw new BedrockDocumentError();
  }
  return hash.digest('hex');
}
export function collectStoredSteerOwners(
  messages: Iterable<{
    messageId?: string;
    id?: string;
    content?: unknown;
    isCreatedByUser?: boolean;
    role?: string;
  }>,
): StoredSteerOwner[] {
  const owners = new Map<string, StoredSteerOwner>();
  const seen = new Set<string>();
  for (const message of messages) {
    if (message.isCreatedByUser !== false && message.role !== 'assistant') continue;
    if (!Array.isArray(message.content)) continue;
    for (const value of message.content) {
      const part = record(value),
        receipt = record(part?.bedrockSource);
      if (part?.type === 'steer' && typeof part.steerId === 'string') {
        if (seen.has(part.steerId)) throw new BedrockDocumentError();
        seen.add(part.steerId);
      }
      if (
        part?.type !== 'steer' ||
        typeof part.steerId !== 'string' ||
        !receipt ||
        typeof receipt.sourceMessageId !== 'string' ||
        receipt.sourceMessageId.length === 0 ||
        receipt.sourceMessageId !== (message.messageId ?? message.id) ||
        !Number.isSafeInteger(receipt.partIndex) ||
        Number(receipt.partIndex) < 0 ||
        typeof receipt.digest !== 'string' ||
        !/^[a-f0-9]{64}$/.test(receipt.digest) ||
        !Array.isArray(receipt.fileIds) ||
        receipt.fileIds.length === 0 ||
        receipt.fileIds.length > 4096 ||
        !receipt.fileIds.every((id) => typeof id === 'string' && id.length > 0)
      )
        continue;
      const fileIds = receipt.fileIds as string[];
      const active = Array.isArray(part.files)
        ? part.files.map((file) => record(file)?.file_id)
        : [];
      const repaired = part.bedrockRepaired === true;
      if (!repaired && !fileIds.every((id) => active.includes(id))) continue;
      owners.set(part.steerId, {
        steerId: part.steerId,
        sourceMessageId: receipt.sourceMessageId as string,
        partIndex: receipt.partIndex as number,
        fileIds: [...fileIds],
        digest: receipt.digest,
        repaired,
      });
    }
  }
  return [...owners.values()];
}
/** Validate every media block before either consumer may omit an owned message. */
export function validateSteerMedia(
  content: unknown,
  owners: readonly StoredSteerOwner[],
): StoredSteerOwner | undefined {
  if (!Array.isArray(content)) return undefined;
  const refs = content.flatMap((part) => {
    const ref = steerReference(part);
    return ref ? [ref] : [];
  });
  const claimed = refs.filter((ref) => ref.steerId !== undefined);
  if (!claimed.length) return undefined;
  const owner = owners.find((value) => value.steerId === claimed[0].steerId);
  if (owner)
    for (const value of content) {
      const part = record(value);
      if (!part) throw new BedrockDocumentError();
      if (
        part.files != null ||
        part.attachments != null ||
        part.file_ids != null ||
        part.image_file != null ||
        part.file != null
      )
        throw new BedrockDocumentError();
      const ref = steerReference(part);
      if (
        part.file_id != null &&
        (typeof part.file_id !== 'string' ||
          !owner.fileIds.includes(part.file_id) ||
          (ref && part.file_id !== ref.fileId))
      )
        throw new BedrockDocumentError();
    }

  if (
    !owner ||
    refs.some(
      (ref) =>
        ref.steerId !== owner.steerId ||
        ref.sourceMessageId !== owner.sourceMessageId ||
        ref.partIndex !== owner.partIndex ||
        !owner.fileIds.includes(ref.fileId),
    ) ||
    steerContentDigest(content) !== owner.digest
  )
    throw new BedrockDocumentError();
  return owner;
}
export function withoutRepairedSteerMedia(
  content: unknown,
  owners: readonly StoredSteerOwner[],
  source?: { kind?: unknown; sourceMessageId?: unknown },
): unknown {
  const owner = validateSteerMedia(content, owners);
  if (!owner) return content;
  if (
    source?.kind !== 'steer' ||
    (source.sourceMessageId != null && source.sourceMessageId !== owner.sourceMessageId)
  )
    throw new BedrockDocumentError();
  if (!owner.repaired) return content;
  return (content as unknown[]).filter((value) => typeof record(value)?.text === 'string');
}
