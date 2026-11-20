import { createHash } from 'node:crypto';
import { FileContext, getCodeEnvRefForProfile } from 'librechat-data-provider';
import type { CodeEnvRef, CodeEnvRefContent, TFile } from 'librechat-data-provider';

/** What the Code API reports about one stored object, from its metadata or a session listing. */
export interface CodeObjectInfo {
  lastModified?: string;
  etag?: string;
  size?: number;
}

/** A pointer whose upload recorded what it stored. */
export type CodeUploadReceipt = CodeEnvRef & { content: CodeEnvRefContent };

/** Matches the existing 23-hour code-storage freshness window. */
export function checkCodeFileActive(dateString: string | undefined): boolean {
  return dateString != null && (Date.now() - new Date(dateString).getTime()) / 3_600_000 < 23;
}

function md5Hex(buffer: Buffer): string | undefined {
  try {
    return createHash('md5').update(buffer).digest('hex');
  } catch {
    /* FIPS runtimes refuse MD5. Without it no later probe can match, so the upload repeats. */
    return undefined;
  }
}

/** Digests the exact bytes an upload sends, in the forms the record and the object store use. */
export function digestCodeUpload(buffer: Buffer): CodeEnvRefContent {
  const md5 = md5Hex(buffer);
  return {
    sha256: createHash('sha256').update(buffer).digest('hex'),
    bytes: buffer.length,
    ...(md5 ? { md5 } : {}),
  };
}

/**
 * Whether every execution on a route mounts its inputs from the stored objects.
 *
 * The default profile never sends a runtime session hint, so the Code API runs each call in a
 * fresh sandbox that downloads every referenced object. A stateful route keeps a workspace and
 * reuses the copy already on disk for a reference it has seen, even after code rewrote that
 * copy, so an unchanged stored object says nothing about the bytes a later call will read.
 */
export function mountsStoredObjects(routeKey: string): boolean {
  return routeKey === 'default';
}

/**
 * The upload receipt that can stand in for re-uploading a generated-file snapshot, if any.
 *
 * A snapshot's stored bytes are the source of truth, so a pointer is only a candidate when the
 * upload behind it digested the same content version the record still holds, on a route that
 * mounts stored objects. The stored object must still be matched by {@link provesStoredContent}.
 */
export function getSnapshotReceipt(
  file: Pick<TFile, 'context' | 'metadata'>,
  routeKey: string,
): CodeUploadReceipt | undefined {
  if (file.context !== FileContext.execute_code_snapshot || !mountsStoredObjects(routeKey)) {
    return undefined;
  }
  const ref = getCodeEnvRefForProfile(file.metadata, routeKey);
  const version = file.metadata?.codeOutput?.sha256;
  if (!ref?.content || !version || ref.content.sha256 !== version) {
    return undefined;
  }
  return { ...ref, content: ref.content };
}

function normalizeEtag(etag: string): string {
  return etag.replace(/^W\//, '').replace(/^"|"$/g, '').toLowerCase();
}

/**
 * Whether the object store still holds exactly what the receipt's upload sent. Single-part
 * objects report their MD5 as the entity tag; a multipart or encrypted tag never matches, which
 * leaves the snapshot to be uploaded again rather than trusted.
 */
export function provesStoredContent(
  content: CodeEnvRefContent,
  info: CodeObjectInfo | null | undefined,
): boolean {
  return (
    content.md5 != null &&
    typeof info?.etag === 'string' &&
    normalizeEtag(info.etag) === content.md5 &&
    info.size === content.bytes
  );
}
