/** Hard service limits, not operator-tunable allocation budgets. */
export const BEDROCK_DOCUMENT_COUNT = 5;
export const BEDROCK_DOCUMENT_BYTES: number = 4.5 * 1024 * 1024;

export class BedrockDocumentError extends Error {
  readonly code = 'AGENT_ATTACHMENT_LIMIT_EXCEEDED';
  readonly status = 413;
  readonly statusCode = 413;

  constructor() {
    super(
      "An attached document is unavailable, invalid, or exceeds this model's attachment limits. Remove it or use smaller attachments and try again.",
    );
    this.name = 'BedrockDocumentError';
  }
}

export function bedrockRequestLimit(model?: string): number {
  // AWS API restrictions and Nova modalities specify whole-payload limits, including base64.
  return /(?:^|\.)(?:anthropic\.)?claude-/.test(model ?? '') ? 32_000_000 : 25_000_000;
}

/** Invalid configuration fails closed; an absent setting inherits the hard cap. */
export function clampBedrockLimit(cap: number, configured?: number): number {
  if (configured === undefined) return cap;
  if (!Number.isFinite(configured) || configured < 0) throw new BedrockDocumentError();
  return Math.min(cap, configured);
}

export function assertBedrockSize(size: number, limit: number): void {
  if (!Number.isSafeInteger(size) || size < 0 || size > limit) throw new BedrockDocumentError();
}
