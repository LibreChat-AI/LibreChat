import { v4 as uuidv4 } from 'uuid';
import { logger } from '@librechat/data-schemas';
import { FileContext } from 'librechat-data-provider';
import type { TImportError } from 'librechat-data-provider';
import type { ChatGptAttachment, ImportedAsset } from './types';
import type { AssetReference } from './chatgpt/content';
import type { ExportLayout } from './manifest';
import type { Archive } from './archive';
import { FILENAME_SEGMENT_MAX_BYTES, sanitizeFilename } from '~/utils/files';
import { recordItemError, recordError } from './errors';
import { ASSET_NAMES_ENTRY } from './manifest';

export interface SaveBufferInput {
  userId: string;
  buffer: Buffer;
  fileName: string;
  /** The asset's resolved MIME type. A deployment can point images and
   * documents at different backends, so the strategy cannot be chosen once for
   * a whole archive that mixes images, audio, video, and PDFs. */
  type: string;
  tenantId?: string;
}

export interface SavedAsset {
  filepath: string;
  /** The backend the bytes actually landed on, recorded on the file row so a
   * later read or delete resolves the same one. */
  source: string;
}

export type SaveAssetFn = (input: SaveBufferInput) => Promise<SavedAsset>;

export interface CreateFileInput {
  user: string;
  file_id: string;
  bytes: number;
  filepath: string;
  filename: string;
  type: string;
  source: string;
  context: string;
  tenantId?: string;
  /** Retention deadline, when the deployment sets one. */
  expiredAt?: Date;
}

export type CreateFileFn = (
  data: CreateFileInput,
  disableTTL: boolean,
) => Promise<{ file_id: string } | null>;

/** Removes one already-ingested asset: its storage object and its file row.
 * Optional so a provider with no assets, or a caller that cannot delete, is
 * unaffected. */
export type DeleteAssetFn = (asset: ImportedAsset) => Promise<void>;

export interface AssetDeps {
  saveBuffer: SaveAssetFn;
  createFile: CreateFileFn;
  deleteFile?: DeleteAssetFn;
}

export interface IngestInput {
  archive: Archive;
  layout: ExportLayout;
  userId: string;
  tenantId: string | undefined;
  pointers: string[];
  /** The retention deadline the conversations and messages of this import are
   * getting. An imported attachment has to expire with the conversation that
   * references it: without it the row and its storage object outlive the chat
   * they belong to, in exactly the deployments that require everything to
   * expire. `disableTTL` only suppresses the short upload TTL, which is a
   * different field. */
  expiredAt?: Date;
  deps: AssetDeps;
  /** Attachment metadata keyed by the raw id (pointer with its scheme
   * stripped). Supplies the authoritative `mime_type` the export recorded
   * for uploaded files, plus `width`/`height` when present. */
  attachments?: Map<string, ChatGptAttachment>;
  /** Dimensions recorded inline on `image_asset_pointer` parts, keyed by
   * the full pointer. Covers generated (`sediment://`) images, which never
   * appear in `metadata.attachments`. */
  references?: Map<string, AssetReference>;
  /** Called with the number of pointers processed so far (imported,
   * missing from the archive, or failed), so the count always reaches the
   * total the caller derived from the same pointer list. */
  onProgress?: (done: number) => void | Promise<void>;
  isCancelled?: () => Promise<boolean>;
}

export interface IngestResult {
  map: Map<string, ImportedAsset>;
  imported: number;
  unavailable: number;
  errors: TImportError[];
}

const MIME_BY_EXTENSION: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  wav: 'audio/wav',
  mp3: 'audio/mpeg',
  mp4: 'video/mp4',
  pdf: 'application/pdf',
};

const IMAGE_EXTENSION_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

function pointerId(pointer: string): string {
  return pointer.includes('://') ? pointer.split('://')[1] : pointer;
}

export function pointerToEntry(pointer: string): string {
  return `${pointerId(pointer)}.dat`;
}

function mimeFromExtension(filename: string): string | undefined {
  const extension = filename.split('.').pop()?.toLowerCase() ?? '';
  return MIME_BY_EXTENSION[extension];
}

function startsWith(buffer: Buffer, bytes: number[], offset = 0): boolean {
  if (buffer.length < offset + bytes.length) {
    return false;
  }
  for (let i = 0; i < bytes.length; i++) {
    if (buffer[offset + i] !== bytes[i]) {
      return false;
    }
  }
  return true;
}

/**
 * Last-resort MIME detection for assets whose original name the export
 * dropped: `conversation_asset_file_names.json` is optional, and without it
 * the fallback name is the bare `.dat` id, which carries no extension. An
 * image left as `application/octet-stream` renders as a download tile
 * instead of an image, so the magic bytes decide.
 */
function sniffMime(buffer: Buffer): string | undefined {
  if (startsWith(buffer, [0x89, 0x50, 0x4e, 0x47])) {
    return 'image/png';
  }
  if (startsWith(buffer, [0xff, 0xd8, 0xff])) {
    return 'image/jpeg';
  }
  if (startsWith(buffer, [0x47, 0x49, 0x46, 0x38])) {
    return 'image/gif';
  }
  if (startsWith(buffer, [0x52, 0x49, 0x46, 0x46])) {
    if (startsWith(buffer, [0x57, 0x45, 0x42, 0x50], 8)) {
      return 'image/webp';
    }
    if (startsWith(buffer, [0x57, 0x41, 0x56, 0x45], 8)) {
      return 'audio/wav';
    }
    return undefined;
  }
  if (startsWith(buffer, [0x66, 0x74, 0x79, 0x70], 4)) {
    return 'video/mp4';
  }
  if (startsWith(buffer, [0x49, 0x44, 0x33]) || startsWith(buffer, [0xff, 0xfb])) {
    return 'audio/mpeg';
  }
  if (startsWith(buffer, [0x25, 0x50, 0x44, 0x46])) {
    return 'application/pdf';
  }
  return undefined;
}

function isImageMime(mime: string): boolean {
  return mime.startsWith('image/');
}

/** Public image responses derive their content type from this path suffix. */
function normalizeImageExtension(filename: string, mime: string): string {
  const extension = IMAGE_EXTENSION_BY_MIME[mime];
  if (!extension) {
    return filename;
  }
  const lastDot = filename.lastIndexOf('.');
  const stem = lastDot > 0 ? filename.slice(0, lastDot) : filename;
  return `${stem}.${extension}`;
}

/**
 * `metadata.attachments[].mime_type` is what ChatGPT itself recorded for the
 * file, so it wins; the original filename's extension is the next best
 * signal, and content sniffing covers assets that have neither.
 *
 * With one exception: an *image* claim is only ever honoured by the bytes.
 * Both the manifest and the filename are attacker-controlled export content,
 * and the resolved type decides which backend the asset lands on: an
 * `image/*` type sends it to the `images` base, which on the local strategy
 * is `client/public/images`, served with no auth unless `secureImageLinks`
 * is on. So a crafted `image/png` wrapping SVG or HTML would otherwise be
 * anonymously retrievable. A file that claims to be an image and does not
 * sniff as one takes the sniffed type, or `application/octet-stream`, and
 * goes to `uploads` behind the authenticated download route. Image formats
 * the sniffer does not know (SVG among them) intentionally land there too.
 */
function resolveMime(
  attachment: ChatGptAttachment | undefined,
  originalName: string,
  buffer: Buffer,
): string {
  const declared = attachment?.mime_type ?? mimeFromExtension(originalName);
  const sniffed = sniffMime(buffer);
  if (declared === undefined) {
    return sniffed ?? 'application/octet-stream';
  }
  if (!isImageMime(declared)) {
    return declared;
  }
  return sniffed ?? 'application/octet-stream';
}

/**
 * `conversation_asset_file_names.json` and `metadata.attachments[].name` are
 * both attacker-controlled export content, and both have been observed to
 * carry the asset's original nested location rather than a bare leaf name
 * (e.g. `<conversation-id>/audio/<file>.wav`). Splitting on both `/` and `\`
 * (a crafted export can use either) and keeping only the final segment
 * strips any traversal (`../../etc/passwd` -> `passwd`) before the name ever
 * reaches a filesystem path, and gives the user a readable file name instead
 * of a directory prefix they never saw in ChatGPT.
 */
function originalLeafName(name: string): string {
  const segments = name.split(/[\\/]+/).filter((segment) => segment.length > 0);
  return segments.length > 0 ? segments[segments.length - 1] : name;
}

/**
 * Resolves the display name for one asset. `conversation_asset_file_names.json`
 * is the authoritative source when it has an entry; `metadata.attachments[].name`
 * is the same kind of export-recorded original name and covers assets the map
 * omits; the bare `.dat` id is the last resort. All three pass through
 * `originalLeafName` before use.
 */
function resolveOriginalName(
  entryName: string,
  names: Record<string, string>,
  attachment: ChatGptAttachment | undefined,
): string {
  const rawName = names[entryName] ?? attachment?.name ?? entryName.replace(/\.dat$/, '');
  return originalLeafName(rawName);
}

/**
 * The name map is optional decoration, so any shape other than a plain object
 * of strings is discarded rather than allowed to fail the assets that reference
 * it. `JSON.parse` succeeds for `null`, an array, and a nested object, and each
 * of those reaches `originalLeafName` and throws on `.split`, losing an
 * attachment over a cosmetic file the import does not need.
 */
function asNameMap(parsed: unknown): Record<string, string> {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return {};
  }

  const prototype = Object.getPrototypeOf(parsed);
  if (prototype !== Object.prototype && prototype !== null) {
    return {};
  }

  const entries = Object.entries(parsed);
  if (entries.some(([, value]) => typeof value !== 'string')) {
    return {};
  }

  return Object.fromEntries(entries) as Record<string, string>;
}

async function readAssetNames(
  archive: Archive,
  layout: ExportLayout,
): Promise<Record<string, string>> {
  if (!layout.assetNames) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse((await archive.read(ASSET_NAMES_ENTRY)).toString('utf8'));
    return asNameMap(parsed);
  } catch (error) {
    logger.warn('[import] Unreadable asset name map', error);
    return {};
  }
}

function buildImportedAsset(
  fileId: string,
  filepath: string,
  originalName: string,
  type: string,
  attachment: ChatGptAttachment | undefined,
  reference: AssetReference | undefined,
): ImportedAsset {
  const asset: ImportedAsset = { file_id: fileId, filepath, filename: originalName, type };
  const width = attachment?.width ?? reference?.width;
  const height = attachment?.height ?? reference?.height;
  if (width !== undefined) {
    asset.width = width;
  }
  if (height !== undefined) {
    asset.height = height;
  }
  return asset;
}

/** Reads one entry's bytes, hands them to storage, records the DB row, and
 * returns the `ImportedAsset` the caller renders. Kept separate from the
 * ingestion loop so a thrown storage/DB error is caught per-asset rather
 * than aborting the remaining pointers. */
async function ingestOne(
  pointer: string,
  entryName: string,
  names: Record<string, string>,
  input: IngestInput,
): Promise<ImportedAsset> {
  const { archive, userId, tenantId, deps } = input;
  const buffer = await archive.read(entryName);
  const attachment = input.attachments?.get(pointerId(pointer));
  const originalName = resolveOriginalName(entryName, names, attachment);
  const type = resolveMime(attachment, originalName, buffer);
  const fileId = uuidv4();
  /** `originalName` is already a leaf (no separators), but it is still
   * attacker-controlled export content; `sanitizeFilename` is the one
   * vetted place that turns it into a safe storage-path segment (ASCII
   * punctuation allow-list, dotfile guard, NAME_MAX truncation). The
   * `fileId` prefix is a fresh `uuidv4()` per asset, so two entries whose
   * names sanitize to the same string still land at distinct paths. */
  const storageName = normalizeImageExtension(originalName, type);
  const prefix = `${fileId}-`;
  const nameBytes = FILENAME_SEGMENT_MAX_BYTES - Buffer.byteLength(prefix, 'utf8');
  const fileName = `${prefix}${sanitizeFilename(storageName, nameBytes)}`;

  const { filepath, source } = await deps.saveBuffer({ userId, buffer, fileName, type, tenantId });

  try {
    await deps.createFile(
      {
        user: userId,
        file_id: fileId,
        bytes: buffer.byteLength,
        filepath,
        filename: originalName,
        type,
        source,
        context: FileContext.message_attachment,
        tenantId,
        ...(input.expiredAt ? { expiredAt: input.expiredAt } : {}),
      },
      true,
    );
  } catch (error) {
    /** The bytes are in storage but no row points at them, and the caller only
     * learns an asset exists once this function resolves, so nothing else
     * could ever find this object to clean up. */
    try {
      await deps.deleteFile?.({ file_id: fileId, filepath, filename: originalName, type });
    } catch (cleanupError) {
      logger.error(`[import] Could not roll back the stored asset ${fileId}`, cleanupError);
    }
    throw error;
  }

  return buildImportedAsset(
    fileId,
    filepath,
    originalName,
    type,
    attachment,
    input.references?.get(pointer),
  );
}

export async function ingestAssets(input: IngestInput): Promise<IngestResult> {
  const { archive, layout, pointers } = input;

  const present = new Set(layout.assetEntries.map((entry) => entry.name));
  const names = await readAssetNames(archive, layout);

  const map = new Map<string, ImportedAsset>();
  const errors: TImportError[] = [];
  let imported = 0;
  let unavailable = 0;

  const unique = Array.from(new Set(pointers));
  let processed = 0;

  for (const pointer of unique) {
    if (typeof pointer !== 'string' || pointer.trim().length === 0) {
      unavailable += 1;
      processed += 1;
      recordError(errors, { code: 'asset_pointer_invalid' });
      await input.onProgress?.(processed);
      continue;
    }

    if (input.isCancelled) {
      try {
        if (await input.isCancelled()) {
          break;
        }
      } catch (error) {
        logger.error('[import] Could not read asset-import cancellation state', error);
      }
    }

    const entryName = pointerToEntry(pointer);
    if (!present.has(entryName)) {
      unavailable += 1;
      processed += 1;
      await input.onProgress?.(processed);
      continue;
    }

    try {
      const asset = await ingestOne(pointer, entryName, names, input);
      map.set(pointer, asset);
      imported += 1;
    } catch (error) {
      /** The pointer named a real entry, but nothing was stored for it, so
       * every message that references it renders without the attachment. */
      unavailable += 1;
      recordItemError(errors, error, `import asset ${entryName}`, entryName);
    }

    processed += 1;
    await input.onProgress?.(processed);
  }

  return { map, imported, unavailable, errors };
}
