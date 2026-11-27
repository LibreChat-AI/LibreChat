import type { ContentTraversalDiagnostics } from './adapters/nested';

export interface LocatorTraversalFailure extends ContentTraversalDiagnostics {
  readonly messageCount: number;
  readonly resolvedFileCount: number;
}

export type LocatorTraversalReporter = (failure: LocatorTraversalFailure) => void;
