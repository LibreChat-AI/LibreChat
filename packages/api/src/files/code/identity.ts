import path from 'node:path';
import { CODE_ENV_KINDS } from 'librechat-data-provider';
import type { CodeEnvKind } from 'librechat-data-provider';
import type FormData from 'form-data';

/**
 * Resource identity required by codeapi's sessionKey resolver. The
 * shape is symmetric across the upload form fields and the URL query
 * params on download/freshness routes — codeapi normalizes both into
 * the same `parseUploadSessionKeyInput`. Validation rules (closed
 * kind set, `version` required for `'skill'` and forbidden otherwise)
 * mirror codeapi's validator so a bad caller fails fast on the client
 * instead of round-tripping a 400. See codeapi #1455 / Phase C.
 *
 * `id` is sessionKey-meaningful for `'skill'` / `'agent'` and
 * informational-only for `'user'` (codeapi resolves user identity
 * from auth context). It's required uniformly here for shape
 * consistency with the runtime validator.
 */
export interface CodeEnvIdentity {
  kind: CodeEnvKind;
  id: string;
  /** Required when `kind === 'skill'`; forbidden otherwise. */
  version?: number;
}

const VALID_KINDS = new Set<string>(CODE_ENV_KINDS);

const validateIdentity = (identity: CodeEnvIdentity, callerLabel: string): void => {
  const { kind, id, version } = identity;
  if (!kind || !VALID_KINDS.has(kind)) {
    throw new Error(`${callerLabel}: invalid kind "${kind}"`);
  }
  if (!id) {
    throw new Error(`${callerLabel}: missing id for kind "${kind}"`);
  }
  if (kind === 'skill' && version == null) {
    throw new Error(`${callerLabel}: kind "skill" requires a numeric version`);
  }
  if (kind !== 'skill' && version != null) {
    throw new Error(`${callerLabel}: version is only valid for kind "skill"`);
  }
};

/**
 * Append `kind`/`id`/`version?` form fields to a multipart upload.
 * Used by `uploadCodeEnvFile` and `batchUploadCodeEnvFiles` so codeapi
 * can route the upload to the correct sessionKey bucket
 * (`<tenant>:<kind>:<id>[:v:<version>]` for shared kinds,
 * `<tenant>:user:<authContext.userId>` for `'user'`).
 *
 * Mutates the form in place and throws synchronously on bad input.
 */
export function appendCodeEnvFileIdentity(form: FormData, identity: CodeEnvIdentity): void {
  validateIdentity(identity, 'appendCodeEnvFileIdentity');
  form.append('kind', identity.kind);
  form.append('id', identity.id);
  if (identity.version != null) {
    form.append('version', String(identity.version));
  }
}

/**
 * Build the `?kind=...&id=...&version=...` query string codeapi's
 * `sessionAuth` middleware requires on `/download/<session>/<file>`
 * and `/sessions/<session>/objects/<file>` URLs. Without these,
 * codeapi 400s with "kind must be one of: skill, agent, user" before
 * serving the file.
 *
 * Returns a string with leading `?`; concatenate onto a path.
 */
/**
 * The same `kind`/`id`/`version?` identity as an axios `params` object, for callers that
 * build their query that way rather than concatenating a string. Both forms exist so the
 * identity codeapi's `sessionAuth` needs is stated once.
 */
export function buildCodeEnvIdentityParams(identity: CodeEnvIdentity): Record<string, string> {
  validateIdentity(identity, 'buildCodeEnvIdentityParams');
  return {
    kind: identity.kind,
    id: identity.id,
    ...(identity.version != null ? { version: String(identity.version) } : {}),
  };
}

export function buildCodeEnvDownloadQuery(identity: CodeEnvIdentity): string {
  validateIdentity(identity, 'buildCodeEnvDownloadQuery');
  const params = new URLSearchParams({ kind: identity.kind, id: identity.id });
  if (identity.version != null) {
    params.set('version', String(identity.version));
  }
  return `?${params.toString()}`;
}

/** Summary keys follow Code API's canonicalObjectKey/legacyObjectId storage contract. */
export function getCodeEnvSessionFileIds(
  files: readonly unknown[],
  sessionId: string,
): Set<string> {
  const ids = new Set<string>();
  const prefix = `${sessionId}/`;
  const canonicalDirectory = '.codeapi-objects/';
  for (const file of files) {
    if (file == null || typeof file !== 'object') {
      continue;
    }
    if ('fileId' in file && typeof file.fileId === 'string' && file.fileId !== '') {
      ids.add(file.fileId);
      continue;
    }
    if (!('name' in file) || typeof file.name !== 'string' || !file.name.startsWith(prefix)) {
      continue;
    }
    const name = file.name.slice(prefix.length);
    if (name.startsWith(canonicalDirectory)) {
      const encoded = name.slice(canonicalDirectory.length);
      if (!/^[A-Za-z0-9_-]+$/.test(encoded)) {
        continue;
      }
      const id = Buffer.from(encoded, 'base64url').toString('utf8');
      if (id && Buffer.from(id, 'utf8').toString('base64url') === encoded) {
        ids.add(id);
      }
      continue;
    }
    if (!name || name === '.' || name === '..' || /[/\\\p{Cc}]/u.test(name)) {
      continue;
    }
    // Legacy storage appends the filename's final extension, including for dotted IDs.
    const extension = path.posix.extname(name);
    const id = extension === '' ? name : name.slice(0, -extension.length);
    if (id) {
      ids.add(id);
    }
  }
  return ids;
}
