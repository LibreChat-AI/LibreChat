import { logger } from '@librechat/data-schemas';
import type { ScannerClient } from './scanner';
import type { ScanContext, ScanResult } from './types';

/** The outcome of screening one piece of text or one file. Never carries the original content. */
export type Screened =
  | { kind: 'pass'; content: string; masked: boolean; maskedCount: number }
  | { kind: 'hold'; reviewId: string; reason: string }
  | { kind: 'reject'; reason: string; reviewId?: string }
  | { kind: 'unavailable' };

export const GENERIC_REJECT_REASON = 'This content cannot be sent under the bank data policy.';

/** Sanitised content is the only thing a `pass` may carry; anything else fails closed. */
export function interpret(result: ScanResult): Screened {
  switch (result.decision) {
    case 'allow':
    case 'mask': {
      if (typeof result.sanitized_content !== 'string') {
        return { kind: 'unavailable' };
      }
      const maskedCount = result.findings.filter((f) => f.placeholder != null).length;
      return {
        kind: 'pass',
        content: result.sanitized_content,
        masked: result.decision === 'mask' && maskedCount > 0,
        maskedCount,
      };
    }
    case 'review':
      if (!result.review_id) {
        return { kind: 'unavailable' };
      }
      return {
        kind: 'hold',
        reviewId: result.review_id,
        reason: result.review_required_reason ?? '',
      };
    case 'reject':
      return {
        kind: 'reject',
        reason: result.review_required_reason?.slice(0, 300) || GENERIC_REJECT_REASON,
        ...(result.review_id ? { reviewId: result.review_id } : {}),
      };
    default:
      return { kind: 'unavailable' };
  }
}

/** Safe diagnostics: counts and entity names only. */
export function summarise(result: ScanResult): Record<string, unknown> {
  const entities: Record<string, number> = {};
  for (const f of result.findings) {
    entities[f.entity] = (entities[f.entity] ?? 0) + 1;
  }
  return { decision: result.decision, findings: result.findings.length, entities };
}

export async function screenText(
  scanner: ScannerClient,
  text: string,
  ctx: ScanContext,
): Promise<Screened> {
  try {
    const result = await scanner.scanText(text, ctx);
    logger.info('[nmb] text screened', { user: ctx.user, ...summarise(result) });
    return interpret(result);
  } catch (error) {
    logger.error('[nmb] scanner call failed; failing closed', {
      kind: (error as { kind?: string })?.kind ?? 'unknown',
    });
    return { kind: 'unavailable' };
  }
}

export async function screenFile(
  scanner: ScannerClient,
  filename: string,
  data: Uint8Array,
  ctx: ScanContext,
): Promise<Screened> {
  try {
    const result = await scanner.scanFile(filename, data, ctx);
    logger.info('[nmb] file screened', { user: ctx.user, ...summarise(result) });
    return interpret(result);
  } catch (error) {
    logger.error('[nmb] scanner call failed; failing closed', {
      kind: (error as { kind?: string })?.kind ?? 'unknown',
    });
    return { kind: 'unavailable' };
  }
}
