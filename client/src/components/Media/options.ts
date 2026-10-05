import { mediaProviderOptionsSchema, resolveMediaParameters } from 'librechat-data-provider';
import type {
  MediaAsset,
  MediaInput,
  MediaCatalog,
  MediaEnumControl,
  MediaNumberControl,
  MediaOffering,
  MediaOperation,
} from 'librechat-data-provider';
import type { MediaDraft } from './state';

export const offeringId = (
  offering: Pick<MediaCatalog['offerings'][number], 'connectionId' | 'modelId'>,
) => JSON.stringify([offering.connectionId, offering.modelId]);

export type NumericKey =
  | 'count'
  | 'durationSeconds'
  | 'seed'
  | 'outputCompression'
  | 'strength'
  | 'guidance'
  | 'upscaleFactor'
  | 'creativity';
export type EnumKey = 'size' | 'aspectRatio' | 'quality' | 'format' | 'background' | 'resolution';
export type FormControls = Partial<Record<NumericKey, MediaNumberControl>> &
  Partial<Record<EnumKey, MediaEnumControl>> & {
    audio?: boolean;
    negativePrompt?: boolean;
    providerOptions?: string[];
  };

export function readProviderOptions(text: string, catalog: MediaCatalog) {
  if (!text.trim()) return {};
  try {
    if (new TextEncoder().encode(text).length > catalog.limits.maxProviderOptionBytes)
      return { invalid: true };
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { invalid: true };
    const parsed = mediaProviderOptionsSchema.safeParse(value);
    return parsed.success ? { value: parsed.data } : { invalid: true };
  } catch {
    return { invalid: true };
  }
}

type MediaCapability = MediaOffering['capabilities'][number];

const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(
          Object.entries(item as Record<string, unknown>)
            .filter(([, entry]) => entry !== undefined)
            .sort(([a], [b]) => a.localeCompare(b)),
        )
      : item,
  );
export const sameParameters = (left: MediaDraft['parameters'], right: MediaDraft['parameters']) =>
  canonical(left) === canonical(right);
export const sameInputs = (left: MediaDraft['inputs'], right: MediaDraft['inputs']) =>
  canonical(left) === canonical(right);

/** A comparison run keeps the batch size and otherwise takes the other model's own defaults. */
export function comparisonParameters(
  capability: MediaCapability,
  count: number,
  inputs: MediaDraft['inputs'],
) {
  const min = capability.controls.count?.min ?? 1;
  const max = capability.controls.count?.max ?? count;
  return resolveMediaParameters(
    {
      operation: capability.operation,
      inputs,
      parameters: { count: Math.min(Math.max(count, min), max) },
    },
    capability,
    { optionalChoices: true },
  );
}

export function supportsMode(offering: MediaOffering, operation: MediaOperation) {
  return (
    offering.capabilities.some(
      (cap) => (cap.operation === 'video.generate') === (operation === 'video.generate'),
    ) ||
    (!offering.capabilities.length &&
      offering.api.endsWith('.videos') === (operation === 'video.generate'))
  );
}

/** Admission uses owned descriptors while submissions keep only immutable input references. */
export function mediaInputsWithMetadata(inputs: MediaInput[], assets: MediaAsset[]) {
  const byId = new Map(assets.map((asset) => [asset.file_id, asset]));
  return inputs.map((input) => {
    const asset = byId.get(input.file_id);
    return { ...input, type: asset?.type, bytes: asset?.bytes };
  });
}
