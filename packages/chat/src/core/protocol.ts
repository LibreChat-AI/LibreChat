export const GENERATION_PROTOCOL_VERSION = 2 as const;
export const GENERATION_PROTOCOL_HEADER = 'X-LibreChat-Generation-Protocol';

export type GenerationProtocolVersion = 1 | typeof GENERATION_PROTOCOL_VERSION;

/**
 * Protocol negotiation is deliberately fail-closed: only an exact numeric
 * echo of `2` enables v2 behavior. Old servers, stripped fields, strings, and
 * future versions all remain on the legacy path until the client understands
 * their contract.
 */
export const getGenerationProtocolVersion = (value: unknown): GenerationProtocolVersion => {
  if (
    value != null &&
    typeof value === 'object' &&
    (value as { generationProtocolVersion?: unknown }).generationProtocolVersion ===
      GENERATION_PROTOCOL_VERSION
  ) {
    return GENERATION_PROTOCOL_VERSION;
  }
  return 1;
};

export const supportsGenerationProtocolV2 = (value: unknown): boolean =>
  getGenerationProtocolVersion(value) === GENERATION_PROTOCOL_VERSION;

export const generationProtocolHeaders = (): Record<string, string> => ({
  [GENERATION_PROTOCOL_HEADER]: String(GENERATION_PROTOCOL_VERSION),
});

/**
 * The route one generation's events are read from, with the resume cursor and the generation
 * fence in its query. Every attachment is built here, so two readers of one generation ask the
 * server the same question.
 */
export function generationStreamUrl(
  baseUrl: string,
  target: { streamId: string; resume?: boolean; generationCreatedAt?: number },
): string {
  const query = new URLSearchParams();
  if (target.resume === true) {
    query.set('resume', 'true');
  }
  if (target.generationCreatedAt != null) {
    query.set('generationCreatedAt', String(target.generationCreatedAt));
  }
  query.set('generationProtocolVersion', String(GENERATION_PROTOCOL_VERSION));
  return `${baseUrl}/api/agents/chat/stream/${encodeURIComponent(target.streamId)}?${query.toString()}`;
}
