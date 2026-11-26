import { FileContext, hasToolResourceDestination } from 'librechat-data-provider';
import type { EToolResources, TFile } from 'librechat-data-provider';

/** A stored record types its context as a plain string. */
type ConsumedFile = Partial<Pick<TFile, 'file_id' | 'metadata' | 'embedded'>> & {
  context?: string | null;
};

/** No destination was named for this file, so no tool was declined: an upload that made no
 *  choice, or an image a tool generated, which never passes through the chooser. */
export function isDestinationUnchosen(file: ConsumedFile): boolean {
  return (
    file.metadata?.destinationChosen === false || file.context === FileContext.image_generation
  );
}

/** Chooser declines remain declines; cleanup does not erase destination intent. */
export function allowsFileResource(
  file: ConsumedFile,
  resource: EToolResources,
  membership?: ReadonlyMap<EToolResources, ReadonlySet<string>>,
): boolean {
  return (
    isDestinationUnchosen(file) ||
    membership?.get(resource)?.has(file.file_id ?? '') === true ||
    hasToolResourceDestination(file, resource)
  );
}
