import { isProxy } from 'node:util/types';
import type { ContentFieldMap, ContentSource, JsonPointer, TextContentFragment } from '../types';
import type { ContentTraversalScope, VisitNestedStringsBudget } from './nested';
import {
  CONTENT_TRAVERSAL_MAX_DEPTH,
  CONTENT_TRAVERSAL_MAX_NODES,
  ContentTraversalLimitError,
  escapeJsonPointer,
  getBoundedOwnEnumerableEntries,
  getContentTraversalFragments,
  getContentTraversalScopes,
  isDataUri,
  prependContentTraversalFragments,
  reserveContentMaterialization,
  shouldIncludeNestedSubmittedText,
  visitNestedStrings,
} from './nested';
import { getCanonicalFileInspectionCoverage } from '../files';

interface AgentEdgeInput {
  readonly description?: string;
  readonly prompt?: string;
  readonly promptKey?: string;
}

interface SupportContactInput {
  readonly name?: string;
  readonly email?: string;
}

export interface ModelParameterContentInput {
  readonly stop?: unknown;
  readonly additionalModelRequestFields?: unknown;
  readonly additional_model_request_fields?: unknown;
  readonly response_format?: unknown;
  readonly responseFormat?: unknown;
  readonly metadata?: unknown;
  readonly model_parameters?: unknown;
  readonly options?: unknown;
}

export interface AgentContentInput extends ModelParameterContentInput {
  readonly name?: string | null;
  readonly category?: string | null;
  readonly description?: string | null;
  readonly instructions?: string | null;
  readonly additional_instructions?: string | null;
  readonly conversation_starters?: readonly string[];
  readonly edges?: readonly (AgentEdgeInput | null | undefined)[];
  readonly artifacts?: string;
  readonly support_contact?: SupportContactInput | null;
  /** Final definitions exposed to the model after agent/tool initialization. */
  readonly toolDefinitions?: readonly (FunctionToolContentInput | null | undefined)[];
}

interface FunctionDefinitionContentInput {
  readonly name?: string;
  readonly description?: string;
  readonly parameters?: unknown;
}

interface FunctionToolContentInput extends FunctionDefinitionContentInput {
  readonly type?: string;
  readonly function?: FunctionDefinitionContentInput;
}

export interface AssistantContentInput extends AgentContentInput {
  readonly tools?: readonly (string | FunctionToolContentInput | null | undefined)[];
}

interface ActionAuthContentInput {
  readonly authorization_type?: unknown;
  readonly custom_auth_header?: unknown;
  readonly authorization_content_type?: unknown;
  readonly authorization_url?: unknown;
  readonly client_url?: unknown;
  readonly scope?: unknown;
  readonly token_exchange_method?: unknown;
}

interface ActionMetadataContentInput extends ActionAuthContentInput {
  readonly raw_spec?: unknown;
  readonly domain?: unknown;
  readonly privacy_policy_url?: unknown;
  readonly api_key?: unknown;
  readonly oauth_client_id?: unknown;
  readonly oauth_client_secret?: unknown;
  readonly auth?: ActionAuthContentInput | null;
}

export interface AssistantActionContentInput {
  readonly functions?: readonly (FunctionToolContentInput | null | undefined)[];
  readonly metadata?: ActionMetadataContentInput | null;
}

export interface PromptRecordInput {
  readonly prompt?: string;
  readonly name?: string;
  readonly description?: string;
  readonly oneliner?: string;
  readonly category?: string;
  readonly command?: string | null;
}

interface PromptRecordContentInput extends Omit<PromptRecordInput, 'prompt'> {
  readonly prompt?: unknown;
}

export interface PromptContentInput extends Omit<PromptRecordInput, 'prompt'> {
  readonly prompt?: string | PromptRecordInput;
  readonly group?: PromptRecordInput;
}

interface PresetExampleContentInput {
  readonly content?: string;
}

interface PresetExampleInput {
  readonly input?: string | PresetExampleContentInput;
  readonly output?: string | PresetExampleContentInput;
}

export interface PresetContentInput extends PromptRecordInput, ModelParameterContentInput {
  readonly title?: string;
  readonly promptPrefix?: string | null;
  readonly system?: string;
  readonly context?: string;
  readonly instructions?: string | null;
  readonly additional_instructions?: string | null;
  readonly greeting?: string;
  readonly examples?: readonly (PresetExampleInput | null | undefined)[];
}

interface SkillFileContentInput {
  readonly name?: string;
  readonly filename?: string;
  readonly text?: string;
  readonly content?: string;
}

export interface SkillContentInput {
  readonly name?: string;
  readonly displayTitle?: string;
  readonly description?: string;
  readonly category?: string;
  readonly body?: string;
  readonly instructions?: string;
  readonly importedText?: string;
  readonly frontmatter?: Readonly<Record<string, unknown>>;
  readonly files?: readonly (SkillFileContentInput | null | undefined)[];
}

export interface MemoryContentInput {
  readonly key?: string;
  readonly value?: string;
  readonly summary?: string;
}

export interface FileContentInput {
  readonly file_id?: string;
  readonly name?: string;
  readonly filename?: string;
  readonly originalname?: string;
  readonly type?: string;
  readonly source?: string;
  readonly content?: string | null;
  readonly extractedText?: string | null;
  readonly text?: string | null;
  readonly transcript?: string | null;
  readonly uri?: string;
  readonly filepath?: string;
  readonly url?: string;
  readonly preview?: string;
}

export interface FeedbackContentInput {
  readonly feedback?: {
    readonly text?: string;
  } | null;
  readonly text?: string;
}

export interface StoredMessagePartInput {
  readonly type?: string;
  readonly text?: string | { readonly value?: string };
  readonly think?: string | { readonly value?: string };
  readonly original?: string;
  readonly updated?: string;
  readonly steer?: string;
  readonly quotes?: readonly (string | { readonly text?: string } | null | undefined)[];
  readonly error?: string;
  readonly image_url?: string | { readonly url?: string };
  readonly video_url?: { readonly url?: string };
  readonly input_audio?: {
    readonly data?: string;
    readonly format?: string;
  };
  readonly image_file?: {
    readonly file_id?: string;
    readonly filename?: string;
  };
  readonly file?: StoredFileReferenceInput;
  readonly files?: readonly (StoredFileReferenceInput | null | undefined)[];
  readonly content?: readonly (
    | {
        readonly text?: string | { readonly value?: string };
        readonly [key: string]: unknown;
      }
    | null
    | undefined
  )[];
  readonly tool_call?: StoredToolCallInput;
  readonly [key: string]: unknown;
}

interface StoredToolCallInput {
  readonly name?: unknown;
  readonly args?: unknown;
  readonly arguments?: unknown;
  readonly output?: unknown;
  readonly function?: {
    readonly name?: unknown;
    readonly arguments?: unknown;
    readonly output?: unknown;
  };
  readonly code_interpreter?: {
    readonly input?: unknown;
    readonly outputs?: unknown;
  };
}

interface StoredTopLevelToolCallInput {
  readonly name?: unknown;
  readonly arguments?: unknown;
  readonly output?: unknown;
  readonly function?: {
    readonly name?: unknown;
    readonly arguments?: unknown;
    readonly output?: unknown;
  };
  readonly code_interpreter?: {
    readonly input?: unknown;
    readonly outputs?: unknown;
  };
}

interface StoredFileReferenceInput {
  readonly file_id?: string;
  readonly name?: string;
  readonly filename?: string;
  readonly originalname?: string;
  readonly filepath?: string;
  readonly uri?: string;
  readonly url?: string;
  readonly preview?: string;
}

export interface StoredMessageContentInput extends FeedbackContentInput {
  readonly role?: string;
  readonly name?: string;
  readonly sender?: string;
  readonly text?: string;
  readonly summary?: string;
  readonly quotes?: readonly (string | { readonly text?: string } | null | undefined)[];
  readonly content?: readonly (StoredMessagePartInput | null | undefined)[];
  readonly tool_calls?: readonly (StoredTopLevelToolCallInput | null | undefined)[];
  readonly files?: readonly (StoredFileReferenceInput | null | undefined)[];
  readonly attachments?: readonly (StoredFileReferenceInput | null | undefined)[];
  readonly original?: string;
  readonly updated?: string;
}

export interface ToolArgumentContentInput {
  readonly name?: unknown;
  readonly arguments?: unknown;
  readonly output?: unknown;
}

interface ImportedConversationMetadataInput extends ModelParameterContentInput {
  readonly title?: string;
  readonly promptPrefix?: string | null;
  readonly system?: string;
  readonly context?: string;
  readonly greeting?: string;
  readonly examples?: PresetContentInput['examples'];
  readonly instructions?: string | null;
  readonly additional_instructions?: string | null;
  readonly artifacts?: string;
  readonly presetOverride?: PresetContentInput | null;
}

export interface ConversationImportContentInput {
  readonly conversations: readonly (ImportedConversationMetadataInput | null | undefined)[];
  readonly messages: readonly (StoredMessageContentInput | null | undefined)[];
}

function fragment<Source extends ContentSource>(
  id: string,
  path: JsonPointer,
  text: string,
  source: Source,
  field: ContentFieldMap[Source],
  format: TextContentFragment['format'] = 'plain',
  treatment: TextContentFragment['treatment'] = 'replaceable',
): Extract<TextContentFragment, { source: Source }> {
  return {
    id,
    path,
    text,
    source,
    field,
    format,
    treatment,
    provenance: 'user',
  } as Extract<TextContentFragment, { source: Source }>;
}

function pushString<Source extends ContentSource>(
  fragments: TextContentFragment[],
  value: unknown,
  params: {
    id: string;
    path: JsonPointer;
    source: Source;
    field: ContentFieldMap[Source];
    format?: TextContentFragment['format'];
    treatment?: TextContentFragment['treatment'];
  },
): void {
  if (typeof value !== 'string' || value.length === 0) {
    return;
  }
  fragments.push(
    fragment(
      params.id,
      params.path,
      value,
      params.source,
      params.field,
      params.format,
      params.treatment,
    ),
  );
}

function appendPointer(path: JsonPointer | '', key: string): JsonPointer {
  return `${path}/${escapeJsonPointer(key)}` as JsonPointer;
}

const MODEL_PARAMETER_FIELD_BY_KEY = new Map<string, ContentFieldMap['model_parameter']>([
  ['stop', 'stop'],
  ['additionalModelRequestFields', 'request_fields'],
  ['additional_model_request_fields', 'request_fields'],
  ['response_format', 'response_format'],
  ['responseFormat', 'response_format'],
  ['metadata', 'metadata'],
]);
const ALL_MODEL_PARAMETER_FIELDS = [
  'stop',
  'request_fields',
  'response_format',
  'metadata',
] as const satisfies readonly ContentFieldMap['model_parameter'][];

const STORED_MESSAGE_HANDLED_PART_PATH_SUFFIXES = new Set([
  '/type',
  '/text',
  '/think',
  '/original',
  '/updated',
  '/steer',
  '/quotes',
  '/error',
  '/image_url',
  '/video_url',
  '/input_audio',
  '/image_file',
  '/files',
  '/tool_call/args',
  '/tool_call/name',
  '/tool_call/arguments',
  '/tool_call/output',
  '/tool_call/function/name',
  '/tool_call/function/arguments',
  '/tool_call/function/output',
  '/tool_call/code_interpreter/input',
  '/tool_call/code_interpreter/outputs',
]);
function getModelParameterWrapperFields(
  value: object,
): readonly ContentFieldMap['model_parameter'][] {
  const pending: { readonly value: object; readonly depth: number }[] = [{ value, depth: 0 }];
  const seen = new WeakSet<object>();
  const fields = new Set<ContentFieldMap['model_parameter']>();
  let visitedNodes = 0;
  let incomplete = false;

  while (pending.length > 0 && visitedNodes < CONTENT_TRAVERSAL_MAX_NODES) {
    const current = pending.pop();
    if (current == null || seen.has(current.value)) {
      continue;
    }
    seen.add(current.value);
    visitedNodes++;

    const remainingNodes = Math.max(0, CONTENT_TRAVERSAL_MAX_NODES - visitedNodes - pending.length);
    const boundedEntries = getBoundedOwnEnumerableEntries(current.value, remainingNodes);
    const entries = boundedEntries.entries;
    if (!boundedEntries.complete) {
      incomplete = true;
    }
    for (const [key, entryValue] of entries) {
      const registeredField = MODEL_PARAMETER_FIELD_BY_KEY.get(key);
      if (registeredField != null) {
        fields.add(registeredField);
        continue;
      }
      if (key !== 'model_parameters' && key !== 'options') {
        fields.add('request_fields');
        continue;
      }
      if (
        entryValue == null ||
        typeof entryValue !== 'object' ||
        Array.isArray(entryValue) ||
        current.depth >= CONTENT_TRAVERSAL_MAX_DEPTH ||
        visitedNodes + pending.length >= CONTENT_TRAVERSAL_MAX_NODES
      ) {
        if (entryValue != null && typeof entryValue === 'object' && !Array.isArray(entryValue)) {
          incomplete = true;
        } else {
          fields.add('request_fields');
        }
        continue;
      }
      pending.push({ value: entryValue, depth: current.depth + 1 });
    }
  }

  if (pending.length > 0) {
    incomplete = true;
  }
  if (incomplete) {
    return ALL_MODEL_PARAMETER_FIELDS;
  }
  return fields.size > 0 ? [...fields] : ['request_fields'];
}

/**
 * Extracts provider-bound text without treating every field in a conversation
 * or agent object as a model parameter. Registered fields may appear directly,
 * under a persisted `model_parameters` object, or in an import's `options`
 * object.
 */
export function extractModelParameterContent(
  input: ModelParameterContentInput | null | undefined,
  path: JsonPointer | '' = '',
): readonly TextContentFragment[] {
  const fragments: TextContentFragment[] = [];
  const seen = new WeakSet<object>();
  const traversalBudget = { visitedNodes: 0 };

  const visit = (
    value: unknown,
    currentPath: JsonPointer | '',
    classifyUnknownAsRequestFields = false,
    wrapperDepth = 0,
  ): void => {
    if (value == null || typeof value !== 'object' || Array.isArray(value)) {
      return;
    }
    if (seen.has(value)) {
      return;
    }
    if (
      wrapperDepth > CONTENT_TRAVERSAL_MAX_DEPTH ||
      traversalBudget.visitedNodes >= CONTENT_TRAVERSAL_MAX_NODES
    ) {
      throw new ContentTraversalLimitError(fragments, [
        { source: 'model_parameter', fields: getModelParameterWrapperFields(value) },
      ]);
    }
    seen.add(value);
    traversalBudget.visitedNodes++;

    const boundedEntries = getBoundedOwnEnumerableEntries(
      value,
      Math.max(0, CONTENT_TRAVERSAL_MAX_NODES - traversalBudget.visitedNodes),
    );
    const entries = boundedEntries.entries;
    if (entries.length === 0 && !boundedEntries.complete) {
      throw new ContentTraversalLimitError(fragments, [
        { source: 'model_parameter', fields: ALL_MODEL_PARAMETER_FIELDS },
      ]);
    }
    const addNested = (
      fieldValue: unknown,
      key: string,
      field: ContentFieldMap['model_parameter'],
    ) => {
      const complete = visitNestedStrings(
        fieldValue,
        appendPointer(currentPath, key),
        (text, nestedPath) =>
          pushString(fragments, text, {
            id: `model-parameter.${field}.${fragments.length}`,
            path: nestedPath,
            source: 'model_parameter',
            field,
            treatment: 'inspect_only',
          }),
        { includeKeys: true, budget: traversalBudget },
      );
      if (!complete) {
        throw new ContentTraversalLimitError(fragments, [
          { source: 'model_parameter', fields: [field] },
        ]);
      }
    };

    for (let index = 0; index < entries.length; index++) {
      const [key, fieldValue] = entries[index];
      const registeredField = MODEL_PARAMETER_FIELD_BY_KEY.get(key);
      const isWrapper = key === 'model_parameters' || key === 'options';
      if (registeredField == null && !isWrapper && !classifyUnknownAsRequestFields) {
        continue;
      }
      if (traversalBudget.visitedNodes >= CONTENT_TRAVERSAL_MAX_NODES) {
        const remainingObject = Object.fromEntries(entries.slice(index));
        throw new ContentTraversalLimitError(fragments, [
          {
            source: 'model_parameter',
            fields: boundedEntries.complete
              ? getModelParameterWrapperFields(remainingObject)
              : ALL_MODEL_PARAMETER_FIELDS,
          },
        ]);
      }
      traversalBudget.visitedNodes++;

      if (registeredField != null) {
        addNested(fieldValue, key, registeredField);
        continue;
      }
      if (isWrapper) {
        if (fieldValue != null && typeof fieldValue === 'object' && !Array.isArray(fieldValue)) {
          visit(fieldValue, appendPointer(currentPath, key), true, wrapperDepth + 1);
        } else {
          addNested(fieldValue, key, 'request_fields');
        }
        continue;
      }
      addNested(fieldValue, key, 'request_fields');
    }
    if (!boundedEntries.complete) {
      throw new ContentTraversalLimitError(fragments, [
        { source: 'model_parameter', fields: ALL_MODEL_PARAMETER_FIELDS },
      ]);
    }
  };

  visit(input, path);
  return fragments;
}

export function visitBoundedSubmittedArray<Value>(
  candidate: unknown,
  budget: VisitNestedStringsBudget,
  visit: (value: Value | null | undefined, index: number) => void,
): boolean {
  if (candidate == null) {
    return true;
  }
  let isArray: boolean;
  let length: number;
  try {
    isArray = Array.isArray(candidate);
    if (!isArray) {
      return false;
    }
    length = (candidate as readonly unknown[]).length;
  } catch {
    return false;
  }
  if (!Number.isSafeInteger(length) || length < 0) {
    return false;
  }
  const maxNodes = budget.maxNodes ?? CONTENT_TRAVERSAL_MAX_NODES;
  if (
    !Number.isSafeInteger(maxNodes) ||
    maxNodes < 0 ||
    !Number.isSafeInteger(budget.visitedNodes) ||
    budget.visitedNodes < 0
  ) {
    return false;
  }
  const values = candidate as readonly (Value | null | undefined)[];
  let index = 0;
  for (; index < length; index++) {
    if (budget.visitedNodes >= maxNodes) {
      break;
    }
    budget.visitedNodes++;
    let value: Value | null | undefined;
    try {
      value = values[index];
    } catch {
      return false;
    }
    visit(value, index);
  }
  return index === length;
}

function appendAgentDefinitionContent(
  fragments: TextContentFragment[],
  input: AgentContentInput | null | undefined,
  traversalBudget: VisitNestedStringsBudget,
): void {
  const add = (value: unknown, field: ContentFieldMap['agent_instruction'], path: JsonPointer) =>
    pushString(fragments, value, {
      id: `agent.${field}.${fragments.length}`,
      path,
      source: 'agent_instruction',
      field,
    });

  add(input?.name, 'name', '/name');
  add(input?.category, 'category', '/category');
  add(input?.description, 'description', '/description');
  add(input?.instructions, 'instructions', '/instructions');
  add(input?.additional_instructions, 'additional_instructions', '/additional_instructions');
  add(input?.artifacts, 'artifacts', '/artifacts');
  add(input?.support_contact?.name, 'support_contact_name', '/support_contact/name');
  add(input?.support_contact?.email, 'support_contact_email', '/support_contact/email');

  const startersComplete = visitBoundedSubmittedArray<string>(
    input?.conversation_starters,
    traversalBudget,
    (starter, index) => {
      pushString(fragments, starter, {
        id: `agent.conversation-starter.${index}`,
        path: `/conversation_starters/${index}`,
        source: 'conversation_starter',
        field: 'text',
      });
    },
  );
  const edgesComplete = visitBoundedSubmittedArray<AgentEdgeInput>(
    input?.edges,
    traversalBudget,
    (edge, index) => {
      add(edge?.description, 'edge_description', `/edges/${index}/description`);
      add(edge?.prompt, 'edge_prompt', `/edges/${index}/prompt`);
      add(edge?.promptKey, 'edge_prompt_key', `/edges/${index}/promptKey`);
    },
  );
  if (!startersComplete || !edgesComplete) {
    throw new ContentTraversalLimitError(fragments, [
      { source: 'conversation_starter', fields: ['text'] },
      {
        source: 'agent_instruction',
        fields: ['edge_description', 'edge_prompt', 'edge_prompt_key'],
      },
    ]);
  }
}

export function extractAgentContent(
  input: AgentContentInput | null | undefined,
): readonly TextContentFragment[] {
  const fragments: TextContentFragment[] = [];
  const traversalErrors: ContentTraversalLimitError[] = [];
  const traversalBudget: VisitNestedStringsBudget = { visitedNodes: 0 };
  appendAgentDefinitionContent(fragments, input, traversalBudget);
  appendFunctionToolsContent(
    fragments,
    input?.toolDefinitions,
    '/toolDefinitions',
    traversalErrors,
    traversalBudget,
  );
  collectTraversalAwareContent(fragments, traversalErrors, () =>
    extractModelParameterContent(input),
  );
  throwCollectedTraversalErrors(fragments, traversalErrors);
  return fragments;
}

function extractFunctionToolContent(
  fragments: TextContentFragment[],
  tool: FunctionToolContentInput | null | undefined,
  path: JsonPointer,
  traversalBudget: VisitNestedStringsBudget,
): void {
  const definition = tool?.function ?? tool;
  if (definition == null) {
    return;
  }
  const definitionPath = (tool?.function == null ? path : `${path}/function`) as JsonPointer;
  pushString(fragments, definition.name, {
    id: `function-tool.name.${fragments.length}`,
    path: `${definitionPath}/name` as JsonPointer,
    source: 'agent_instruction',
    field: 'name',
  });
  pushString(fragments, definition.name, {
    id: `function-tool.tool-name.${fragments.length}`,
    path: `${definitionPath}/name` as JsonPointer,
    source: 'tool_argument',
    field: 'name',
    treatment: 'inspect_only',
  });
  pushString(fragments, definition.description, {
    id: `function-tool.description.${fragments.length}`,
    path: `${definitionPath}/description` as JsonPointer,
    source: 'agent_instruction',
    field: 'description',
  });
  const parameterId = `function-tool.parameters.${fragments.length}`;
  fragments.push(
    ...extractSubmittedValueContent(
      definition.parameters,
      `${definitionPath}/parameters` as JsonPointer,
      ({ text, path: parameterPath, format, index, serialized }) => [
        fragment(
          `${parameterId}${serialized ? '' : `.nested.${index}`}`,
          parameterPath,
          text,
          'tool_argument',
          'arguments',
          format,
          'inspect_only',
        ),
      ],
      [{ source: 'tool_argument', fields: ['arguments'] }],
      traversalBudget,
    ),
  );
}

function collectTraversalAwareContent(
  fragments: TextContentFragment[],
  traversalErrors: ContentTraversalLimitError[],
  extract: () => readonly TextContentFragment[],
): void {
  try {
    fragments.push(...extract());
  } catch (error) {
    if (!(error instanceof ContentTraversalLimitError)) {
      throw error;
    }
    fragments.push(...getContentTraversalFragments(error));
    traversalErrors.push(error);
  }
}

function appendFunctionToolsContent(
  fragments: TextContentFragment[],
  tools: readonly (string | FunctionToolContentInput | null | undefined)[] | undefined,
  path: JsonPointer,
  traversalErrors: ContentTraversalLimitError[],
  traversalBudget: VisitNestedStringsBudget,
): void {
  const complete = visitBoundedSubmittedArray<string | FunctionToolContentInput>(
    tools,
    traversalBudget,
    (tool, index) => {
      if (typeof tool === 'string') {
        return;
      }
      try {
        extractFunctionToolContent(
          fragments,
          tool,
          `${path}/${index}` as JsonPointer,
          traversalBudget,
        );
      } catch (error) {
        if (!(error instanceof ContentTraversalLimitError)) {
          throw error;
        }
        fragments.push(...getContentTraversalFragments(error));
        traversalErrors.push(error);
      }
    },
  );
  if (!complete) {
    traversalErrors.push(
      new ContentTraversalLimitError(fragments, [
        { source: 'agent_instruction', fields: ['name', 'description'] },
        { source: 'tool_argument', fields: ['name', 'arguments'] },
      ]),
    );
  }
}

function throwCollectedTraversalErrors(
  fragments: readonly TextContentFragment[],
  traversalErrors: readonly ContentTraversalLimitError[],
): void {
  if (traversalErrors.length === 0) {
    return;
  }
  throw new ContentTraversalLimitError(
    fragments,
    traversalErrors.flatMap((error) => getContentTraversalScopes(error)),
  );
}

export function extractAssistantContent(
  input: AssistantContentInput | null | undefined,
): readonly TextContentFragment[] {
  const fragments: TextContentFragment[] = [];
  const traversalErrors: ContentTraversalLimitError[] = [];
  const traversalBudget: VisitNestedStringsBudget = { visitedNodes: 0 };
  appendAgentDefinitionContent(fragments, input, traversalBudget);
  appendFunctionToolsContent(
    fragments,
    input?.toolDefinitions,
    '/toolDefinitions',
    traversalErrors,
    traversalBudget,
  );
  appendFunctionToolsContent(fragments, input?.tools, '/tools', traversalErrors, traversalBudget);
  collectTraversalAwareContent(fragments, traversalErrors, () =>
    extractModelParameterContent(input),
  );
  throwCollectedTraversalErrors(fragments, traversalErrors);
  return fragments;
}

export function extractAssistantActionContent(
  input: AssistantActionContentInput | null | undefined,
): readonly TextContentFragment[] {
  const fragments: TextContentFragment[] = [];
  const traversalErrors: ContentTraversalLimitError[] = [];
  const traversalBudget: VisitNestedStringsBudget = { visitedNodes: 0 };
  appendFunctionToolsContent(
    fragments,
    input?.functions,
    '/functions',
    traversalErrors,
    traversalBudget,
  );
  collectTraversalAwareContent(fragments, traversalErrors, () =>
    extractSubmittedValueContent(
      input?.metadata?.raw_spec,
      '/metadata/raw_spec',
      ({ text, path, format, index, serialized }) => {
        const suffix = serialized ? '' : `.nested.${index}`;
        return [
          fragment(
            `assistant-action.raw-spec${suffix}`,
            path,
            text,
            'tool_argument',
            'arguments',
            format,
            'inspect_only',
          ),
          fragment(
            `action-metadata.raw-spec${suffix}`,
            path,
            text,
            'action_metadata',
            'raw_spec',
            format,
            'inspect_only',
          ),
        ];
      },
      [
        { source: 'tool_argument', fields: ['arguments'] },
        { source: 'action_metadata', fields: ['raw_spec'] },
      ],
    ),
  );
  const addMetadata = (
    value: unknown,
    field: ContentFieldMap['action_metadata'],
    path: JsonPointer,
  ) =>
    pushString(fragments, value, {
      id: `action-metadata.${field}.${fragments.length}`,
      path,
      source: 'action_metadata',
      field,
      treatment: 'inspect_only',
    });
  const metadata = input?.metadata;
  addMetadata(metadata?.domain, 'domain', '/metadata/domain');
  addMetadata(metadata?.privacy_policy_url, 'privacy_policy_url', '/metadata/privacy_policy_url');
  addMetadata(metadata?.api_key, 'api_key', '/metadata/api_key');
  addMetadata(metadata?.oauth_client_id, 'oauth_client_id', '/metadata/oauth_client_id');
  addMetadata(
    metadata?.oauth_client_secret,
    'oauth_client_secret',
    '/metadata/oauth_client_secret',
  );

  const addAuthFields = (auth: ActionAuthContentInput | null | undefined, prefix: string) => {
    for (const field of [
      'authorization_type',
      'custom_auth_header',
      'authorization_content_type',
      'authorization_url',
      'client_url',
      'scope',
      'token_exchange_method',
    ] as const) {
      addMetadata(auth?.[field], field, `${prefix}/${field}` as JsonPointer);
    }
  };
  addAuthFields(metadata?.auth, '/metadata/auth');
  /** Accept legacy/direct metadata shapes without weakening the closed field
   *  catalog; current clients place these values under `metadata.auth`. */
  addAuthFields(metadata, '/metadata');
  throwCollectedTraversalErrors(fragments, traversalErrors);
  return fragments;
}

function extractPromptRecord(
  fragments: TextContentFragment[],
  input: PromptRecordContentInput | null | undefined,
  prefix: string,
): void {
  const add = (value: unknown, field: ContentFieldMap['prompt'], key: string) =>
    pushString(fragments, value, {
      id: `prompt.${prefix || 'root'}.${field}`,
      path: `/${prefix}${key}` as JsonPointer,
      source: 'prompt',
      field,
    });
  add(input?.name, 'name', 'name');
  add(input?.description, 'description', 'description');
  add(input?.oneliner, 'oneliner', 'oneliner');
  add(input?.category, 'category', 'category');
  add(input?.command, 'command', 'command');
  add(input?.prompt, 'text', 'prompt');
}

export function extractPromptContent(
  input: PromptContentInput | null | undefined,
): readonly TextContentFragment[] {
  const fragments: TextContentFragment[] = [];
  extractPromptRecord(fragments, input, '');
  if (typeof input?.prompt === 'object') {
    extractPromptRecord(fragments, input.prompt, 'prompt/');
  }
  extractPromptRecord(fragments, input?.group, 'group/');
  return fragments;
}

function appendPresetDefinitionContent(
  fragments: TextContentFragment[],
  input: PresetContentInput | null | undefined,
): void {
  fragments.push(...extractPromptContent(input));
  const add = (value: unknown, field: ContentFieldMap['prompt'], path: JsonPointer) =>
    pushString(fragments, value, {
      id: `preset.${field}.${fragments.length}`,
      path,
      source: 'prompt',
      field,
    });
  add(input?.title, 'name', '/title');
  add(input?.promptPrefix, 'preset_text', '/promptPrefix');
  add(input?.system, 'system', '/system');
  add(input?.context, 'context', '/context');
  add(input?.instructions, 'instructions', '/instructions');
  add(input?.additional_instructions, 'additional_instructions', '/additional_instructions');
  add(input?.greeting, 'greeting', '/greeting');
  const examplesComplete = visitBoundedSubmittedArray<PresetExampleInput>(
    input?.examples,
    { visitedNodes: 0 },
    (example, index) => {
      const exampleInput =
        typeof example?.input === 'string' ? example.input : example?.input?.content;
      const exampleOutput =
        typeof example?.output === 'string' ? example.output : example?.output?.content;
      add(
        exampleInput,
        'example_input',
        typeof example?.input === 'string'
          ? `/examples/${index}/input`
          : `/examples/${index}/input/content`,
      );
      add(
        exampleOutput,
        'example_output',
        typeof example?.output === 'string'
          ? `/examples/${index}/output`
          : `/examples/${index}/output/content`,
      );
    },
  );
  if (!examplesComplete) {
    throw new ContentTraversalLimitError(fragments, [
      { source: 'prompt', fields: ['example_input', 'example_output'] },
    ]);
  }
}

export function extractPresetPromptContent(
  input: PresetContentInput | null | undefined,
): readonly TextContentFragment[] {
  const fragments: TextContentFragment[] = [];
  appendPresetDefinitionContent(fragments, input);
  return fragments;
}

export function extractPresetContent(
  input: PresetContentInput | null | undefined,
): readonly TextContentFragment[] {
  const fragments: TextContentFragment[] = [];
  const traversalErrors: ContentTraversalLimitError[] = [];
  collectTraversalAwareContent(fragments, traversalErrors, () => extractPresetPromptContent(input));
  collectTraversalAwareContent(fragments, traversalErrors, () =>
    extractModelParameterContent(input),
  );
  throwCollectedTraversalErrors(fragments, traversalErrors);
  return fragments;
}

export function extractSkillContent(
  input: SkillContentInput | null | undefined,
): readonly TextContentFragment[] {
  const fragments: TextContentFragment[] = [];
  const add = (
    value: unknown,
    field: ContentFieldMap['skill'],
    path: JsonPointer,
    treatment: TextContentFragment['treatment'] = 'replaceable',
  ) =>
    pushString(fragments, value, {
      id: `skill.${field}.${fragments.length}`,
      path,
      source: 'skill',
      field,
      treatment,
    });
  add(input?.name, 'name', '/name');
  add(input?.displayTitle, 'display_title', '/displayTitle');
  add(input?.description, 'description', '/description');
  add(input?.category, 'category', '/category');
  add(input?.body, 'instructions', '/body');
  add(input?.instructions, 'instructions', '/instructions');
  add(input?.importedText, 'imported_text', '/importedText', 'inspect_only');

  const traversalBudget: VisitNestedStringsBudget = { visitedNodes: 0 };
  const frontmatterComplete =
    input?.frontmatter == null ||
    visitNestedStrings(
      input.frontmatter,
      '/frontmatter',
      (value, path) => add(value, 'frontmatter', path),
      { includeKeys: true, budget: traversalBudget },
    );
  const filesComplete = visitBoundedSubmittedArray<SkillFileContentInput>(
    input?.files,
    traversalBudget,
    (file, index) => {
      add(file?.name, 'file_name', `/files/${index}/name`);
      add(file?.filename, 'file_name', `/files/${index}/filename`);
      add(file?.text, 'file_text', `/files/${index}/text`, 'inspect_only');
      add(file?.content, 'file_text', `/files/${index}/content`, 'inspect_only');
    },
  );
  if (!frontmatterComplete || !filesComplete) {
    throw new ContentTraversalLimitError(fragments, [
      ...(!frontmatterComplete ? ([{ source: 'skill', fields: ['frontmatter'] }] as const) : []),
      ...(!filesComplete
        ? ([{ source: 'skill', fields: ['file_name', 'file_text'] }] as const)
        : []),
    ]);
  }
  return fragments;
}

export function extractMemoryContent(
  input: MemoryContentInput | null | undefined,
): readonly TextContentFragment[] {
  const fragments: TextContentFragment[] = [];
  for (const field of ['key', 'value', 'summary'] as const) {
    pushString(fragments, input?.[field], {
      id: `memory.${field}`,
      path: `/${field}`,
      source: 'memory',
      field,
    });
  }
  return fragments;
}

export function extractFileContent(
  input: FileContentInput | null | undefined,
): readonly TextContentFragment[] {
  const fragments: TextContentFragment[] = [];
  const coverage = input == null ? undefined : getCanonicalFileInspectionCoverage(input);
  for (const key of ['name', 'filename', 'originalname'] as const) {
    pushString(fragments, input?.[key], {
      id: `file.name.${key}`,
      path: `/${key}`,
      source: 'file',
      field: 'name',
    });
  }
  pushString(fragments, coverage?.content, {
    id: 'file.content',
    path: '/content',
    source: 'file',
    field: 'content',
    treatment: 'inspect_only',
  });
  const extractedTextKeys =
    coverage?.textProvidesTranscript === true
      ? (['extractedText'] as const)
      : (['extractedText', 'text'] as const);
  for (const key of extractedTextKeys) {
    pushString(fragments, input?.[key], {
      id: `file.extracted-text.${key}`,
      path: `/${key}`,
      source: 'file',
      field: 'extracted_text',
      treatment: 'inspect_only',
    });
  }
  pushString(fragments, coverage?.transcript, {
    id: 'file.transcript',
    path: '/transcript',
    source: 'file',
    field: 'transcript',
    treatment: 'inspect_only',
  });
  for (const key of ['uri', 'filepath', 'url', 'preview'] as const) {
    pushString(fragments, input?.[key], {
      id: `file.uri.${key}`,
      path: `/${key}`,
      source: 'file',
      field: 'uri',
      format: 'uri',
      treatment: 'inspect_only',
    });
  }
  return fragments;
}

export function extractFeedbackContent(
  input: FeedbackContentInput | null | undefined,
): readonly TextContentFragment[] {
  const fragments: TextContentFragment[] = [];
  pushString(fragments, input?.feedback?.text, {
    id: 'feedback.nested-text',
    path: '/feedback/text',
    source: 'feedback',
    field: 'text',
  });
  pushString(fragments, input?.text, {
    id: 'feedback.text',
    path: '/text',
    source: 'feedback',
    field: 'text',
  });
  return fragments;
}

export function extractConversationTitleContent(
  input: string | { readonly title?: string } | null | undefined,
): readonly TextContentFragment[] {
  const fragments: TextContentFragment[] = [];
  pushString(fragments, typeof input === 'string' ? input : input?.title, {
    id: 'conversation-title.title',
    path: '/title',
    source: 'conversation_title',
    field: 'title',
  });
  return fragments;
}

const STORED_MESSAGE_CONTENT_ARRAY_SCOPES: readonly ContentTraversalScope[] = [
  { source: 'message', fields: ['content_part', 'summary', 'attachment_reference'] },
  { source: 'assembled_context', fields: ['assembled_context'] },
  { source: 'file', fields: ['name', 'uri'] },
  { source: 'tool_argument', fields: ['name', 'arguments', 'output'] },
];
const STORED_MESSAGE_NESTED_CONTENT_SCOPES: readonly ContentTraversalScope[] = [
  { source: 'message', fields: ['content_part'] },
  { source: 'assembled_context', fields: ['assembled_context'] },
];
const STORED_MESSAGE_ATTACHMENT_ARRAY_SCOPES: readonly ContentTraversalScope[] = [
  { source: 'message', fields: ['attachment_reference'] },
  { source: 'file', fields: ['name', 'uri'] },
];
const STORED_MESSAGE_TOOL_CALL_ARRAY_SCOPES: readonly ContentTraversalScope[] = [
  { source: 'tool_argument', fields: ['name', 'arguments', 'output'] },
];
const STORED_MESSAGE_QUOTE_ARRAY_SCOPES: readonly ContentTraversalScope[] = [
  { source: 'message', fields: ['quote'] },
];

function extractStoredMessageContentWithBudget(
  input: StoredMessageContentInput | null | undefined,
  traversalBudget: VisitNestedStringsBudget,
): readonly TextContentFragment[] {
  const fragments: TextContentFragment[] = [];
  const assembledText: string[] = [];
  let assembledCharacters = 0;
  const traversalScopes: ContentTraversalScope[] = [];
  let traversalComplete = true;
  const traversalMaxNodes = traversalBudget.maxNodes ?? CONTENT_TRAVERSAL_MAX_NODES;
  let reservedTraversalWork = 0;
  const markTraversalIncomplete = (scopes: readonly ContentTraversalScope[]): void => {
    traversalComplete = false;
    traversalScopes.push(...scopes);
  };
  const consumeTraversalWork = (scopes: readonly ContentTraversalScope[]): boolean => {
    if (
      !Number.isSafeInteger(traversalMaxNodes) ||
      traversalMaxNodes < 0 ||
      !Number.isSafeInteger(traversalBudget.visitedNodes) ||
      traversalBudget.visitedNodes < 0 ||
      traversalBudget.visitedNodes >= traversalMaxNodes - reservedTraversalWork
    ) {
      markTraversalIncomplete(scopes);
      return false;
    }
    traversalBudget.visitedNodes++;
    return true;
  };
  interface BoundedArraySnapshot<Value> {
    readonly length: number;
    readonly values: readonly (Value | null | undefined)[];
  }
  const captureBoundedArray = <Value>(
    candidate: unknown,
    scopes: readonly ContentTraversalScope[],
  ): BoundedArraySnapshot<Value> | null => {
    let isArray: boolean;
    let length: number;
    try {
      isArray = Array.isArray(candidate);
      if (!isArray) {
        if (candidate != null) {
          markTraversalIncomplete(scopes);
        }
        return null;
      }
      length = (candidate as readonly unknown[]).length;
    } catch {
      markTraversalIncomplete(scopes);
      return null;
    }
    if (!Number.isSafeInteger(length) || length < 0) {
      markTraversalIncomplete(scopes);
      return null;
    }
    return {
      length,
      values: candidate as readonly (Value | null | undefined)[],
    };
  };
  const visitBoundedArray = <Value>(
    snapshot: BoundedArraySnapshot<Value> | null,
    scopes: readonly ContentTraversalScope[],
    visit: (value: Value | null | undefined, index: number) => void,
  ): void => {
    if (snapshot == null) {
      return;
    }
    for (let index = 0; index < snapshot.length; index++) {
      if (!consumeTraversalWork(scopes)) {
        break;
      }
      let value: Value | null | undefined;
      try {
        value = snapshot.values[index];
      } catch {
        markTraversalIncomplete(scopes);
        break;
      }
      visit(value, index);
    }
  };
  const withReservedTraversalWork = (reserve: number, visit: () => void): void => {
    const previousReserve = reservedTraversalWork;
    reservedTraversalWork += reserve;
    try {
      visit();
    } finally {
      reservedTraversalWork = previousReserve;
    }
  };
  const activeTraversalBudget: VisitNestedStringsBudget = {
    get visitedNodes() {
      return traversalBudget.visitedNodes;
    },
    set visitedNodes(value: number) {
      traversalBudget.visitedNodes = value;
    },
    get maxNodes() {
      return traversalMaxNodes - reservedTraversalWork;
    },
  };
  const snapshotNestedContentPart = (candidate: unknown): unknown => {
    if (candidate == null || typeof candidate !== 'object') {
      return candidate;
    }
    const snapshot = Object.create(null) as Record<string, unknown>;
    try {
      if (isProxy(candidate)) {
        markTraversalIncomplete(STORED_MESSAGE_NESTED_CONTENT_SCOPES);
        snapshot.text = (candidate as { readonly text?: unknown }).text;
        return snapshot;
      }
      const entryLimit = Math.max(
        1,
        (activeTraversalBudget.maxNodes ?? CONTENT_TRAVERSAL_MAX_NODES) -
          activeTraversalBudget.visitedNodes +
          1,
      );
      const boundedEntries = getBoundedOwnEnumerableEntries(candidate, entryLimit);
      for (const [key, value] of boundedEntries.entries) {
        snapshot[key] = value;
      }
      if (!boundedEntries.complete) {
        markTraversalIncomplete(STORED_MESSAGE_NESTED_CONTENT_SCOPES);
      }
    } catch {
      markTraversalIncomplete(STORED_MESSAGE_NESTED_CONTENT_SCOPES);
    }
    return snapshot;
  };
  const isInstruction = input?.role === 'system' || input?.role === 'developer';
  const isToolOutput = input?.role === 'tool';
  const addMessagePart = (value: unknown, id: string, path: JsonPointer) => {
    if (typeof value === 'string' && value.length > 0) {
      assembledText.push(value);
      assembledCharacters += value.length;
    }
    pushString(fragments, value, {
      id,
      path,
      source: 'message',
      field: 'content_part',
    });
    if (isInstruction) {
      pushString(fragments, value, {
        id: `${id}.instruction`,
        path,
        source: 'agent_instruction',
        field: 'instructions',
      });
    }
    if (isToolOutput) {
      pushString(fragments, value, {
        id: `${id}.tool-output`,
        path,
        source: 'tool_argument',
        field: 'output',
        treatment: 'inspect_only',
      });
    }
  };
  const addToolValue = (
    value: unknown,
    field: ContentFieldMap['tool_argument'],
    id: string,
    path: JsonPointer,
  ) => {
    try {
      fragments.push(...extractToolArgumentValue(value, field, id, path, activeTraversalBudget));
    } catch (error) {
      if (!(error instanceof ContentTraversalLimitError)) {
        throw error;
      }
      fragments.push(...getContentTraversalFragments(error));
      const scopes = getContentTraversalScopes(error);
      const fallbackScope: ContentTraversalScope = {
        source: 'tool_argument',
        fields: [field],
      };
      traversalScopes.push(...(scopes.length > 0 ? scopes : [fallbackScope]));
    }
  };
  const addAttachment = (
    file: StoredFileReferenceInput | null | undefined,
    id: string,
    path: JsonPointer,
  ) => {
    const references = [
      { key: 'uri', value: file?.uri, format: 'uri' as const, fileField: 'uri' as const },
      { key: 'url', value: file?.url, format: 'uri' as const, fileField: 'uri' as const },
      {
        key: 'preview',
        value: file?.preview,
        format: 'uri' as const,
        fileField: 'uri' as const,
      },
      {
        key: 'filepath',
        value: file?.filepath,
        format: 'uri' as const,
        fileField: 'uri' as const,
      },
      {
        key: 'file_id',
        value: file?.file_id,
        format: 'plain' as const,
        fileField: undefined,
      },
      { key: 'name', value: file?.name, format: 'plain' as const, fileField: 'name' as const },
      {
        key: 'filename',
        value: file?.filename,
        format: 'plain' as const,
        fileField: 'name' as const,
      },
      {
        key: 'originalname',
        value: file?.originalname,
        format: 'plain' as const,
        fileField: 'name' as const,
      },
    ];
    for (const reference of references) {
      if (
        typeof reference.value !== 'string' ||
        reference.value.length === 0 ||
        isDataUri(reference.value)
      ) {
        continue;
      }
      pushString(fragments, reference.value, {
        id: `${id}.${reference.key}`,
        path: `${path}/${reference.key}`,
        source: 'message',
        field: 'attachment_reference',
        format: reference.format,
        treatment: 'inspect_only',
      });
      if (reference.fileField != null) {
        pushString(fragments, reference.value, {
          id: `${id}.file.${reference.key}`,
          path: `${path}/${reference.key}`,
          source: 'file',
          field: reference.fileField,
          format: reference.format,
          treatment: 'inspect_only',
        });
      }
    }
  };
  for (const key of ['name', 'sender'] as const) {
    pushString(fragments, input?.[key], {
      id: `stored-message.name.${key}`,
      path: `/${key}`,
      source: 'message',
      field: 'name',
    });
  }
  pushString(fragments, input?.text, {
    id: 'stored-message.text',
    path: '/text',
    source: 'message',
    field: 'text',
  });
  if (typeof input?.text === 'string' && input.text.length > 0) {
    assembledText.push(input.text);
    assembledCharacters += input.text.length;
  }
  if (isInstruction) {
    pushString(fragments, input?.text, {
      id: 'stored-message.text.instruction',
      path: '/text',
      source: 'agent_instruction',
      field: 'instructions',
    });
  }
  if (isToolOutput) {
    pushString(fragments, input?.text, {
      id: 'stored-message.text.tool-output',
      path: '/text',
      source: 'tool_argument',
      field: 'output',
      treatment: 'inspect_only',
    });
  }
  pushString(fragments, input?.summary, {
    id: 'stored-message.summary',
    path: '/summary',
    source: 'message',
    field: 'summary',
  });
  const quotes = captureBoundedArray<string | { readonly text?: string }>(
    input?.quotes,
    STORED_MESSAGE_QUOTE_ARRAY_SCOPES,
  );
  const content = captureBoundedArray<StoredMessagePartInput>(
    input?.content,
    STORED_MESSAGE_CONTENT_ARRAY_SCOPES,
  );
  const toolCalls = captureBoundedArray<StoredTopLevelToolCallInput>(
    input?.tool_calls,
    STORED_MESSAGE_TOOL_CALL_ARRAY_SCOPES,
  );
  const files = captureBoundedArray<StoredFileReferenceInput>(
    input?.files,
    STORED_MESSAGE_ATTACHMENT_ARRAY_SCOPES,
  );
  const attachments = captureBoundedArray<StoredFileReferenceInput>(
    input?.attachments,
    STORED_MESSAGE_ATTACHMENT_ARRAY_SCOPES,
  );
  const hasArrayValues = (snapshot: BoundedArraySnapshot<unknown> | null): number =>
    snapshot != null && snapshot.length > 0 ? 1 : 0;
  withReservedTraversalWork(
    hasArrayValues(content) +
      hasArrayValues(toolCalls) +
      hasArrayValues(files) +
      hasArrayValues(attachments),
    () =>
      visitBoundedArray<string | { readonly text?: string }>(
        quotes,
        STORED_MESSAGE_QUOTE_ARRAY_SCOPES,
        (quote, index) => {
          pushString(fragments, typeof quote === 'string' ? quote : quote?.text, {
            id: `stored-message.quote.${index}`,
            path: `/quotes/${index}`,
            source: 'message',
            field: 'quote',
          });
        },
      ),
  );
  withReservedTraversalWork(
    hasArrayValues(toolCalls) + hasArrayValues(files) + hasArrayValues(attachments),
    () =>
      visitBoundedArray<StoredMessagePartInput>(
        content,
        STORED_MESSAGE_CONTENT_ARRAY_SCOPES,
        (part, index) => {
          const text = typeof part?.text === 'string' ? part.text : part?.text?.value;
          addMessagePart(text, `stored-message.content.${index}.text`, `/content/${index}/text`);
          if (part?.type === 'summary') {
            pushString(fragments, text, {
              id: `stored-message.content.${index}.summary`,
              path: `/content/${index}/text`,
              source: 'message',
              field: 'summary',
            });
          }
          const think = typeof part?.think === 'string' ? part.think : part?.think?.value;
          addMessagePart(think, `stored-message.content.${index}.think`, `/content/${index}/think`);
          for (const key of ['original', 'updated', 'steer', 'error'] as const) {
            addMessagePart(
              part?.[key],
              `stored-message.content.${index}.${key}`,
              `/content/${index}/${key}`,
            );
          }
          const nestedContent = captureBoundedArray<{
            readonly text?: string | { readonly value?: string };
          }>(part?.content, STORED_MESSAGE_NESTED_CONTENT_SCOPES);
          const partFiles = captureBoundedArray<StoredFileReferenceInput>(
            part?.files,
            STORED_MESSAGE_ATTACHMENT_ARRAY_SCOPES,
          );
          /** Steer parts persist their quoted excerpts under `quotes`, exactly
           *  like the top-level `message.quotes`: model-bound user text that
           *  import and share preflights must inspect as quote fragments. */
          const partQuotes = captureBoundedArray<string | { readonly text?: string }>(
            part?.quotes,
            STORED_MESSAGE_QUOTE_ARRAY_SCOPES,
          );
          const toolCall = part?.tool_call;
          withReservedTraversalWork(
            hasArrayValues(nestedContent) + hasArrayValues(partFiles) + (toolCall != null ? 1 : 0),
            () =>
              visitBoundedArray<string | { readonly text?: string }>(
                partQuotes,
                STORED_MESSAGE_QUOTE_ARRAY_SCOPES,
                (quote, quoteIndex) => {
                  pushString(fragments, typeof quote === 'string' ? quote : quote?.text, {
                    id: `stored-message.content.${index}.quote.${quoteIndex}`,
                    path: `/content/${index}/quotes/${quoteIndex}`,
                    source: 'message',
                    field: 'quote',
                  });
                },
              ),
          );
          withReservedTraversalWork(hasArrayValues(partFiles) + (toolCall != null ? 1 : 0), () =>
            visitBoundedArray<{
              readonly text?: string | { readonly value?: string };
            }>(nestedContent, STORED_MESSAGE_NESTED_CONTENT_SCOPES, (nestedPart, nestedIndex) => {
              const capturedNestedPart = snapshotNestedContentPart(nestedPart) as
                | { readonly text?: string | { readonly value?: string } }
                | null
                | undefined;
              const value = capturedNestedPart?.text;
              const nestedPath = `/content/${index}/content/${nestedIndex}` as JsonPointer;
              addMessagePart(
                typeof value === 'string' ? value : value?.value,
                `stored-message.content.${index}.content.${nestedIndex}.text`,
                `${nestedPath}/text`,
              );
              if (capturedNestedPart == null) {
                return;
              }
              let fallbackIndex = 0;
              // Replace the numeric array-read reservation with the generic child-root charge.
              traversalBudget.visitedNodes--;
              const complete = visitNestedStrings(
                capturedNestedPart,
                nestedPath,
                (nestedText, path) => {
                  addMessagePart(
                    nestedText,
                    `stored-message.content.${index}.content.${nestedIndex}.nested.${fallbackIndex}`,
                    path,
                  );
                  fallbackIndex++;
                },
                {
                  includeKeys: true,
                  budget: activeTraversalBudget,
                  shouldVisit: ({ path }) => path !== `${nestedPath}/text`,
                  shouldInclude: shouldIncludeNestedSubmittedText,
                },
              );
              if (!complete) {
                traversalComplete = false;
              }
            }),
          );
          const imageUrl =
            typeof part?.image_url === 'string' ? part.image_url : part?.image_url?.url;
          const videoUrl = part?.video_url?.url;
          for (const [key, mediaUri] of [
            ['image_url', imageUrl],
            ['video_url', videoUrl],
          ] as const) {
            if (typeof mediaUri === 'string' && mediaUri.length > 0 && !isDataUri(mediaUri)) {
              pushString(fragments, mediaUri, {
                id: `stored-message.content.${index}.attachment.${key}`,
                path: `/content/${index}/${key}`,
                source: 'message',
                field: 'attachment_reference',
                format: 'uri',
                treatment: 'inspect_only',
              });
              pushString(fragments, mediaUri, {
                id: `stored-message.content.${index}.file.${key}`,
                path: `/content/${index}/${key}`,
                source: 'file',
                field: 'uri',
                format: 'uri',
                treatment: 'inspect_only',
              });
            }
          }
          addAttachment(
            part?.image_file,
            `stored-message.content.${index}.image-file`,
            `/content/${index}/image_file`,
          );
          withReservedTraversalWork(toolCall != null ? 1 : 0, () =>
            visitBoundedArray<StoredFileReferenceInput>(
              partFiles,
              STORED_MESSAGE_ATTACHMENT_ARRAY_SCOPES,
              (file, fileIndex) => {
                addAttachment(
                  file,
                  `stored-message.content.${index}.file.${fileIndex}`,
                  `/content/${index}/files/${fileIndex}`,
                );
              },
            ),
          );

          addToolValue(
            toolCall?.name,
            'name',
            `stored-message.content.${index}.tool-call.name`,
            `/content/${index}/tool_call/name`,
          );
          addToolValue(
            toolCall?.args,
            'arguments',
            `stored-message.content.${index}.tool-call.args`,
            `/content/${index}/tool_call/args`,
          );
          addToolValue(
            toolCall?.arguments,
            'arguments',
            `stored-message.content.${index}.tool-call.arguments`,
            `/content/${index}/tool_call/arguments`,
          );
          addToolValue(
            toolCall?.function?.name,
            'name',
            `stored-message.content.${index}.tool-call.function.name`,
            `/content/${index}/tool_call/function/name`,
          );
          addToolValue(
            toolCall?.function?.arguments,
            'arguments',
            `stored-message.content.${index}.tool-call.function.arguments`,
            `/content/${index}/tool_call/function/arguments`,
          );
          addToolValue(
            toolCall?.function?.output,
            'output',
            `stored-message.content.${index}.tool-call.function.output`,
            `/content/${index}/tool_call/function/output`,
          );
          addToolValue(
            toolCall?.code_interpreter?.input,
            'arguments',
            `stored-message.content.${index}.tool-call.code-interpreter.input`,
            `/content/${index}/tool_call/code_interpreter/input`,
          );
          addToolValue(
            toolCall?.code_interpreter?.outputs,
            'output',
            `stored-message.content.${index}.tool-call.code-interpreter.outputs`,
            `/content/${index}/tool_call/code_interpreter/outputs`,
          );
          addToolValue(
            toolCall?.output,
            'output',
            `stored-message.content.${index}.tool-call.output`,
            `/content/${index}/tool_call/output`,
          );

          if (part != null) {
            const basePath = `/content/${index}` as JsonPointer;
            const isHandledPath = (path: JsonPointer): boolean => {
              const suffix = path.slice(basePath.length);
              if (suffix === '/content' && nestedContent != null) {
                return true;
              }
              if (STORED_MESSAGE_HANDLED_PART_PATH_SUFFIXES.has(suffix)) {
                return true;
              }
              return false;
            };
            let fallbackIndex = 0;
            // The bounded content loop already reserved one unit for this part. Let the
            // generic visitor replace that reservation with its root-node charge.
            traversalBudget.visitedNodes--;
            const complete = visitNestedStrings(
              part,
              basePath,
              (nestedText, nestedPath) => {
                addMessagePart(
                  nestedText,
                  `stored-message.content.${index}.nested.${fallbackIndex}`,
                  nestedPath,
                );
                fallbackIndex++;
              },
              {
                includeKeys: true,
                budget: activeTraversalBudget,
                shouldVisit: ({ path }) => !isHandledPath(path),
                shouldInclude: shouldIncludeNestedSubmittedText,
              },
            );
            if (!complete) {
              traversalComplete = false;
            }
          }
        },
      ),
  );
  withReservedTraversalWork(hasArrayValues(files) + hasArrayValues(attachments), () =>
    visitBoundedArray<StoredTopLevelToolCallInput>(
      toolCalls,
      STORED_MESSAGE_TOOL_CALL_ARRAY_SCOPES,
      (toolCall, index) => {
        addToolValue(
          toolCall?.name,
          'name',
          `stored-message.tool-call.${index}.name`,
          `/tool_calls/${index}/name`,
        );
        addToolValue(
          toolCall?.arguments,
          'arguments',
          `stored-message.tool-call.${index}.arguments`,
          `/tool_calls/${index}/arguments`,
        );
        addToolValue(
          toolCall?.function?.name,
          'name',
          `stored-message.tool-call.${index}.function.name`,
          `/tool_calls/${index}/function/name`,
        );
        addToolValue(
          toolCall?.function?.arguments,
          'arguments',
          `stored-message.tool-call.${index}.function.arguments`,
          `/tool_calls/${index}/function/arguments`,
        );
        addToolValue(
          toolCall?.function?.output,
          'output',
          `stored-message.tool-call.${index}.function.output`,
          `/tool_calls/${index}/function/output`,
        );
        addToolValue(
          toolCall?.code_interpreter?.input,
          'arguments',
          `stored-message.tool-call.${index}.code-interpreter.input`,
          `/tool_calls/${index}/code_interpreter/input`,
        );
        addToolValue(
          toolCall?.code_interpreter?.outputs,
          'output',
          `stored-message.tool-call.${index}.code-interpreter.outputs`,
          `/tool_calls/${index}/code_interpreter/outputs`,
        );
        addToolValue(
          toolCall?.output,
          'output',
          `stored-message.tool-call.${index}.output`,
          `/tool_calls/${index}/output`,
        );
      },
    ),
  );
  withReservedTraversalWork(hasArrayValues(attachments), () =>
    visitBoundedArray<StoredFileReferenceInput>(
      files,
      STORED_MESSAGE_ATTACHMENT_ARRAY_SCOPES,
      (file, index) => {
        addAttachment(file, `stored-message.file.${index}`, `/files/${index}`);
      },
    ),
  );
  visitBoundedArray<StoredFileReferenceInput>(
    attachments,
    STORED_MESSAGE_ATTACHMENT_ARRAY_SCOPES,
    (attachment, index) => {
      addAttachment(attachment, `stored-message.attachment.${index}`, `/attachments/${index}`);
    },
  );
  pushString(fragments, input?.original, {
    id: 'stored-message.original',
    path: '/original',
    source: 'message',
    field: 'content_part',
  });
  pushString(fragments, input?.updated, {
    id: 'stored-message.updated',
    path: '/updated',
    source: 'message',
    field: 'content_part',
  });
  if (assembledText.length > 1) {
    if (reserveContentMaterialization(traversalBudget, assembledCharacters)) {
      const text = assembledText.join('');
      fragments.push(
        fragment(
          'stored-message.assembled',
          '/content',
          text,
          'assembled_context',
          'assembled_context',
          'plain',
          'inspect_only',
        ),
      );
      if (isInstruction) {
        fragments.push(
          fragment(
            'stored-message.assembled.instruction',
            '/content',
            text,
            'agent_instruction',
            'instructions',
            'plain',
            'inspect_only',
          ),
        );
      }
      if (isToolOutput) {
        fragments.push(
          fragment(
            'stored-message.assembled.tool-output',
            '/content',
            text,
            'tool_argument',
            'output',
            'plain',
            'inspect_only',
          ),
        );
      }
    } else {
      traversalScopes.push({ source: 'assembled_context', fields: ['assembled_context'] });
      if (isInstruction) {
        traversalScopes.push({ source: 'agent_instruction', fields: ['instructions'] });
      }
      if (isToolOutput) {
        traversalScopes.push({ source: 'tool_argument', fields: ['output'] });
      }
    }
  }
  fragments.push(...extractFeedbackContent(input));
  if (!traversalComplete) {
    traversalScopes.push(
      { source: 'message', fields: ['content_part'] },
      { source: 'assembled_context', fields: ['assembled_context'] },
    );
    if (isInstruction) {
      traversalScopes.push({ source: 'agent_instruction', fields: ['instructions'] });
    }
    if (isToolOutput) {
      traversalScopes.push({ source: 'tool_argument', fields: ['output'] });
    }
  }
  if (traversalScopes.length > 0) {
    throw new ContentTraversalLimitError(fragments, traversalScopes);
  }
  return fragments;
}

export function extractStoredMessageContent(
  input: StoredMessageContentInput | null | undefined,
  aggregateBudget: VisitNestedStringsBudget = { visitedNodes: 0 },
): readonly TextContentFragment[] {
  const aggregateMaxNodes = aggregateBudget.maxNodes ?? CONTENT_TRAVERSAL_MAX_NODES;
  const remainingAggregateNodes = Math.max(0, aggregateMaxNodes - aggregateBudget.visitedNodes);
  const traversalBudget: VisitNestedStringsBudget = {
    visitedNodes: 0,
    maxNodes: Math.min(
      CONTENT_TRAVERSAL_MAX_NODES + (aggregateBudget.maxNodes == null ? 0 : 2),
      remainingAggregateNodes,
    ),
    get materializedCharacters() {
      return aggregateBudget.materializedCharacters;
    },
    set materializedCharacters(value: number | undefined) {
      aggregateBudget.materializedCharacters = value;
    },
    get maxMaterializedCharacters() {
      return aggregateBudget.maxMaterializedCharacters;
    },
  };
  try {
    return extractStoredMessageContentWithBudget(input, traversalBudget);
  } finally {
    aggregateBudget.visitedNodes += traversalBudget.visitedNodes;
  }
}

export function* extractConversationImportContent(
  input: ConversationImportContentInput,
): Generator<TextContentFragment, void, undefined> {
  const fragments: TextContentFragment[] = [];
  const traversalErrors: ContentTraversalLimitError[] = [];
  const collect = (extract: () => readonly TextContentFragment[]) => {
    try {
      fragments.push(...extract());
    } catch (error) {
      if (!(error instanceof ContentTraversalLimitError)) {
        throw error;
      }
      fragments.push(...getContentTraversalFragments(error));
      traversalErrors.push(error);
    }
  };

  for (const conversation of input.conversations) {
    if (conversation == null) {
      continue;
    }
    fragments.push(...extractConversationTitleContent(conversation));
    appendPresetDefinitionContent(fragments, {
      promptPrefix: conversation.promptPrefix,
      system: conversation.system,
      context: conversation.context,
      greeting: conversation.greeting,
      examples: conversation.examples,
    });
    appendAgentDefinitionContent(
      fragments,
      {
        instructions: conversation.instructions,
        additional_instructions: conversation.additional_instructions,
        artifacts: conversation.artifacts,
      },
      { visitedNodes: 0 },
    );
    appendPresetDefinitionContent(fragments, conversation.presetOverride);
  }
  for (const message of input.messages) {
    collect(() => extractStoredMessageContent(message));
  }
  for (const conversation of input.conversations) {
    if (conversation == null) {
      continue;
    }
    collect(() => extractModelParameterContent(conversation));
    collect(() => extractModelParameterContent(conversation.presetOverride));
  }

  if (traversalErrors.length > 0) {
    const scopes = traversalErrors.flatMap((error) => {
      const errorScopes = getContentTraversalScopes(error);
      return errorScopes.length > 0
        ? errorScopes
        : [{ source: 'message' as const, fields: ['content_part'] as const }];
    });
    throw new ContentTraversalLimitError(fragments, scopes);
  }
  yield* fragments;
}

const OMIT_SUBMITTED_VALUE = Symbol('omit-submitted-value');

type BoundedJsonValue =
  | string
  | number
  | boolean
  | null
  | BoundedJsonValue[]
  | { [key: string]: BoundedJsonValue };

interface BoundedJsonTraversal {
  readonly seen: WeakSet<object>;
  readonly maxNodes: number;
  visitedNodes: number;
}

function toBoundedJsonValue(
  value: unknown,
  traversal: BoundedJsonTraversal,
  depth = 0,
): BoundedJsonValue | typeof OMIT_SUBMITTED_VALUE {
  if (traversal.visitedNodes >= traversal.maxNodes) {
    return OMIT_SUBMITTED_VALUE;
  }
  traversal.visitedNodes++;

  if (value === null) {
    return null;
  }
  if (typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value !== 'object' || traversal.seen.has(value)) {
    return OMIT_SUBMITTED_VALUE;
  }
  traversal.seen.add(value);

  let isArray = false;
  try {
    isArray = Array.isArray(value);
  } catch {
    return OMIT_SUBMITTED_VALUE;
  }
  if (isArray) {
    let length = 0;
    try {
      length = (value as readonly unknown[]).length;
    } catch {
      return OMIT_SUBMITTED_VALUE;
    }
    if (
      (depth >= CONTENT_TRAVERSAL_MAX_DEPTH && length > 0) ||
      length > traversal.maxNodes - traversal.visitedNodes
    ) {
      return OMIT_SUBMITTED_VALUE;
    }
    const output: BoundedJsonValue[] = [];
    for (let index = 0; index < length; index++) {
      let item: unknown;
      try {
        item = (value as readonly unknown[])[index];
      } catch {
        return OMIT_SUBMITTED_VALUE;
      }
      const serializedItem = toBoundedJsonValue(item, traversal, depth + 1);
      if (serializedItem === OMIT_SUBMITTED_VALUE) {
        if (item === undefined || typeof item === 'function' || typeof item === 'symbol') {
          output.push(null);
          continue;
        }
        return OMIT_SUBMITTED_VALUE;
      }
      output.push(serializedItem);
    }
    return output;
  }

  const boundedEntries = getBoundedOwnEnumerableEntries(
    value,
    Math.max(0, traversal.maxNodes - traversal.visitedNodes),
  );
  if (
    !boundedEntries.complete ||
    (depth >= CONTENT_TRAVERSAL_MAX_DEPTH && boundedEntries.entries.length > 0)
  ) {
    return OMIT_SUBMITTED_VALUE;
  }

  const output = Object.create(null) as { [key: string]: BoundedJsonValue };
  for (const [key, entryValue] of boundedEntries.entries) {
    const serializedEntry = toBoundedJsonValue(entryValue, traversal, depth + 1);
    if (serializedEntry === OMIT_SUBMITTED_VALUE) {
      if (
        entryValue === undefined ||
        typeof entryValue === 'function' ||
        typeof entryValue === 'symbol'
      ) {
        continue;
      }
      return OMIT_SUBMITTED_VALUE;
    }
    output[key] = serializedEntry;
  }
  return output;
}

function stringifySubmittedValue(
  value: unknown,
  budget?: VisitNestedStringsBudget,
): {
  readonly text: string;
  readonly format: TextContentFragment['format'];
} | null {
  if (typeof value === 'string') {
    return value.length === 0 ? null : { text: value, format: 'plain' };
  }
  if (value == null) {
    return null;
  }
  const traversal: BoundedJsonTraversal = {
    seen: new WeakSet<object>(),
    maxNodes: budget?.maxNodes ?? CONTENT_TRAVERSAL_MAX_NODES,
    visitedNodes: budget?.visitedNodes ?? 0,
  };
  const boundedValue = toBoundedJsonValue(value, traversal);
  if (budget != null) {
    budget.visitedNodes = traversal.visitedNodes;
  }
  if (boundedValue === OMIT_SUBMITTED_VALUE) {
    return null;
  }
  try {
    const text = JSON.stringify(boundedValue);
    return typeof text === 'string' && text.length > 0 ? { text, format: 'json' } : null;
  } catch {
    return null;
  }
}

interface SubmittedValueFragment {
  readonly text: string;
  readonly path: JsonPointer;
  readonly format: TextContentFragment['format'];
  readonly index: number;
  readonly serialized: boolean;
}

function extractSubmittedValueContent(
  value: unknown,
  path: JsonPointer,
  createFragments: (value: SubmittedValueFragment) => readonly TextContentFragment[],
  scopes: readonly ContentTraversalScope[],
  budget?: VisitNestedStringsBudget,
): readonly TextContentFragment[] {
  const serialized = stringifySubmittedValue(value, budget);
  if (serialized != null) {
    return createFragments({
      text: serialized.text,
      path,
      format: serialized.format,
      index: 0,
      serialized: true,
    });
  }
  if (value == null || value === '') {
    return [];
  }
  if (typeof value !== 'object') {
    throw new ContentTraversalLimitError([], scopes);
  }

  const fragments: TextContentFragment[] = [];
  let nestedIndex = 0;
  const complete = visitNestedStrings(
    value,
    path,
    (text, nestedPath) => {
      fragments.push(
        ...createFragments({
          text,
          path: nestedPath,
          format: 'plain',
          index: nestedIndex,
          serialized: false,
        }),
      );
      nestedIndex++;
    },
    { includeKeys: true, budget },
  );
  if (!complete) {
    throw new ContentTraversalLimitError(fragments, scopes);
  }
  return fragments;
}

function extractToolArgumentValue(
  value: unknown,
  field: ContentFieldMap['tool_argument'],
  id: string,
  path: JsonPointer,
  budget?: VisitNestedStringsBudget,
): readonly TextContentFragment[] {
  return extractSubmittedValueContent(
    value,
    path,
    ({ text, path: fragmentPath, format, index, serialized }) => [
      fragment(
        `${id}${serialized ? '' : `.nested.${index}`}`,
        fragmentPath,
        text,
        'tool_argument',
        field,
        format,
        'inspect_only',
      ),
    ],
    [{ source: 'tool_argument', fields: [field] }],
    budget,
  );
}

export function extractToolArgumentContent(
  input: ToolArgumentContentInput | null | undefined,
  budget?: VisitNestedStringsBudget,
): readonly TextContentFragment[] {
  const fragments: TextContentFragment[] = [];
  for (const field of ['name', 'arguments', 'output'] as const) {
    try {
      fragments.push(
        ...extractToolArgumentValue(
          input?.[field],
          field,
          `tool-argument.${field}`,
          `/${field}`,
          budget,
        ),
      );
    } catch (error) {
      if (error instanceof ContentTraversalLimitError) {
        prependContentTraversalFragments(error, fragments);
      }
      throw error;
    }
  }
  return fragments;
}
