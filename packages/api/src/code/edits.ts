/** Edit features a worker may negotiate; LibreChat only sends a feature's fields once advertised. */
export type WorkspaceEditFileFeature = 'expected_base_sha256' | 'tolerant_match' | 'replace_all';

export const WORKSPACE_EDIT_FILE_FEATURES: readonly WorkspaceEditFileFeature[] = [
  'expected_base_sha256',
  'tolerant_match',
  'replace_all',
];

/** `tolerant` lets the worker fall back from exact matching to whitespace-tolerant strategies. */
export type WorkspaceEditMatching = 'exact' | 'tolerant';

export type WorkspaceEditMatchStrategy =
  | 'exact'
  | 'line-trimmed'
  | 'whitespace-normalized'
  | 'indentation-flexible';

export const WORKSPACE_EDIT_MATCH_STRATEGIES: ReadonlySet<string> =
  new Set<WorkspaceEditMatchStrategy>([
    'exact',
    'line-trimmed',
    'whitespace-normalized',
    'indentation-flexible',
  ]);

/** How one edit matched; reported only for requests that set `matching` or `replaceAll`. */
export interface WorkspaceEditMatch {
  strategy: WorkspaceEditMatchStrategy;
  occurrences: number;
}
