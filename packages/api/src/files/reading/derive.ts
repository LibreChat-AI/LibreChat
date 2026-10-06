import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { logger } from '@librechat/data-schemas';
import { fileConfig, selectBuiltInTextPlan } from 'librechat-data-provider';
import type {
  FiltersConfig,
  BuiltInTextPlan,
  TextDerivation,
  RegexLike,
} from 'librechat-data-provider';
import type {
  DerivedText,
  TurnReadingFile,
  FileTextDeriver,
  DerivationSkipReason,
  DerivationPolicyError,
} from './turn';
import type { UploadFallbackTextExtractors, BoundedText } from '~/files/upload/fallback';
import type { ProvisionService } from '~/files/provision/service';
import type { ServerRequest } from '~/types';
import { DOCUMENT_PARSER_MAX_FILE_SIZE } from '~/files/documents/crud';
import { isAttachmentObjectNotFoundError } from '~/files/encode/utils';
import { MAX_STORED_EXTRACTED_TEXT_BYTES } from '~/files/extract';
import { ContentFilterError } from '~/middleware/contentFilter';
import { runGuardedEncode } from '~/files/encode/memoryGuard';
import { extractBoundedText } from '~/files/upload/fallback';
import { UninspectableFileError } from '~/protection/files';
import { getSafeErrorMetadata } from '~/utils/errors';

export interface FileTextDeriverDeps {
  req: ServerRequest;
  /** Opens the record's retained original; the provision service's `openStoredFile`. */
  openStoredFile: ProvisionService['openStoredFile'];
  filters?: FiltersConfig;
  /** The built-in extractors; RAG and OCR never run at turn time. */
  extractors?: UploadFallbackTextExtractors;
  /**
   * The deployment's text allowlist (`fileConfig.text.supportedMimeTypes`). A natively readable
   * type outside it is not parsed, as upload extraction refuses it; absent means unrestricted.
   */
  textMimeTypes?: RegexLike[];
}

/** The largest file each built-in extractor accepts, checked before anything is downloaded. */
const PLAN_MAX_BYTES: Readonly<Record<BuiltInTextPlan, number>> = {
  document_parser: DOCUMENT_PARSER_MAX_FILE_SIZE,
  native_text: MAX_STORED_EXTRACTED_TEXT_BYTES,
};

/** Codes storage backends report for one missing object, as opposed to a missing bucket. */
const OBJECT_NOT_FOUND_CODES: ReadonlySet<string> = new Set([
  'NoSuchKey',
  'BlobNotFound',
  'storage/object-not-found',
]);

interface StorageErrorShape {
  name?: string;
  code?: string;
  path?: string;
}

/**
 * Whether storage reports the original itself gone. A missing bucket or container, a status code
 * alone, and any error on the temporary copy are not: those clear up, so a later turn retries.
 * The same holds inside the extractor: a system error while it reads the temporary copy is not
 * kept on the record, only a failure the parser names.
 */
function isOriginalMissing(error: unknown, tmpPath: string): boolean {
  if (isAttachmentObjectNotFoundError(error)) {
    return true;
  }
  if (typeof error !== 'object' || error == null) {
    return false;
  }
  const storageError: StorageErrorShape = error;
  if (storageError.code === 'ENOENT') {
    return storageError.path != null && storageError.path !== tmpPath;
  }
  return (
    OBJECT_NOT_FOUND_CODES.has(storageError.name ?? '') ||
    OBJECT_NOT_FOUND_CODES.has(storageError.code ?? '')
  );
}

const skipped = (reason: DerivationSkipReason): DerivedText => ({ status: 'skipped', reason });

const failed = (
  extractor: BuiltInTextPlan,
  reason: NonNullable<TextDerivation['reason']>,
): DerivedText => ({
  status: 'failed',
  textDerivation: { outcome: 'failed', extractor, reason, at: Date.now() },
  persist: true,
});

/** A policy refusal of the derived text, logged with the rule that refused it. */
function blocked(
  file: TurnReadingFile,
  result: Exclude<BoundedText, { text: string }>,
): DerivationPolicyError {
  if (result.failure === 'policy') {
    logger.warn(
      `[readingText] file_id=${file.file_id} outcome=blocked rule=${result.finding.ruleId}`,
    );
    return new ContentFilterError(result.finding);
  }
  logger.warn(`[readingText] file_id=${file.file_id} outcome=blocked reason=uninspectable`);
  return result.error instanceof UninspectableFileError
    ? result.error
    : new UninspectableFileError('extracted_text');
}

function toDerivedText(
  file: TurnReadingFile,
  plan: BuiltInTextPlan,
  result: BoundedText,
): DerivedText {
  if ('text' in result) {
    return {
      status: 'derived',
      text: result.text,
      textDerivation: { outcome: 'complete', extractor: plan, at: Date.now() },
    };
  }
  if (result.failure === 'policy' || result.failure === 'uninspectable') {
    return { status: 'blocked', error: blocked(file, result) };
  }
  if (result.failure === 'unavailable') {
    logger.error(
      `[readingText] file_id=${file.file_id} outcome=skipped reason=storage_unavailable`,
      getSafeErrorMetadata(result.error),
    );
    return skipped('storage_unavailable');
  }
  return failed(plan, result.failure);
}

function classifyReadError(
  file: TurnReadingFile,
  plan: BuiltInTextPlan,
  error: unknown,
  { signal, tmpPath }: { signal?: AbortSignal; tmpPath: string },
): DerivedText {
  if (signal?.aborted) {
    return skipped('aborted');
  }
  if (isOriginalMissing(error, tmpPath)) {
    return failed(plan, 'original_missing');
  }
  logger.error(
    `[readingText] file_id=${file.file_id} outcome=skipped reason=storage_unavailable`,
    getSafeErrorMetadata(error),
  );
  return skipped('storage_unavailable');
}

function describeDerivation(result: DerivedText): string {
  if (result.status === 'derived') {
    return `outcome=complete extractor=${result.textDerivation.extractor}`;
  }
  if (result.status === 'failed') {
    return `outcome=failed reason=${result.textDerivation.reason}`;
  }
  if (result.status === 'blocked') {
    return 'outcome=blocked';
  }
  return `outcome=skipped reason=${result.reason}`;
}

/** An outcome a later caller should not inherit: a derivation its own caller's signal cut short. */
const isAborted = (result: DerivedText): boolean =>
  result.status === 'skipped' && result.reason === 'aborted';

/**
 * Builds a request's text deriver: reads a record's retained original back from storage and runs
 * the one built-in extractor its type allows, under the same caps as upload extraction. Size caps
 * are checked from the record before anything is downloaded; the download runs inside the encode
 * memory guard, the parser checks the size actually downloaded, and the temporary copy is always
 * removed. The deriver derives each file at most once, so the host builds one per request and
 * hands it to every agent. A deterministic failure may be kept on the record and a policy refusal
 * blocks the turn that needed the text. An unreachable store is not kept, and an aborted
 * derivation is forgotten, so the next caller derives under its own signal.
 */
export function createFileTextDeriver({
  req,
  openStoredFile,
  filters,
  extractors,
  textMimeTypes,
}: FileTextDeriverDeps): FileTextDeriver {
  const derivations = new Map<string, Promise<DerivedText>>();

  const readOriginal = async (
    file: TurnReadingFile,
    plan: BuiltInTextPlan,
    signal?: AbortSignal,
  ): Promise<DerivedText> => {
    const tmpPath = path.join(
      os.tmpdir(),
      `derive-${file.file_id}-${randomUUID()}${path.extname(file.filename ?? '')}`,
    );
    try {
      signal?.throwIfAborted();
      const stream = await openStoredFile(file, req, signal);
      if (stream == null) {
        return skipped('storage_unavailable');
      }
      await pipeline(stream, fs.createWriteStream(tmpPath), { signal });
      const { size } = await fs.promises.stat(tmpPath);
      const upload = {
        path: tmpPath,
        originalname: file.filename ?? path.basename(tmpPath),
        mimetype: file.type ?? '',
        size,
      } as Express.Multer.File;
      const result = await extractBoundedText({ file: upload, filters, plan, extractors });
      if (signal?.aborted) {
        return skipped('aborted');
      }
      return toDerivedText(file, plan, result);
    } catch (error) {
      return classifyReadError(file, plan, error, { signal, tmpPath });
    } finally {
      await fs.promises.rm(tmpPath, { force: true }).catch(() => undefined);
    }
  };

  const deriveOnce = (file: TurnReadingFile, signal?: AbortSignal): Promise<DerivedText> => {
    const type = file.type ?? '';
    const plan = selectBuiltInTextPlan(type);
    if (plan == null) {
      return Promise.resolve(skipped('no_extractor'));
    }
    /* Upload extraction consults the allowlist only for types the native text reader takes;
     * document types reach the parser regardless, so the same holds here. */
    if (
      plan === 'native_text' &&
      textMimeTypes != null &&
      !fileConfig.checkType(type, textMimeTypes)
    ) {
      return Promise.resolve(skipped('no_extractor'));
    }
    const bytes = file.bytes ?? 0;
    if (bytes > PLAN_MAX_BYTES[plan]) {
      return Promise.resolve(failed(plan, 'too_large'));
    }
    return runGuardedEncode(bytes, () => readOriginal(file, plan, signal));
  };

  const derive = async (file: TurnReadingFile, signal?: AbortSignal): Promise<DerivedText> => {
    const startedAt = Date.now();
    const result = await deriveOnce(file, signal);
    logger.debug(
      `[readingText] file_id=${file.file_id} ${describeDerivation(result)} ms=${Date.now() - startedAt}`,
    );
    return result;
  };

  const forget = (fileId: string, derivation: Promise<DerivedText>): void => {
    if (derivations.get(fileId) === derivation) {
      derivations.delete(fileId);
    }
  };

  return (file, signal) => {
    const existing = derivations.get(file.file_id);
    if (existing != null) {
      return existing;
    }
    const derivation = derive(file, signal);
    derivations.set(file.file_id, derivation);
    derivation.then(
      (result) => {
        if (isAborted(result)) {
          forget(file.file_id, derivation);
        }
      },
      () => forget(file.file_id, derivation),
    );
    return derivation;
  };
}
