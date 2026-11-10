import { hasToolResourceDestination } from 'librechat-data-provider';
import type { EToolResources, TFile } from 'librechat-data-provider';

/** Chooser declines remain declines; cleanup does not erase destination intent. */
export function allowsFileResource(
  file: Partial<Pick<TFile, 'file_id' | 'metadata' | 'embedded'>>,
  resource: EToolResources,
  membership?: ReadonlyMap<EToolResources, ReadonlySet<string>>,
): boolean {
  return (
    file.metadata?.destinationChosen === false ||
    membership?.get(resource)?.has(file.file_id ?? '') === true ||
    hasToolResourceDestination(file, resource)
  );
}
