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
