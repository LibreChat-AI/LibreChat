export type SerializableValue =
  | string
  | number
  | boolean
  | null
  | readonly SerializableValue[]
  | { readonly [key: string]: SerializableValue | undefined };

export interface ToolEntry {
  toolName: string;
  toolInput?: SerializableValue;
  toolOutput?: SerializableValue;
  status?: 'success' | 'error';
  error?: string;
}

export interface ActivityLabelPayload {
  entries: ToolEntry[];
  thinkingExcerpts?: string[];
  lastAssistantText?: string;
}

export interface EvalStep {
  id?: string;
  verbatim?: string;
  productionLabel?: string;
  payload?: ActivityLabelPayload;
}

export interface EvalCase {
  id: string;
  notes: string;
  steps: EvalStep[];
}

export interface Variant {
  name: string;
  usePreviousLabels: boolean;
  instruction: string;
  previousLabelCap?: number;
}

export interface RunArgs {
  samples: number;
  concurrency: number;
  model: string;
  dry: boolean;
  variants?: string[];
  cases?: string[];
}

interface BaseRecord {
  variant: string;
  sample: number;
  caseId: string;
  stepId: string;
}

export interface DryRunRecord extends BaseRecord {
  prompt: string;
}

export interface ErrorRecord extends BaseRecord {
  error: string;
}

export interface SuccessRecord extends BaseRecord {
  label: string;
  production?: string;
  flags: string[];
  wordCount: number;
  firstWord: string;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
}

export type EvalRecord = ErrorRecord | SuccessRecord;
export type RunRecord = DryRunRecord | EvalRecord;

export interface Aggregate {
  variant: string;
  steps: number;
  errors: number;
  flagCounts: Partial<Record<FlagType, number>>;
  distinctOpeners: number;
  topOpener: string;
  avgWords: string;
  meanLatencyMs: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: string;
}

export const FLAG_TYPES = [
  'len',
  'punct',
  'quote',
  'md',
  'opener',
  'tool-echo',
  'count-echo',
  'restate',
  'template',
] as const;

export type FlagType = (typeof FLAG_TYPES)[number];

export interface StoredResults {
  args: RunArgs;
  records: EvalRecord[];
}
