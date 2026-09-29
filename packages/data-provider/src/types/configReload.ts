export const CONFIG_GENERATION_HEADER = 'X-LibreChat-Config-Generation';

export interface TConfigRevision {
  distributed: boolean;
  generation: number | null;
  pollIntervalMs: number;
}

/** Results contain only section names and paths, never configuration values. */
export interface TConfigReloadSection {
  section: string;
  status: 'applied_live' | 'restart_required' | 'unchanged';
  restartRequired: boolean;
  restartRequiredPaths?: string[];
}

export interface TConfigReloadResult {
  /** Cluster means published, not that every replica has applied it. */
  scope: 'cluster' | 'local' | 'unchanged';
  distributed: boolean;
  generation?: number;
  propagationError?: string;
  sections: TConfigReloadSection[];
}

export interface TConfigReloadError {
  error: string;
  validationErrors?: Array<{ path: (string | number)[]; message: string }>;
}
