import path from 'path';
import crypto from 'crypto';
import fs from 'fs/promises';
import { logger } from '@librechat/data-schemas';
import type { Request, Response } from 'express';
import type { ScannerClient } from './scanner';
import type { NmbConfig } from './types';
import { screenFile, screenText, type Screened } from './screen';
import { sendNmbError, CLEARED_SUFFIX } from './chat';
import { resolveIdentity } from './identity';
import { isNmbMisconfigured } from './config';

const SCANNED_DOCUMENTS = new Set(['.docx', '.pdf', '.xlsx']);
const SCANNED_TEXT = new Set(['.txt', '.csv', '.tsv', '.md', '.json', '.xml', '.log']);

export interface UploadedFile {
  path: string;
  filename: string;
  originalname: string;
  mimetype: string;
  size: number;
}

export interface NmbUploadDeps {
  config: NmbConfig;
  scanner: ScannerClient;
  createNmbFileHold: (hold: { userId: string; sha256: string; reviewId: string }) => Promise<void>;
  findNmbFileHolds: (userId: string, sha256: string) => Promise<Array<{ reviewId: string }>>;
  consumeNmbFileHold: (reviewId: string, userId: string) => Promise<boolean>;
}

export const isGatedFileType = (name: string): boolean => {
  const ext = path.extname(name).toLowerCase();
  return SCANNED_DOCUMENTS.has(ext) || SCANNED_TEXT.has(ext);
};

/**
 * Swaps the multer temp file for the sanitised markdown, so nothing downstream (text extraction,
 * embedding, native provider delivery) ever sees the original bytes. The original is deleted.
 */
async function replaceWithSanitised(file: UploadedFile, content: string): Promise<void> {
  const clearedName = `${file.originalname}${CLEARED_SUFFIX}`;
  const next = path.join(path.dirname(file.path), `${crypto.randomUUID()}-${clearedName}`);
  await fs.writeFile(next, content, { encoding: 'utf8', mode: 0o600 });
  const previous = file.path;
  file.path = next;
  file.filename = path.basename(next);
  file.originalname = clearedName;
  file.mimetype = 'text/markdown';
  file.size = Buffer.byteLength(content, 'utf8');
  await fs.unlink(previous).catch((error: unknown) => {
    logger.warn('[nmb] could not remove original upload', {
      code: (error as { code?: string })?.code,
    });
  });
}

function respond(res: Response, screened: Exclude<Screened, { kind: 'pass' }>): void {
  if (screened.kind === 'hold') {
    sendNmbError(res, 'nmb_review_pending', { reviewId: screened.reviewId });
  } else if (screened.kind === 'reject') {
    sendNmbError(res, 'nmb_rejected', { reason: screened.reason });
  } else {
    sendNmbError(res, 'nmb_unavailable');
  }
}

/**
 * Upload gate. Resolves true when the (possibly replaced) `req.file` may continue through the
 * normal upload pipeline, false once a refusal has been written to `res`. Fails closed.
 */
export function createNmbUploadGate(deps: NmbUploadDeps) {
  const { config, scanner } = deps;

  async function releaseApprovedHold(
    userId: string,
    sha256: string,
  ): Promise<
    | { kind: 'content'; content: string }
    | { kind: 'refuse'; screened: Exclude<Screened, { kind: 'pass' }> }
    | { kind: 'none' }
  > {
    const holds = await deps.findNmbFileHolds(userId, sha256);
    for (const hold of holds) {
      const review = await scanner.getReview(hold.reviewId);
      if (review.user !== userId) {
        continue;
      }
      if (review.status === 'pending') {
        return { kind: 'refuse', screened: { kind: 'hold', reviewId: review.id, reason: '' } };
      }
      if (review.status === 'rejected') {
        return {
          kind: 'refuse',
          screened: {
            kind: 'reject',
            reason: review.reviewer_note?.slice(0, 300) || 'Rejected by a reviewer.',
          },
        };
      }
      if (!(await deps.consumeNmbFileHold(hold.reviewId, userId))) {
        continue;
      }
      const result = await scanner.getResult(hold.reviewId);
      if (result.status === 'approved-masked' && typeof result.sanitized_content === 'string') {
        return { kind: 'content', content: result.sanitized_content };
      }
    }
    return { kind: 'none' };
  }

  return async function gateUpload(req: Request, res: Response): Promise<boolean> {
    if (!config.enabled) {
      return true;
    }
    const file = (req as Request & { file?: UploadedFile }).file;
    if (!file) {
      return true;
    }
    try {
      if (isNmbMisconfigured(config)) {
        sendNmbError(res, 'nmb_unavailable');
        return false;
      }
      const identity = resolveIdentity(req, config);
      if (!identity) {
        res.status(401).json({ message: 'Authentication required' });
        return false;
      }
      const ext = path.extname(file.originalname).toLowerCase();
      if (!isGatedFileType(file.originalname)) {
        sendNmbError(res, 'nmb_rejected', {
          reason: `Files of type ${ext || '(none)'} cannot be attached while data protection is active.`,
        });
        return false;
      }
      const bytes = await fs.readFile(file.path);
      const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');

      const released = await releaseApprovedHold(identity.userId, sha256);
      if (released.kind === 'refuse') {
        respond(res, released.screened);
        return false;
      }
      if (released.kind === 'content') {
        await replaceWithSanitised(file, released.content);
        return true;
      }

      let screened: Screened;
      if (SCANNED_DOCUMENTS.has(ext)) {
        screened = await screenFile(scanner, file.originalname, bytes, identity.ctx);
      } else {
        let text: string;
        try {
          text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        } catch {
          sendNmbError(res, 'nmb_rejected', { reason: 'The file is not valid UTF-8 text.' });
          return false;
        }
        screened = await screenText(scanner, text, identity.ctx);
      }

      if (screened.kind === 'pass') {
        await replaceWithSanitised(file, screened.content);
        return true;
      }
      if (screened.kind === 'hold') {
        await deps.createNmbFileHold({
          userId: identity.userId,
          sha256,
          reviewId: screened.reviewId,
        });
      }
      respond(res, screened);
      return false;
    } catch (error) {
      logger.error('[nmb] upload gate error; failing closed', {
        name: (error as Error)?.name ?? 'unknown',
        kind: (error as { kind?: string })?.kind,
      });
      sendNmbError(res, 'nmb_unavailable');
      return false;
    }
  };
}
