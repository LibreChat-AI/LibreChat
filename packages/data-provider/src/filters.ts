import { z } from 'zod';
import { RE2JS } from 're2js';

export const FILTER_PII_STARTER_PATTERNS = [
  'sk_prefix',
  'bearer_header',
  'api_key_header',
] as const;

export const MAX_PII_PATTERNS_PER_SOURCE = 256;
export const MAX_PII_PATTERN_LENGTH = 512;
export const MAX_PII_PATTERN_ID_LENGTH = 256;
export const MAX_PII_PATTERN_LABEL_LENGTH = 512;
export const MAX_PII_CUSTOM_REGEX_CHARACTERS = 8_192;
export const MAX_PII_CUSTOM_REGEX_INSTRUCTIONS = 8_192;
export const MAX_PII_CUSTOM_PATTERNS_TOTAL = 256;

const MAX_PII_REGEX_SIZE_CACHE_ENTRIES = 512;
const PII_REGEX_PROGRAM_SIZE_CACHE = new Map<string, number | null>();

export function getPiiRegexProgramSize(pattern: string): number | null {
  if (PII_REGEX_PROGRAM_SIZE_CACHE.has(pattern)) {
    return PII_REGEX_PROGRAM_SIZE_CACHE.get(pattern) ?? null;
  }
  let programSize: number | null = null;
  let compiled: RE2JS | undefined;
  try {
    compiled = RE2JS.compile(pattern);
    const candidate = compiled.programSize();
    if (Number.isSafeInteger(candidate) && candidate > 0) {
      programSize = candidate;
    }
  } catch {
    programSize = null;
  } finally {
    compiled?.reset();
  }
  if (PII_REGEX_PROGRAM_SIZE_CACHE.size >= MAX_PII_REGEX_SIZE_CACHE_ENTRIES) {
    PII_REGEX_PROGRAM_SIZE_CACHE.clear();
  }
  PII_REGEX_PROGRAM_SIZE_CACHE.set(pattern, programSize);
  return programSize;
}

export const MESSAGE_FILTER_FIELDS = [
  'name',
  'text',
  'summary',
  'quote',
  'answer',
  'decision_response',
  'decision_reason',
  'content_part',
  'attachment_reference',
  'assembled_context',
] as const;

export const HITL_MESSAGE_FILTER_FIELDS = [
  'answer',
  'decision_response',
  'decision_reason',
] as const;

const REQUEST_ONLY_MESSAGE_FILTER_FIELDS = new Set<string>(HITL_MESSAGE_FILTER_FIELDS);

/** Message fields structurally recoverable without exact semantic provenance. */
export const STORED_MESSAGE_FILTER_FIELDS = MESSAGE_FILTER_FIELDS.filter(
  (field) => !REQUEST_ONLY_MESSAGE_FILTER_FIELDS.has(field),
);

export const PROMPT_FILTER_FIELDS = [
  'name',
  'description',
  'oneliner',
  'category',
  'command',
  'text',
  'preset_text',
  'system',
  'context',
  'instructions',
  'additional_instructions',
  'greeting',
  'example_input',
  'example_output',
] as const;

export const AGENT_INSTRUCTION_FILTER_FIELDS = [
  'name',
  'category',
  'description',
  'instructions',
  'additional_instructions',
  'edge_description',
  'edge_prompt',
  'edge_prompt_key',
  'artifacts',
  'support_contact_name',
  'support_contact_email',
] as const;

export const CONVERSATION_STARTER_FILTER_FIELDS = ['text'] as const;
export const CONVERSATION_TITLE_FILTER_FIELDS = ['title'] as const;
export const FEEDBACK_FILTER_FIELDS = ['text'] as const;

export const SKILL_FILTER_FIELDS = [
  'name',
  'display_title',
  'description',
  'category',
  'frontmatter',
  'instructions',
  'imported_text',
  'file_name',
  'file_text',
] as const;

export const MEMORY_FILTER_FIELDS = ['key', 'value', 'summary'] as const;

export const FILE_FILTER_FIELDS = [
  'name',
  'content',
  'extracted_text',
  'transcript',
  'uri',
] as const;

export const TOOL_ARGUMENT_FILTER_FIELDS = ['name', 'arguments', 'output'] as const;

export const MODEL_PARAMETER_FILTER_FIELDS = [
  'stop',
  'request_fields',
  'response_format',
  'metadata',
] as const;

export const ACTION_METADATA_FILTER_FIELDS = [
  'raw_spec',
  'domain',
  'privacy_policy_url',
  'authorization_type',
  'custom_auth_header',
  'authorization_content_type',
  'authorization_url',
  'client_url',
  'scope',
  'token_exchange_method',
  'api_key',
  'oauth_client_id',
  'oauth_client_secret',
] as const;

export const messageFilterFieldSchema = z.enum(MESSAGE_FILTER_FIELDS);
export const promptFilterFieldSchema = z.enum(PROMPT_FILTER_FIELDS);
export const agentInstructionFilterFieldSchema = z.enum(AGENT_INSTRUCTION_FILTER_FIELDS);
export const conversationStarterFilterFieldSchema = z.enum(CONVERSATION_STARTER_FILTER_FIELDS);
export const conversationTitleFilterFieldSchema = z.enum(CONVERSATION_TITLE_FILTER_FIELDS);
export const feedbackFilterFieldSchema = z.enum(FEEDBACK_FILTER_FIELDS);
export const skillFilterFieldSchema = z.enum(SKILL_FILTER_FIELDS);
export const memoryFilterFieldSchema = z.enum(MEMORY_FILTER_FIELDS);
export const fileFilterFieldSchema = z.enum(FILE_FILTER_FIELDS);
export const toolArgumentFilterFieldSchema = z.enum(TOOL_ARGUMENT_FILTER_FIELDS);
export const modelParameterFilterFieldSchema = z.enum(MODEL_PARAMETER_FILTER_FIELDS);
export const filterPiiStarterPatternSchema = z.enum(FILTER_PII_STARTER_PATTERNS);
export const filterPiiActionSchema = z.enum(['block', 'audit', 'redact']);
export const filterPiiCategorySchema = z.enum(['email', 'phone', 'name', 'credential', 'custom']);
export const DEFAULT_PII_REDACTION_MAX_CHARACTERS = 65_536;
export const DEFAULT_PII_REDACTION_MAX_MATCHES = 256;
export const actionMetadataFilterFieldSchema = z.enum(ACTION_METADATA_FILTER_FIELDS);
export const unattributedAssistantContentSchema = z.enum(['model_output', 'inspect']);
export type UnattributedAssistantContent = z.infer<typeof unattributedAssistantContentSchema>;

export type MessageFilterField = z.infer<typeof messageFilterFieldSchema>;
export type PromptFilterField = z.infer<typeof promptFilterFieldSchema>;
export type AgentInstructionFilterField = z.infer<typeof agentInstructionFilterFieldSchema>;
export type ConversationStarterFilterField = z.infer<typeof conversationStarterFilterFieldSchema>;
export type ConversationTitleFilterField = z.infer<typeof conversationTitleFilterFieldSchema>;
export type FeedbackFilterField = z.infer<typeof feedbackFilterFieldSchema>;
export type SkillFilterField = z.infer<typeof skillFilterFieldSchema>;
export type MemoryFilterField = z.infer<typeof memoryFilterFieldSchema>;
export type FileFilterField = z.infer<typeof fileFilterFieldSchema>;
export type ToolArgumentFilterField = z.infer<typeof toolArgumentFilterFieldSchema>;
export type ModelParameterFilterField = z.infer<typeof modelParameterFilterFieldSchema>;
export type ActionMetadataFilterField = z.infer<typeof actionMetadataFilterFieldSchema>;
export type FilterPiiAction = z.infer<typeof filterPiiActionSchema>;
export type FilterPiiCategory = z.infer<typeof filterPiiCategorySchema>;

export const userSubmittedMessageFieldPathSchema = z
  .object({
    path: z.string().startsWith('/').max(2048),
    field: z.enum(HITL_MESSAGE_FILTER_FIELDS),
  })
  .strict();

export type UserSubmittedMessageFieldPath = z.infer<typeof userSubmittedMessageFieldPathSchema>;

type PiiPatternSelection = {
  readonly starterPatterns?: readonly unknown[];
  readonly customPatterns?: readonly unknown[];
};

type PiiFieldSelection = PiiPatternSelection & {
  readonly fields?: readonly string[];
};

const UNINSPECTABLE_FILE_FIELDS = new Set<FileFilterField>([
  'content',
  'extracted_text',
  'transcript',
]);

/**
 * An omitted starter selection enables the built-in catalog. An explicit
 * empty selection disables it, so a source is active only when custom rules
 * remain. This mirrors the documented filter semantics without compiling
 * regular expressions.
 */
export function hasActivePiiPatterns(config: PiiPatternSelection | null | undefined): boolean {
  return (
    config != null &&
    (config.starterPatterns == null ||
      config.starterPatterns.length > 0 ||
      (config.customPatterns?.length ?? 0) > 0)
  );
}

/** Returns whether an active PII rule can inspect at least one candidate field. */
export function hasActivePiiFields(
  config: PiiFieldSelection | null | undefined,
  candidates: readonly string[],
): boolean {
  return (
    hasActivePiiPatterns(config) &&
    (config?.fields == null || candidates.some((field) => config.fields?.includes(field)))
  );
}

/**
 * Returns whether a parsed source-aware config can enforce any rule. An
 * explicit fail-close file policy remains active even without text patterns.
 */
export function hasActiveFiltersConfig(filters: FiltersConfig | null | undefined): boolean {
  if (filters == null) {
    return false;
  }
  if (filters.messages?.unattributedAssistantContent === 'inspect') {
    return true;
  }
  const sourcePatterns = [
    filters.messages?.pii,
    filters.prompts?.pii,
    filters.agentInstructions?.pii,
    filters.conversationStarters?.pii,
    filters.conversationTitles?.pii,
    filters.feedback?.pii,
    filters.skills?.pii,
    filters.memories?.pii,
    filters.files?.pii,
    filters.toolArguments?.pii,
    filters.modelParameters?.pii,
    filters.actionMetadata?.pii,
  ];
  if (sourcePatterns.some(hasActivePiiPatterns)) {
    return true;
  }
  const filePii = filters.files?.pii;
  return (
    filePii?.uninspectable === 'block' &&
    (filePii.fields == null || filePii.fields.some((field) => UNINSPECTABLE_FILE_FIELDS.has(field)))
  );
}

export const filterPiiRegexSchema = z
  .string()
  .min(1)
  .max(MAX_PII_PATTERN_LENGTH)
  .refine((value) => getPiiRegexProgramSize(value) != null, {
    message: 'Regex must use supported linear-time syntax',
  });

export const filterPiiCustomPatternSchema = z
  .object({
    id: z.string().min(1).max(MAX_PII_PATTERN_ID_LENGTH),
    label: z.string().min(1).max(MAX_PII_PATTERN_LABEL_LENGTH),
    regex: filterPiiRegexSchema,
    category: filterPiiCategorySchema.optional(),
  })
  .strict();

export type FilterPiiCustomPatternConfig = z.infer<typeof filterPiiCustomPatternSchema>;

function createPiiFilterSchema<Field extends z.ZodTypeAny>(fieldSchema: Field) {
  return z
    .object({
      action: filterPiiActionSchema.optional(),
      maxCharacters: z.number().int().positive().max(262_144).optional(),
      maxMatches: z.number().int().positive().max(4_096).optional(),
      fields: z.array(fieldSchema).min(1).max(MAX_PII_PATTERNS_PER_SOURCE).optional(),
      starterPatterns: z
        .array(filterPiiStarterPatternSchema)
        .max(MAX_PII_PATTERNS_PER_SOURCE)
        .optional(),
      customPatterns: z
        .array(filterPiiCustomPatternSchema)
        .max(MAX_PII_PATTERNS_PER_SOURCE)
        .optional(),
    })
    .strict();
}

function createSourceFilterSchema<Field extends z.ZodTypeAny>(fieldSchema: Field) {
  return z
    .object({
      pii: createPiiFilterSchema(fieldSchema).optional(),
    })
    .strict();
}

const messageSourceFilterSchema = z
  .object({
    pii: createPiiFilterSchema(messageFilterFieldSchema).optional(),
    unattributedAssistantContent: unattributedAssistantContentSchema.optional(),
  })
  .strict();

const fileSourceFilterSchema = z
  .object({
    pii: createPiiFilterSchema(fileFilterFieldSchema)
      .extend({
        uninspectable: z.enum(['allow', 'block']).optional(),
      })
      .optional(),
  })
  .strict();

export const filtersConfigSchema = z
  .object({
    messages: messageSourceFilterSchema.optional(),
    prompts: createSourceFilterSchema(promptFilterFieldSchema).optional(),
    agentInstructions: createSourceFilterSchema(agentInstructionFilterFieldSchema).optional(),
    conversationStarters: createSourceFilterSchema(conversationStarterFilterFieldSchema).optional(),
    conversationTitles: createSourceFilterSchema(conversationTitleFilterFieldSchema).optional(),
    feedback: createSourceFilterSchema(feedbackFilterFieldSchema).optional(),
    skills: createSourceFilterSchema(skillFilterFieldSchema).optional(),
    memories: createSourceFilterSchema(memoryFilterFieldSchema).optional(),
    files: fileSourceFilterSchema.optional(),
    toolArguments: createSourceFilterSchema(toolArgumentFilterFieldSchema).optional(),
    modelParameters: createSourceFilterSchema(modelParameterFilterFieldSchema).optional(),
    actionMetadata: createSourceFilterSchema(actionMetadataFilterFieldSchema).optional(),
  })
  .strict()
  .superRefine((filters, context) => {
    let customPatterns = 0;
    let regexCharacters = 0;
    let regexInstructions = 0;
    for (const source of Object.values(filters)) {
      for (const pattern of source?.pii?.customPatterns ?? []) {
        customPatterns++;
        regexCharacters += pattern.regex.length;
        regexInstructions += getPiiRegexProgramSize(pattern.regex) ?? 0;
      }
    }
    if (customPatterns > MAX_PII_CUSTOM_PATTERNS_TOTAL) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `At most ${MAX_PII_CUSTOM_PATTERNS_TOTAL} custom PII patterns may be configured in total`,
      });
    }
    if (regexCharacters > MAX_PII_CUSTOM_REGEX_CHARACTERS) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Custom PII regexes may contain at most ${MAX_PII_CUSTOM_REGEX_CHARACTERS} characters in total`,
      });
    }
    if (regexInstructions > MAX_PII_CUSTOM_REGEX_INSTRUCTIONS) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Custom PII regexes may compile to at most ${MAX_PII_CUSTOM_REGEX_INSTRUCTIONS} instructions in total`,
      });
    }
  });

export type FiltersConfig = z.infer<typeof filtersConfigSchema>;
