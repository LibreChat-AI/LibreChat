export interface ModelResponseMetadata {
  messageStop?: {
    stopReason?: string;
  };
  stopReason?: string;
}

export interface ModelOutputWithRefusal<TAdditional extends { stop_reason?: string }> {
  additional_kwargs?: TAdditional;
  response_metadata?: ModelResponseMetadata;
}

/** Normalizes provider-specific model refusal metadata for downstream handlers. */
export function getModelRefusalInfo<TAdditional extends { stop_reason?: string }>(
  output?: ModelOutputWithRefusal<TAdditional>,
): TAdditional | { stop_reason: string } | undefined {
  const bedrockStopReason =
    output?.response_metadata?.messageStop?.stopReason ?? output?.response_metadata?.stopReason;
  if (bedrockStopReason === 'content_filtered') {
    return { stop_reason: bedrockStopReason };
  }
  if (output?.additional_kwargs?.stop_reason === 'refusal') {
    return { ...output.additional_kwargs };
  }
  return undefined;
}
