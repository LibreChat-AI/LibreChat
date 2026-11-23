import type { FiltersConfig, FilterPiiAction, FilterPiiCategory } from '../filters';

/** A1 contract only. No output policy is parsed or enforced by these types. */
export type OutputTextProtectionPolicy = Omit<
  NonNullable<NonNullable<FiltersConfig['messages']>['pii']>,
  'fields'
> & {
  /** Required deadline for one attempt; consumers must validate a finite positive integer. */
  readonly timeoutMs: number;
};

/** Reserved config vocabulary, not yet a supported librechat.yaml field. */
export interface OutputProtectionConfig {
  readonly version: 1;
  readonly assistantText?: OutputTextProtectionPolicy;
  readonly toolText?: OutputTextProtectionPolicy;
}

export type OutputProtectionTarget =
  | { readonly source: 'message'; readonly field: 'text'; readonly provenance: 'model' }
  | {
      readonly source: 'tool_argument';
      readonly field: 'output';
      readonly provenance: 'tool';
      readonly outcome: 'success' | 'error';
    };

export type OutputProtectionDestination =
  | 'model'
  | 'display'
  | 'replay'
  | 'storage'
  | 'share'
  | 'export'
  | 'log'
  | 'trace_central'
  | 'trace_tenant'
  | 'index';

export type OutputProtectionErrorCode =
  | 'blocked'
  | 'unavailable'
  | 'timeout'
  | 'overflow'
  | 'cancelled'
  | 'unsupported'
  | 'incompatible';

export interface OutputProtectionCategoryCount {
  readonly category: Uppercase<FilterPiiCategory>;
  readonly count: number;
}

/** Canonical content is present only on success, never alongside a failure. */
export type OutputProtectionResult =
  | {
      readonly version: 1;
      readonly ok: true;
      readonly value: {
        readonly content: string;
        readonly replacements: number;
        readonly categories: readonly OutputProtectionCategoryCount[];
      };
    }
  | {
      readonly version: 1;
      readonly ok: false;
      readonly error: { readonly code: OutputProtectionErrorCode };
    };

/** Closed metadata vocabulary; runtime emitters must construct an allowlisted object. */
export interface OutputProtectionAudit {
  readonly version: 1;
  readonly target: OutputProtectionTarget;
  readonly destination: OutputProtectionDestination;
  readonly action: FilterPiiAction;
  readonly categories: readonly OutputProtectionCategoryCount[];
  readonly elapsedMs: number;
  readonly errorCode?: OutputProtectionErrorCode;
}
