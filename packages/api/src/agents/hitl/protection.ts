import { isMemoryAgentEnabled, isMemoryEnabled } from '@librechat/data-schemas';
import {
  Constants,
  Permissions,
  EModelEndpoint,
  PermissionTypes,
  AgentCapabilities,
  HITL_MESSAGE_FILTER_FIELDS,
  STORED_MESSAGE_FILTER_FIELDS,
  hasActivePiiFields,
  hasActivePiiPatterns,
  isActionTool,
  isEphemeralAgentId,
  openapiToFunction,
  validateAndParseOpenAPISpec,
} from 'librechat-data-provider';
import type {
  Agent,
  Action,
  Agents,
  FiltersConfig,
  TConversation,
  TEndpointOption,
  TCheckpointerConfig,
  MessageFilterPiiConfig,
  UserSubmittedMessageFieldPath,
} from 'librechat-data-provider';
import type { ToolApprovalDecisionMap, AskUserQuestionResolution } from '@librechat/agents';
import type { AppConfig, IUser } from '@librechat/data-schemas';
import type {
  AgentContentInput,
  MemoryContentInput,
  AssistantActionContentInput,
} from '~/protection/adapters/submissions';
import type {
  ResumeContentInspection,
  ResumeContentInspectionInput,
  ResumeSnapshotAgent,
} from './inspection';
import type { LocatorTraversalReporter } from '../../protection/diagnostics';
import type { TextContentFragment } from '~/protection/types';
import type { CheckAccessParams } from '~/middleware/access';
import {
  assertModelBoundContent,
  collectModelBoundHistoricalFileIdState,
  hasModelBoundContentProtection,
  type ModelBoundContentInput,
} from '~/middleware/modelBoundContent';
import {
  ContentTraversalLimitError,
  getContentTraversalFragments,
  isContentTraversalProtected,
} from '~/protection/adapters/nested';
import { getResumeAgentSnapshot, getResumeContentInspection } from './inspection';
import { extractStoredMessageContent } from '~/protection/adapters/submissions';
import { agentHasInlineMemoryTools, getMemoryAgentId } from '../memory';
import { LIBRECHAT_CHECKPOINT_NAMESPACE_KEY } from '../checkpointer';
import { AttachmentObjectNotFoundError } from '~/files/encode/utils';
import { ASK_USER_QUESTION_TOOL_NAME } from './askUserQuestionTool';
import { ContentFilterError } from '~/middleware/contentFilter';
import { applyCheckpointDelivery } from '../files/delivery';
import { hasActiveFilePolicy } from '~/protection/files';
import { parseSkillMarkdown } from '../../skills/parse';
import { inspectContent } from '~/protection/runtime';
import { isSkillPrimeMessage } from '../skills';

const GENERIC_RESUME_ERROR = 'Resume failed';

interface ResumeToolCall {
  readonly id?: string;
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

interface ResumeContentPart {
  readonly type?: string;
  readonly text?:
    | string
    | {
        readonly value?: string;
        readonly [key: string]: unknown;
      };
  readonly tool_call?: ResumeToolCall;
  readonly [key: string]: unknown;
}

interface ResumeCheckpointMessage {
  readonly role?: string;
  readonly name?: string;
  readonly text?: string;
  readonly content?: string | readonly ResumeContentPart[];
  readonly tool_calls?: readonly ResumeToolCall[];
  readonly files?: readonly object[];
  readonly attachments?: readonly object[];
  readonly file_ids?: readonly string[];
  readonly metadata?: object;
  readonly additional_kwargs?: {
    readonly skillName?: string;
    readonly sourceMessageId?: string;
    readonly sourceMessageIds?: readonly string[];
    readonly provenance?: {
      readonly parts?: readonly {
        readonly attribution?: string;
        readonly sourceMessageId?: string;
      }[];
    };
    readonly tool_calls?: readonly ResumeToolCall[];
  };
  readonly _getType?: () => string;
}

interface ResumeCheckpointer {
  getTuple(config: { configurable: Readonly<Record<string, string>> }): Promise<
    | {
        checkpoint?: {
          channel_values?: {
            messages?: readonly ResumeCheckpointMessage[];
          };
        };
      }
    | null
    | undefined
  >;
}

type ResumeAction = Action & AssistantActionContentInput;

interface ResumeEndpointOption
  extends Pick<Partial<TEndpointOption>, 'agent' | 'model_parameters'> {
  readonly addedConvo?: {
    readonly agent_id?: TConversation['agent_id'];
  };
}

type ResumeValue = ToolApprovalDecisionMap | AskUserQuestionResolution;

interface ResumeProtectionUser extends IUser {
  readonly id: IUser['id'];
  readonly role: IUser['role'];
}

interface ResumeProtectionConfig extends Omit<AppConfig, 'messageFilter'> {
  readonly messageFilter?: {
    readonly pii?: MessageFilterPiiConfig;
  };
}

const RESUME_CHECKPOINT_SKILL_FIELDS = ['name', 'instructions', 'frontmatter'] as const;
const RESUME_STORED_MESSAGE_FILTER_FIELDS = [
  ...STORED_MESSAGE_FILTER_FIELDS,
  ...HITL_MESSAGE_FILTER_FIELDS,
] as const;
const ACTION_DEFINITION_TOOL_FIELDS = ['name', 'arguments'] as const;
const ENCRYPTED_ACTION_METADATA_FIELDS = [
  'api_key',
  'oauth_client_id',
  'oauth_client_secret',
] as const;

export interface ResumeContentProtectionDependencies {
  readonly onTraversalFailure?: LocatorTraversalReporter;
  getAgentCheckpointer: (
    config: TCheckpointerConfig | undefined,
  ) => Promise<ResumeCheckpointer | undefined>;
  checkAccess: (params: CheckAccessParams) => Promise<boolean>;
  getMessages: ResumeContentInspectionInput['getMessages'];
  getFiles: ResumeContentInspectionInput['getFiles'];
  getAgent: (filter: { id: string }) => Promise<Agent | null | undefined>;
  getActions: (
    query: { agentId: string[] },
    includeSensitive: boolean,
  ) => Promise<ResumeAction[] | null | undefined>;
  getUserMemories: (params: { userId: string; agentId?: string }) => Promise<MemoryContentInput[]>;
  getRoleByName: CheckAccessParams['getRoleByName'];
  decryptMetadata: (metadata: Action['metadata']) => Promise<Action['metadata']>;
  canAccessAgent: (agent: Agent, user: ResumeProtectionUser) => Promise<boolean>;
}

export interface AssertResumeContentAllowedInput {
  readonly appConfig?: ResumeProtectionConfig;
  readonly endpointOption?: ResumeEndpointOption;
  readonly conversationId: string;
  readonly targetMessageId?: string | null;
  readonly user: ResumeProtectionUser;
  readonly storedMessages: ResumeContentInspectionInput['supplementalMessages'];
  readonly seedContent: readonly ResumeContentPart[];
  readonly resumeValue?: ResumeValue | null;
  readonly liveFiles: ResumeContentInspectionInput['liveFiles'];
  readonly isTemporary: boolean;
  readonly checkpointNamespace?: string;
  readonly resolvedAddedAgent?: Agent | null;
}

export interface AssertResumeRuntimeContentAllowedInput
  extends Pick<
    AssertResumeContentAllowedInput,
    | 'appConfig'
    | 'conversationId'
    | 'targetMessageId'
    | 'user'
    | 'storedMessages'
    | 'seedContent'
    | 'resumeValue'
    | 'liveFiles'
    | 'isTemporary'
    | 'checkpointNamespace'
  > {
  readonly agents: NonNullable<ModelBoundContentInput['agents']>;
  readonly files: NonNullable<ModelBoundContentInput['files']>;
}

export type ResumeRuntimeContentProtectionDependencies = Pick<
  ResumeContentProtectionDependencies,
  'getAgentCheckpointer' | 'getMessages' | 'getFiles' | 'onTraversalFailure'
>;

export interface ResumeRuntimeContentProjection {
  readonly resolvedFiles: ResumeContentInspection['hydratedFiles'];
  readonly checkpointFiles: ResumeContentInspection['hydratedFiles'];
}

function hasResumeHistoryProtection(appConfig: ResumeProtectionConfig | undefined): boolean {
  return (
    hasActivePiiPatterns(appConfig?.messageFilter?.pii) ||
    hasActivePiiFields(appConfig?.filters?.messages?.pii, RESUME_STORED_MESSAGE_FILTER_FIELDS) ||
    hasActivePiiPatterns(appConfig?.filters?.toolArguments?.pii) ||
    hasActiveFilePolicy(appConfig?.filters) ||
    hasActivePiiFields(appConfig?.filters?.skills?.pii, RESUME_CHECKPOINT_SKILL_FIELDS)
  );
}

function hasResumeAgentProtection(appConfig: ResumeProtectionConfig | undefined): boolean {
  return (
    hasActivePiiPatterns(appConfig?.filters?.agentInstructions?.pii) ||
    hasActivePiiPatterns(appConfig?.filters?.conversationStarters?.pii) ||
    hasActivePiiPatterns(appConfig?.filters?.modelParameters?.pii) ||
    hasActivePiiPatterns(appConfig?.filters?.actionMetadata?.pii) ||
    hasActivePiiPatterns(appConfig?.filters?.memories?.pii) ||
    hasActivePiiFields(appConfig?.filters?.toolArguments?.pii, ACTION_DEFINITION_TOOL_FIELDS)
  );
}

function hasResumeAgentDefinitionProtection(
  appConfig: ResumeProtectionConfig | undefined,
): boolean {
  return (
    hasActivePiiPatterns(appConfig?.filters?.agentInstructions?.pii) ||
    hasActivePiiPatterns(appConfig?.filters?.conversationStarters?.pii) ||
    hasActivePiiPatterns(appConfig?.filters?.modelParameters?.pii)
  );
}

export function hasResumeContentProtection(appConfig: ResumeProtectionConfig | undefined): boolean {
  return hasModelBoundContentProtection(appConfig?.filters, appConfig?.messageFilter?.pii);
}

function getCheckpointMessageRole(message: ResumeCheckpointMessage): string | undefined {
  const type = message._getType?.() ?? message.role;
  if (type === 'human') {
    return 'user';
  }
  if (type === 'ai') {
    return 'assistant';
  }
  return type;
}

function getCheckpointSkill(message: ResumeCheckpointMessage): {
  name?: string;
  body: string;
  frontmatter?: Record<string, unknown>;
} | null {
  if (!isSkillPrimeMessage(message)) {
    return null;
  }
  const content = message.content;
  let body = '';
  if (typeof content === 'string') {
    body = content;
  } else if (Array.isArray(content)) {
    body = content
      .map((part) => {
        if (typeof part === 'string') {
          return part;
        }
        return typeof part?.text === 'string' ? part.text : '';
      })
      .join('');
  }
  const frontmatter = parseSkillMarkdown(body).frontmatter;
  return {
    name: message.additional_kwargs?.skillName,
    body,
    ...(frontmatter != null && { frontmatter }),
  };
}

function normalizeCheckpointToolCalls(message: ResumeCheckpointMessage): ResumeToolCall[] {
  const calls = [
    ...(Array.isArray(message.tool_calls) ? message.tool_calls : []),
    ...(Array.isArray(message.additional_kwargs?.tool_calls)
      ? message.additional_kwargs.tool_calls
      : []),
  ];
  return calls.map((call) => ({
    name: call.name,
    arguments: call.args ?? call.arguments,
    output: call.output,
    function: call.function,
    code_interpreter: call.code_interpreter,
  }));
}

function getResumeCheckpointContent(messages: readonly ResumeCheckpointMessage[]): {
  submittedMessages: ResumeContentInspectionInput['submittedMessages'];
  skills: Array<{ name?: string; body: string; frontmatter?: Record<string, unknown> }>;
} {
  const submittedMessages: ResumeContentInspectionInput['submittedMessages'] = [];
  const skills: Array<{ name?: string; body: string; frontmatter?: Record<string, unknown> }> = [];
  for (const message of messages) {
    const skill = getCheckpointSkill(message);
    if (skill != null) {
      skills.push(skill);
      continue;
    }
    if (getCheckpointMessageRole(message) !== 'user') {
      continue;
    }
    const content = message.content ?? message.text;
    submittedMessages.push({
      ...message,
      role: 'user',
      content:
        typeof content === 'string' || content == null
          ? content
          : content.map((part) => ({
              ...part,
              ...(typeof part.text === 'object' && part.text != null
                ? { text_metadata: part.text }
                : {}),
              text: typeof part.text === 'string' ? part.text : part.text?.value,
            })),
      tool_calls: normalizeCheckpointToolCalls(message).map((call) => ({
        ...call,
        function: {
          name: typeof call.function?.name === 'string' ? call.function.name : undefined,
          arguments:
            typeof call.function?.arguments === 'string' ? call.function.arguments : undefined,
        },
      })),
    });
  }
  return { submittedMessages, skills };
}

async function getResumeCheckpointMessages(
  appConfig: ResumeProtectionConfig | undefined,
  conversationId: string,
  checkpointNamespace: string,
  dependencies: Pick<ResumeContentProtectionDependencies, 'getAgentCheckpointer'>,
): Promise<readonly ResumeCheckpointMessage[]> {
  const checkpointer = await dependencies.getAgentCheckpointer(
    appConfig?.endpoints?.[EModelEndpoint.agents]?.checkpointer,
  );
  if (!checkpointer) {
    return [];
  }
  const tuple = await checkpointer.getTuple({
    configurable: {
      thread_id: conversationId,
      checkpoint_ns: '',
      ...(checkpointNamespace !== '' && {
        [LIBRECHAT_CHECKPOINT_NAMESPACE_KEY]: checkpointNamespace,
      }),
    },
  });
  const messages = tuple?.checkpoint?.channel_values?.messages;
  return Array.isArray(messages) ? messages : [];
}

function assertResumeToolContentAllowed(
  filters: FiltersConfig | undefined,
  messages: readonly ResumeCheckpointMessage[],
  seedContent: readonly ResumeContentPart[],
  resumeValue: ResumeValue | null | undefined,
): void {
  if (
    !hasActivePiiPatterns(filters?.toolArguments?.pii) &&
    !hasActivePiiFields(filters?.messages?.pii, RESUME_STORED_MESSAGE_FILTER_FIELDS)
  ) {
    return;
  }
  const fragments: TextContentFragment[] = [];
  const traversalErrors: Array<{
    error: ContentTraversalLimitError;
    role?: string;
    includeMessageFragments: boolean;
  }> = [];
  const collectStoredMessage = (
    message: Parameters<typeof extractStoredMessageContent>[0],
    includeMessageFragments: boolean,
  ): void => {
    try {
      fragments.push(
        ...extractStoredMessageContent(message).filter(
          (fragment) =>
            fragment.source === 'tool_argument' ||
            (includeMessageFragments &&
              (fragment.source === 'message' || fragment.source === 'assembled_context')),
        ),
      );
    } catch (error) {
      if (!(error instanceof ContentTraversalLimitError)) {
        throw error;
      }
      fragments.push(
        ...getContentTraversalFragments(error).filter(
          (fragment) =>
            fragment.source === 'tool_argument' ||
            (includeMessageFragments &&
              (fragment.source === 'message' || fragment.source === 'assembled_context')),
        ),
      );
      traversalErrors.push({ error, role: message?.role, includeMessageFragments });
    }
  };
  for (const message of messages) {
    const content = message.content;
    const role = getCheckpointMessageRole(message);
    collectStoredMessage(
      {
        role,
        text: typeof content === 'string' ? content : undefined,
        content: Array.isArray(content) ? content : undefined,
        tool_calls: normalizeCheckpointToolCalls(message),
      },
      role === 'user',
    );
  }
  collectStoredMessage(
    {
      role: 'assistant',
      content: seedContent,
    },
    false,
  );
  if ('answer' in (resumeValue ?? {}) && typeof resumeValue?.answer === 'string') {
    fragments.push({
      id: 'resume.answer',
      path: '/answer',
      text: resumeValue.answer,
      source: 'message',
      field: 'answer',
      format: 'plain',
      treatment: 'inspect_only',
      provenance: 'user',
    });
    collectStoredMessage(
      {
        role: 'tool',
        content: [{ text: resumeValue.answer }],
      },
      false,
    );
  }
  for (const decision of Object.values(resumeValue ?? {})) {
    if (decision == null || typeof decision !== 'object') {
      continue;
    }
    if (decision.type === 'edit') {
      collectStoredMessage(
        {
          role: 'assistant',
          tool_calls: [{ arguments: decision.updatedInput }],
        },
        false,
      );
    } else if (decision.type === 'respond' && typeof decision.responseText === 'string') {
      fragments.push({
        id: 'resume.decision.response',
        path: '/decision/responseText',
        text: decision.responseText,
        source: 'message',
        field: 'decision_response',
        format: 'plain',
        treatment: 'inspect_only',
        provenance: 'user',
      });
      collectStoredMessage(
        {
          role: 'tool',
          content: [{ text: decision.responseText }],
        },
        false,
      );
    } else if (decision.type === 'reject' && typeof decision.reason === 'string') {
      fragments.push({
        id: 'resume.decision.reason',
        path: '/decision/reason',
        text: decision.reason,
        source: 'message',
        field: 'decision_reason',
        format: 'plain',
        treatment: 'inspect_only',
        provenance: 'user',
      });
      collectStoredMessage(
        {
          role: 'tool',
          content: [{ text: decision.reason }],
        },
        false,
      );
    }
  }
  const finding = inspectContent(fragments, {
    filters: {
      messages: filters?.messages,
      toolArguments: filters?.toolArguments,
    },
  });
  if (finding != null) {
    throw new ContentFilterError(finding);
  }
  const protectedTraversal = traversalErrors.find(({ error, role, includeMessageFragments }) =>
    isContentTraversalProtected({
      error,
      filters:
        includeMessageFragments || filters == null ? filters : { ...filters, messages: undefined },
      roles: [role],
    }),
  );
  if (protectedTraversal != null) {
    throw protectedTraversal.error;
  }
}

function projectResumeAgentDefinition(agent: ResumeSnapshotAgent): AgentContentInput {
  return {
    name: agent.name,
    category: agent.category,
    description: agent.description,
    instructions: agent.instructions,
    additional_instructions: agent.additional_instructions,
    conversation_starters: agent.conversation_starters,
    edges: agent.edges?.map((edge) => ({
      description: edge.description,
      prompt: typeof edge.prompt === 'string' ? edge.prompt : undefined,
      promptKey: edge.promptKey,
    })),
    artifacts: agent.artifacts,
    support_contact: agent.support_contact,
    toolDefinitions: agent.tools
      ?.filter((tool) => typeof tool === 'string' && isActionTool(tool))
      .map((name) => ({ name })),
    model_parameters: {
      ...(agent.model ? { model: agent.model } : {}),
      ...(agent.model_parameters ?? {}),
    },
  };
}

async function getResumeAdditionalAgentRoots(
  resolvedAddedAgent: Agent | null | undefined,
  endpointOption: ResumeEndpointOption | undefined,
  dependencies: ResumeContentProtectionDependencies,
): Promise<Agent[]> {
  if (resolvedAddedAgent) {
    return [resolvedAddedAgent];
  }
  const addedAgentId = endpointOption?.addedConvo?.agent_id;
  if (typeof addedAgentId !== 'string' || isEphemeralAgentId(addedAgentId)) {
    return [];
  }
  const addedAgent = await dependencies.getAgent({ id: addedAgentId });
  return addedAgent ? [addedAgent] : [];
}

async function getResumeMemoryAgentDefinition(
  appConfig: ResumeProtectionConfig | undefined,
  primaryAgent: ResumeSnapshotAgent,
  dependencies: ResumeContentProtectionDependencies,
): Promise<{ id: string; definition: AgentContentInput } | null> {
  if (!isMemoryAgentEnabled(appConfig?.memory)) {
    return null;
  }
  const configuredAgent = appConfig?.memory?.agent;
  if (configuredAgent != null && 'id' in configuredAgent && configuredAgent.id) {
    if (configuredAgent.id === primaryAgent.id) {
      return {
        id: primaryAgent.id,
        definition: projectResumeAgentDefinition(primaryAgent),
      };
    }
    const agent = await dependencies.getAgent({ id: configuredAgent.id });
    return agent
      ? {
          id: agent.id,
          definition: projectResumeAgentDefinition(agent),
        }
      : null;
  }
  if (
    configuredAgent != null &&
    'provider' in configuredAgent &&
    configuredAgent.provider &&
    configuredAgent.model
  ) {
    return {
      id: `${Constants.EPHEMERAL_AGENT_ID}`,
      definition: {
        instructions: configuredAgent.instructions,
        model_parameters: {
          model: configuredAgent.model,
          ...(configuredAgent.model_parameters ?? {}),
        },
      },
    };
  }
  return null;
}

async function getResumeActionSnapshots(
  filters: FiltersConfig | undefined,
  agents: readonly ResumeSnapshotAgent[],
  dependencies: ResumeContentProtectionDependencies,
): Promise<ResumeAction[]> {
  const inspectActionMetadata = hasActivePiiPatterns(filters?.actionMetadata?.pii);
  const inspectActionDefinitions = hasActivePiiFields(
    filters?.toolArguments?.pii,
    ACTION_DEFINITION_TOOL_FIELDS,
  );
  if (!inspectActionMetadata && !inspectActionDefinitions) {
    return [];
  }
  const agentIds = agents
    .filter((agent) => agent.tools?.some((tool) => typeof tool === 'string' && isActionTool(tool)))
    .map((agent) => agent.id)
    .filter((id): id is string => typeof id === 'string' && id.length > 0);
  if (agentIds.length === 0) {
    return [];
  }
  const needsEncryptedMetadata = hasActivePiiFields(
    filters?.actionMetadata?.pii,
    ENCRYPTED_ACTION_METADATA_FIELDS,
  );
  const actions =
    (await dependencies.getActions({ agentId: agentIds }, needsEncryptedMetadata)) ?? [];
  const withFunctions = actions.map((action) => {
    const rawSpec = action.metadata?.raw_spec;
    if (typeof rawSpec !== 'string') {
      return action;
    }
    const parsed = validateAndParseOpenAPISpec(rawSpec);
    if (!parsed.spec) {
      return action;
    }
    try {
      const { functionSignatures } = openapiToFunction(parsed.spec, true);
      return { ...action, functions: functionSignatures };
    } catch {
      return action;
    }
  });
  if (!needsEncryptedMetadata) {
    return withFunctions;
  }
  return Promise.all(
    withFunctions.map(async (action) => ({
      ...action,
      metadata: await dependencies.decryptMetadata(action.metadata),
    })),
  );
}

async function getResumeMemorySnapshots({
  appConfig,
  user,
  agents,
  primaryAgent,
  dependencies,
}: {
  appConfig: ResumeProtectionConfig | undefined;
  user: ResumeProtectionUser;
  agents: readonly ResumeSnapshotAgent[];
  primaryAgent: ResumeSnapshotAgent;
  dependencies: ResumeContentProtectionDependencies;
}): Promise<MemoryContentInput[]> {
  const memoryConfig = appConfig?.memory;
  if (
    !hasActivePiiPatterns(appConfig?.filters?.memories?.pii) ||
    !isMemoryEnabled(memoryConfig) ||
    user.personalization?.memories === false
  ) {
    return [];
  }
  const canReadMemory = await dependencies.checkAccess({
    user,
    permissionType: PermissionTypes.MEMORIES,
    permissions: [Permissions.USE],
    getRoleByName: dependencies.getRoleByName,
  });
  if (!canReadMemory) {
    return [];
  }

  const inlineMemoryAvailable =
    new Set(appConfig?.endpoints?.[EModelEndpoint.agents]?.capabilities).has(
      AgentCapabilities.memory,
    ) &&
    (await dependencies.checkAccess({
      user,
      permissionType: PermissionTypes.MEMORIES,
      permissions: [Permissions.USE, Permissions.CREATE, Permissions.UPDATE],
      getRoleByName: dependencies.getRoleByName,
    }));
  const automaticMemoryEnabled = isMemoryAgentEnabled(memoryConfig);
  const partitionIds = new Set([getMemoryAgentId(primaryAgent)]);
  for (const agent of agents) {
    if (
      agent.id !== primaryAgent.id &&
      (automaticMemoryEnabled || (inlineMemoryAvailable && agentHasInlineMemoryTools(agent)))
    ) {
      partitionIds.add(getMemoryAgentId(agent));
    }
  }

  const memories = await Promise.all(
    [...partitionIds].map((agentId) =>
      dependencies.getUserMemories({
        userId: `${user.id}`,
        agentId,
      }),
    ),
  );
  return memories.flat();
}

async function assertResumeAgentContentAllowed({
  appConfig,
  endpointOption,
  user,
  resolvedAddedAgent,
  dependencies,
}: Pick<
  AssertResumeContentAllowedInput,
  'appConfig' | 'endpointOption' | 'user' | 'resolvedAddedAgent'
> & {
  dependencies: ResumeContentProtectionDependencies;
}): Promise<void> {
  if (!hasResumeAgentProtection(appConfig)) {
    return;
  }
  const primaryAgent = await endpointOption?.agent;
  if (!primaryAgent) {
    throw new ContentTraversalLimitError();
  }
  const additionalRoots = await getResumeAdditionalAgentRoots(
    resolvedAddedAgent,
    endpointOption,
    dependencies,
  );
  const subagentsEnabled = new Set(appConfig?.endpoints?.[EModelEndpoint.agents]?.capabilities).has(
    AgentCapabilities.subagents,
  );
  const agents = await getResumeAgentSnapshot({
    primaryAgent,
    additionalRoots,
    primaryModelParameters: endpointOption?.model_parameters,
    subagentsEnabled,
    getAgent: async (filter) => (await dependencies.getAgent(filter)) ?? null,
    canAccessAgent: (agent) => dependencies.canAccessAgent(agent, user),
  });
  const memoryAgentDefinition = hasResumeAgentDefinitionProtection(appConfig)
    ? await getResumeMemoryAgentDefinition(appConfig, primaryAgent, dependencies)
    : null;
  const [actions, memories] = await Promise.all([
    getResumeActionSnapshots(appConfig?.filters, agents, dependencies),
    getResumeMemorySnapshots({
      appConfig,
      user,
      agents,
      primaryAgent: agents[0],
      dependencies,
    }),
  ]);
  const definitionAgents = agents.map(projectResumeAgentDefinition);
  if (
    memoryAgentDefinition != null &&
    !agents.some((agent) => agent.id === memoryAgentDefinition.id)
  ) {
    definitionAgents.push(memoryAgentDefinition.definition);
  }
  assertModelBoundContent({
    onTraversalFailure: dependencies.onTraversalFailure,
    filters: appConfig?.filters,
    legacyPii: appConfig?.messageFilter?.pii,
    agents: definitionAgents,
    actions,
    memories,
  });
}

type AssertResumeModelBoundContentAllowedInput = Pick<
  AssertResumeContentAllowedInput,
  | 'appConfig'
  | 'conversationId'
  | 'targetMessageId'
  | 'user'
  | 'storedMessages'
  | 'seedContent'
  | 'resumeValue'
  | 'liveFiles'
  | 'isTemporary'
  | 'checkpointNamespace'
> & {
  readonly trustLiveFileContent?: boolean;
  readonly checkpointMessages?: readonly ResumeCheckpointMessage[];
  readonly agents?: ModelBoundContentInput['agents'];
  readonly files?: ModelBoundContentInput['files'];
};

interface ResumeModelBoundContentProjection {
  readonly resolvedFiles: ResumeContentInspection['hydratedFiles'];
  readonly sourceMessages: ResumeContentInspection['originalStoredMessages'];
  readonly checkpointMessages: readonly ResumeCheckpointMessage[];
  readonly historyLoaded: boolean;
}

async function assertResumeModelBoundContentAllowed(
  {
    appConfig,
    conversationId,
    targetMessageId,
    user,
    storedMessages,
    seedContent,
    resumeValue,
    liveFiles,
    isTemporary,
    checkpointNamespace = '',
    trustLiveFileContent,
    checkpointMessages: providedCheckpointMessages,
    agents,
    files,
  }: AssertResumeModelBoundContentAllowedInput,
  dependencies: ResumeRuntimeContentProtectionDependencies,
): Promise<ResumeModelBoundContentProjection> {
  if (!hasResumeHistoryProtection(appConfig)) {
    assertModelBoundContent({
      onTraversalFailure: dependencies.onTraversalFailure,
      filters: appConfig?.filters,
      legacyPii: appConfig?.messageFilter?.pii,
      agents,
      files,
    });
    return {
      resolvedFiles: [],
      sourceMessages: storedMessages,
      checkpointMessages: providedCheckpointMessages ?? [],
      historyLoaded: false,
    };
  }

  let checkpointMessages: readonly ResumeCheckpointMessage[];
  try {
    checkpointMessages =
      providedCheckpointMessages ??
      (await getResumeCheckpointMessages(
        appConfig,
        conversationId,
        checkpointNamespace,
        dependencies,
      ));
  } catch {
    throw new ContentTraversalLimitError();
  }
  const checkpointContent = getResumeCheckpointContent(checkpointMessages);
  const contentInspection = await getResumeContentInspection({
    onTraversalFailure: dependencies.onTraversalFailure,
    appConfig,
    conversationId,
    targetMessageId,
    user,
    supplementalMessages: storedMessages,
    submittedMessages: checkpointContent.submittedMessages,
    fileReferenceInputs: checkpointMessages,
    liveFiles,
    ...(trustLiveFileContent === true && { trustLiveFileContent: true }),
    isTemporary,
    getMessages: dependencies.getMessages,
    getFiles: dependencies.getFiles,
  });
  assertModelBoundContent({
    onTraversalFailure: dependencies.onTraversalFailure,
    filters: appConfig?.filters,
    legacyPii: appConfig?.messageFilter?.pii,
    submittedMessages: contentInspection.submittedMessages,
    storedMessages: contentInspection.storedMessages,
    agents,
    skills: checkpointContent.skills,
    files,
    resolvedFiles: contentInspection.hydratedFiles,
  });
  assertResumeToolContentAllowed(appConfig?.filters, checkpointMessages, seedContent, resumeValue);
  return {
    resolvedFiles: contentInspection.hydratedFiles,
    sourceMessages: contentInspection.originalStoredMessages,
    checkpointMessages,
    historyLoaded: true,
  };
}

export async function assertResumeContentAllowed(
  {
    appConfig,
    endpointOption,
    conversationId,
    targetMessageId,
    user,
    storedMessages,
    seedContent,
    resumeValue,
    liveFiles,
    isTemporary,
    checkpointNamespace = '',
    resolvedAddedAgent,
  }: AssertResumeContentAllowedInput,
  dependencies: ResumeContentProtectionDependencies,
): Promise<void> {
  if (!hasResumeContentProtection(appConfig)) {
    return;
  }
  await assertResumeModelBoundContentAllowed(
    {
      appConfig,
      conversationId,
      targetMessageId,
      user,
      storedMessages,
      seedContent,
      resumeValue,
      liveFiles,
      isTemporary,
      checkpointNamespace,
    },
    dependencies,
  );
  await assertResumeAgentContentAllowed({
    appConfig,
    endpointOption,
    user,
    resolvedAddedAgent,
    dependencies,
  });
}

/**
 * Rechecks the fully initialized runtime projection immediately before a resumed run.
 * The controller-level preflight remains authoritative for approval claiming; this
 * second boundary covers hydrated attachments and dynamic tool context assembled later.
 */
export async function assertResumeRuntimeContentAllowed(
  input: AssertResumeRuntimeContentAllowedInput,
  dependencies: ResumeRuntimeContentProtectionDependencies,
): Promise<ResumeRuntimeContentProjection> {
  let checkpointMessages = hasResumeHistoryProtection(input.appConfig)
    ? await getResumeCheckpointMessages(
        input.appConfig,
        input.conversationId,
        input.checkpointNamespace ?? '',
        dependencies,
      )
    : undefined;
  const modelBoundProjection = hasResumeContentProtection(input.appConfig)
    ? await assertResumeModelBoundContentAllowed(
        {
          ...input,
          trustLiveFileContent: true,
          checkpointMessages,
        },
        dependencies,
      )
    : undefined;
  const resolvedFiles = modelBoundProjection?.resolvedFiles ?? [];
  if (modelBoundProjection?.historyLoaded === true) {
    checkpointMessages = modelBoundProjection.checkpointMessages;
  }
  checkpointMessages ??= await getResumeCheckpointMessages(
    input.appConfig,
    input.conversationId,
    input.checkpointNamespace ?? '',
    dependencies,
  );
  const checkpointSourceMessageIds = new Set(
    checkpointMessages
      .flatMap((message) => {
        const additionalKwargs = message.additional_kwargs;
        return [
          additionalKwargs?.sourceMessageId,
          ...(Array.isArray(additionalKwargs?.sourceMessageIds)
            ? additionalKwargs.sourceMessageIds
            : []),
          ...(Array.isArray(additionalKwargs?.provenance?.parts)
            ? additionalKwargs.provenance.parts
                .filter((part) => part?.attribution === 'user' || part?.attribution === 'tool')
                .map((part) => part.sourceMessageId)
            : []),
        ];
      })
      .filter(
        (messageId): messageId is string => typeof messageId === 'string' && messageId.length > 0,
      ),
  );
  let sourceMessages = (modelBoundProjection?.sourceMessages ?? input.storedMessages).filter(
    (message) => {
      const messageId = message.messageId ?? message.id;
      return messageId != null && checkpointSourceMessageIds.has(messageId);
    },
  );
  const resolvedSourceMessageIds = new Set(
    sourceMessages
      .map((message) => message.messageId ?? message.id)
      .filter((messageId): messageId is string => messageId != null),
  );
  const missingSourceMessageIds = [...checkpointSourceMessageIds].filter(
    (messageId) => !resolvedSourceMessageIds.has(messageId),
  );
  if (
    modelBoundProjection?.historyLoaded !== true &&
    !input.isTemporary &&
    missingSourceMessageIds.length > 0 &&
    input.user?.id
  ) {
    const persistedMessages =
      (await dependencies.getMessages({
        conversationId: input.conversationId,
        user: input.user.id,
      })) ?? [];
    const sourceMessagesById = new Map(
      sourceMessages.map((message) => [message.messageId ?? message.id, message]),
    );
    for (const message of persistedMessages) {
      const messageId = message.messageId ?? message.id;
      if (messageId != null && checkpointSourceMessageIds.has(messageId)) {
        sourceMessagesById.set(messageId, message);
      }
    }
    sourceMessages = [...sourceMessagesById.values()];
  }
  const availableSourceMessageIds = new Set(
    sourceMessages
      .map((message) => message.messageId ?? message.id)
      .filter((messageId): messageId is string => messageId != null),
  );
  const unresolvedSourceMessageId = [...checkpointSourceMessageIds].find(
    (messageId) => !availableSourceMessageIds.has(messageId),
  );
  if (unresolvedSourceMessageId != null) {
    throw new Error('A checkpoint source message is no longer available');
  }
  const checkpointFileInputs = [
    ...checkpointMessages.map((message) => ({
      files: message.files,
      content: message.content,
    })),
    ...sourceMessages.map((message) => ({ files: message.files, content: message.content })),
  ] as ResumeContentInspectionInput['supplementalMessages'];
  const nonSteerCheckpointFileIds = collectModelBoundHistoricalFileIdState(
    checkpointFileInputs.map((message) => ({
      files: message?.files,
      content: Array.isArray(message?.content)
        ? message.content.filter((part) => part?.type !== 'steer')
        : message?.content,
    })),
  ).fileIds;
  const checkpointSteerFileIds: string[] = [];
  for (const message of checkpointFileInputs) {
    if (!Array.isArray(message?.content)) {
      continue;
    }
    for (const part of message.content) {
      if (part?.type !== 'steer' || !Array.isArray(part.files)) {
        continue;
      }
      for (const file of part.files) {
        if (typeof file?.file_id === 'string' && file.file_id.length > 0) {
          checkpointSteerFileIds.push(file.file_id);
        }
      }
    }
  }
  const checkpointFileIdOccurrences = [...nonSteerCheckpointFileIds, ...checkpointSteerFileIds];
  const checkpointFileIds = new Set(checkpointFileIdOccurrences);
  const resolvedFilesById = new Map(
    resolvedFiles
      .filter((file) => checkpointFileIds.has(file.file_id ?? ''))
      .map((file) => [file.file_id, file]),
  );
  const missingCheckpointFileIds = [...checkpointFileIds].filter(
    (fileId) => !resolvedFilesById.has(fileId),
  );
  const missingCheckpointFileIdSet = new Set(missingCheckpointFileIds);
  if (missingCheckpointFileIds.length > 0 && input.user?.id) {
    const ownerFiles =
      (await dependencies.getFiles(
        {
          file_id: { $in: missingCheckpointFileIds },
          user: input.user.id,
          ...(input.user.tenantId != null && { tenantId: input.user.tenantId }),
        },
        {},
        {},
      )) ?? [];
    for (const file of ownerFiles) {
      if (missingCheckpointFileIdSet.has(file.file_id ?? '')) {
        resolvedFilesById.set(file.file_id, file);
      }
    }
  }
  const checkpointFiles = checkpointFileIdOccurrences
    .map((fileId) => resolvedFilesById.get(fileId))
    .filter((file): file is NonNullable<typeof file> => file != null);
  if ([...checkpointFileIds].some((fileId) => !resolvedFilesById.has(fileId))) {
    const unresolvedFileId = [...checkpointFileIds].find(
      (fileId) => !resolvedFilesById.has(fileId),
    );
    throw new AttachmentObjectNotFoundError(unresolvedFileId ?? 'unknown');
  }
  return { resolvedFiles, checkpointFiles: applyCheckpointDelivery(checkpointFiles) };
}

export function getUserFacingResumeError(
  error: { readonly message?: string } | null | undefined,
  appConfig: ResumeProtectionConfig | undefined,
): string {
  if (hasResumeContentProtection(appConfig)) {
    return GENERIC_RESUME_ERROR;
  }
  return typeof error?.message === 'string' ? error.message : GENERIC_RESUME_ERROR;
}

export const mergeUserSubmittedPaths = (
  ...pathLists: readonly (readonly (string | null | undefined)[] | null | undefined)[]
): string[] => [
  ...new Set(
    pathLists
      .flatMap((paths) => paths ?? [])
      .filter(
        (path): path is string =>
          typeof path === 'string' && path.startsWith('/') && path.length <= 2048,
      ),
  ),
];

export const mergeUserSubmittedMessageFieldPaths = (
  ...entryLists: readonly (
    | readonly (UserSubmittedMessageFieldPath | null | undefined)[]
    | null
    | undefined
  )[]
): UserSubmittedMessageFieldPath[] => {
  const entries: UserSubmittedMessageFieldPath[] = [];
  const seen = new Set<string>();
  const allowedFields = new Set<string>(HITL_MESSAGE_FILTER_FIELDS);
  for (const entry of entryLists.flatMap((values) => values ?? [])) {
    if (
      entry == null ||
      typeof entry.path !== 'string' ||
      !entry.path.startsWith('/') ||
      entry.path.length > 2048 ||
      !allowedFields.has(entry.field)
    ) {
      continue;
    }
    const key = `${entry.field}:${entry.path}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    entries.push(entry);
  }
  return entries;
};

/** Map user decisions to the exact assistant fields they mutate during resume. */
export function getResumeUserSubmittedPaths(
  content: readonly ResumeContentPart[] | null | undefined,
  pendingAction: Pick<Agents.PendingAction, 'payload'> | null | undefined,
  body: { readonly decisions?: readonly Agents.ToolApprovalResolution[] } | null | undefined,
): string[] {
  const paths: string[] = [];
  const parts = Array.isArray(content) ? content : [];
  for (let index = 0; index < parts.length; index++) {
    if (parts[index]?.type === 'steer') {
      paths.push(`/content/${index}`);
    }
  }

  const payload = pendingAction?.payload;
  if (payload?.type === 'ask_user_question') {
    return paths;
  }
  if (payload?.type !== 'tool_approval') {
    return paths;
  }

  const resolutions = new Map(
    (body?.decisions ?? []).map((decision) => [decision.tool_call_id, decision]),
  );
  for (let index = 0; index < parts.length; index++) {
    const resolution = resolutions.get(parts[index]?.tool_call?.id ?? '');
    if (resolution?.decision === 'edit') {
      paths.push(`/content/${index}/tool_call/args`);
    }
  }
  return paths;
}

/** Preserve exact request-only message fields after they are embedded in tool outputs. */
export function getResumeUserSubmittedMessageFieldPaths(
  content: readonly ResumeContentPart[] | null | undefined,
  pendingAction: Pick<Agents.PendingAction, 'payload'> | null | undefined,
  body:
    | {
        readonly answer?: string;
        readonly decisions?: readonly Agents.ToolApprovalResolution[];
      }
    | null
    | undefined,
): UserSubmittedMessageFieldPath[] {
  const parts = Array.isArray(content) ? content : [];
  const payload = pendingAction?.payload;
  if (payload?.type === 'ask_user_question' && typeof body?.answer === 'string') {
    const toolCallId = payload.tool_call_id;
    for (let index = parts.length - 1; index >= 0; index--) {
      const toolCall = parts[index]?.tool_call;
      if (toolCall?.name !== ASK_USER_QUESTION_TOOL_NAME) {
        continue;
      }
      if (typeof toolCallId === 'string' && toolCallId.length > 0) {
        if (toolCall.id === toolCallId) {
          return [{ path: `/content/${index}/tool_call/output`, field: 'answer' }];
        }
        continue;
      }
      // Provenance can be recomputed after the current answer is stamped. The
      // newest ask is still the current legacy interrupt; skipping its output
      // would incorrectly attribute the answer to an older unanswered ask.
      return [{ path: `/content/${index}/tool_call/output`, field: 'answer' }];
    }
    return [];
  }
  if (payload?.type !== 'tool_approval') {
    return [];
  }

  const resolutions = new Map(
    (body?.decisions ?? []).map((decision) => [decision.tool_call_id, decision]),
  );
  const entries: UserSubmittedMessageFieldPath[] = [];
  for (let index = 0; index < parts.length; index++) {
    const resolution = resolutions.get(parts[index]?.tool_call?.id ?? '');
    if (resolution?.decision === 'respond' && typeof resolution.responseText === 'string') {
      entries.push({
        path: `/content/${index}/tool_call/output`,
        field: 'decision_response',
      });
    } else if (resolution?.decision === 'reject' && typeof resolution.reason === 'string') {
      entries.push({
        path: `/content/${index}/tool_call/output`,
        field: 'decision_reason',
      });
    }
  }
  return entries;
}
