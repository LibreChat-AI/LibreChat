import type { PartMetadata } from 'librechat-data-provider';
import { areToolCallArgsComplete } from './parseJsonField';

export interface ToolPreparationInput
  extends Pick<PartMetadata, 'toolPreparationStartedAt' | 'toolDispatchedAt' | 'runStepStatus'> {
  args?: string | Record<string, unknown>;
  output?: string | null;
  progress?: number;
}

/** Dispatch and result signals outrank argument completeness on legacy and resumed calls. */
export function isToolCallPreparing(call: ToolPreparationInput): boolean {
  if (
    call.toolDispatchedAt != null ||
    call.runStepStatus != null ||
    (call.output?.length ?? 0) > 0 ||
    (call.progress ?? 0) >= 1
  ) {
    return false;
  }
  return call.toolPreparationStartedAt != null || !areToolCallArgsComplete(call.args);
}
