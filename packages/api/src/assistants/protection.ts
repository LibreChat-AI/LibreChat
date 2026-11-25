import { hasActivePiiPatterns } from 'librechat-data-provider';
import type { FiltersConfig, MessageFilterPiiConfig } from 'librechat-data-provider';
import type {
  CanonicalFileInspectionFile,
  CanonicalFileInspectionUser,
  GetCanonicalFilesForInspection,
} from '../protection/files';
import type {
  AssistantContentInput,
  StoredMessageContentInput,
} from '../protection/adapters/submissions';
import type { ExternalChatMessage } from '../protection/adapters/messages';
import type { LocatorTraversalReporter } from '../protection/diagnostics';
import {
  hasActiveFilePolicy,
  resolveCanonicalFileReferences,
  resolveCanonicalFileReferenceUnits,
} from '../protection/files';
import { ContentTraversalLimitError } from '../protection/adapters/nested';
import { assertModelBoundContent } from '../middleware/modelBoundContent';

const PAGE_LIMIT = 100;
const MAX_THREAD_PAGES = 100;
const MAX_THREAD_USER_MESSAGES = PAGE_LIMIT * MAX_THREAD_PAGES;

interface AssistantProtectionConfig {
  readonly filters?: FiltersConfig;
  readonly messageFilter?: {
    readonly pii?: MessageFilterPiiConfig;
  };
}

interface AssistantThreadMessage extends StoredMessageContentInput {
  readonly id?: string;
  readonly file_ids?: readonly string[];
}

interface AssistantThreadMessagePage {
  readonly data?: readonly AssistantThreadMessage[];
  readonly last_id?: string;
  readonly has_more?: boolean;
  readonly hasNextPage?: () => boolean;
  readonly getNextPage?: () => Promise<AssistantThreadMessagePage | null | undefined>;
}

interface AssistantOpenAIClient {
  readonly beta: {
    readonly assistants: {
      readonly retrieve: (assistantId: string) => Promise<AssistantContentInput | null | undefined>;
    };
    readonly threads: {
      readonly messages: {
        readonly list: (
          threadId: string,
          options: {
            readonly limit: number;
            readonly order: 'asc';
            readonly after?: string;
          },
        ) => Promise<AssistantThreadMessagePage | null | undefined>;
      };
    };
  };
}

interface AssistantUserMessage extends ExternalChatMessage {
  readonly file_ids?: readonly string[];
  readonly attachments?: readonly object[];
  readonly metadata?: object;
}

interface PreflightAssistantRunContentInput {
  readonly onTraversalFailure?: LocatorTraversalReporter;
  readonly config?: AssistantProtectionConfig;
  readonly openai: AssistantOpenAIClient;
  readonly user?: CanonicalFileInspectionUser;
  readonly assistantId: string;
  readonly threadId?: string;
  readonly getFiles: GetCanonicalFilesForInspection;
}

interface PreflightAssistantUserMessageContentInput {
  readonly onTraversalFailure?: LocatorTraversalReporter;
  readonly config?: AssistantProtectionConfig;
  readonly user?: CanonicalFileInspectionUser;
  readonly message: AssistantUserMessage;
  readonly fileIds?: readonly string[];
  readonly getFiles: GetCanonicalFilesForInspection;
}

function shouldInspectAssistant(filters: FiltersConfig | undefined): boolean {
  const toolPii = filters?.toolArguments?.pii;
  const inspectToolDefinitions =
    hasActivePiiPatterns(toolPii) &&
    (toolPii?.fields == null ||
      toolPii.fields.includes('name') ||
      toolPii.fields.includes('arguments'));
  return (
    hasActivePiiPatterns(filters?.agentInstructions?.pii) ||
    inspectToolDefinitions ||
    hasActivePiiPatterns(filters?.modelParameters?.pii) ||
    hasActiveFilePolicy(filters)
  );
}

function shouldInspectThread(
  filters: FiltersConfig | undefined,
  legacyPii: MessageFilterPiiConfig | undefined,
): boolean {
  return (
    hasActivePiiPatterns(legacyPii) ||
    hasActivePiiPatterns(filters?.messages?.pii) ||
    hasActiveFilePolicy(filters)
  );
}

function normalizeUserMessage(
  message: AssistantThreadMessage,
): (AssistantThreadMessage & { readonly isCreatedByUser: true }) | null {
  if (
    message == null ||
    typeof message !== 'object' ||
    Array.isArray(message) ||
    typeof message.id !== 'string' ||
    message.id.length === 0 ||
    (message.role !== 'user' && message.role !== 'assistant') ||
    !Array.isArray(message.content)
  ) {
    throw new ContentTraversalLimitError();
  }
  if (message.role !== 'user') {
    return null;
  }
  return {
    isCreatedByUser: true,
    role: 'user',
    name: message.name,
    content: message.content,
    file_ids: message.file_ids,
    attachments: message.attachments,
  };
}

function assertThreadMessagePage(
  page: AssistantThreadMessagePage | null | undefined,
): asserts page is AssistantThreadMessagePage & {
  readonly data: readonly AssistantThreadMessage[];
} {
  if (
    page == null ||
    typeof page !== 'object' ||
    Array.isArray(page) ||
    !Array.isArray(page.data)
  ) {
    throw new ContentTraversalLimitError();
  }
  if (page.data.length > PAGE_LIMIT) {
    throw new ContentTraversalLimitError();
  }
  if (page.has_more !== undefined && typeof page.has_more !== 'boolean') {
    throw new ContentTraversalLimitError();
  }
  if (page.hasNextPage !== undefined && typeof page.hasNextPage !== 'function') {
    throw new ContentTraversalLimitError();
  }
  if (page.getNextPage !== undefined && typeof page.getNextPage !== 'function') {
    throw new ContentTraversalLimitError();
  }
  if (
    page.last_id !== undefined &&
    (typeof page.last_id !== 'string' || page.last_id.length === 0)
  ) {
    throw new ContentTraversalLimitError();
  }
  if (
    page.has_more === undefined &&
    typeof page.hasNextPage !== 'function' &&
    typeof page.getNextPage !== 'function'
  ) {
    throw new ContentTraversalLimitError();
  }
}

export async function loadThreadUserMessages(
  openai: AssistantOpenAIClient,
  threadId?: string,
): Promise<AssistantThreadMessage[]> {
  if (!threadId) {
    return [];
  }

  const userMessages: AssistantThreadMessage[] = [];
  const seenCursors = new Set<string>();
  const seenMessageIds = new Set<string>();
  let visitedPages = 0;
  let page = await openai.beta.threads.messages.list(threadId, {
    limit: PAGE_LIMIT,
    order: 'asc',
  });

  while (true) {
    assertThreadMessagePage(page);
    visitedPages++;
    if (visitedPages > MAX_THREAD_PAGES) {
      throw new ContentTraversalLimitError();
    }
    const data = page.data;
    for (const message of data) {
      const normalized = normalizeUserMessage(message);
      const messageId = message.id;
      if (typeof messageId !== 'string' || seenMessageIds.has(messageId)) {
        throw new ContentTraversalLimitError();
      }
      seenMessageIds.add(messageId);
      if (normalized == null) {
        continue;
      }
      userMessages.push(normalized);
      if (userMessages.length > MAX_THREAD_USER_MESSAGES) {
        throw new ContentTraversalLimitError();
      }
    }

    const cursor = page.last_id ?? data[data.length - 1]?.id;
    const lastMessageId = data[data.length - 1]?.id;
    if (
      typeof page.last_id === 'string' &&
      typeof lastMessageId === 'string' &&
      page.last_id !== lastMessageId
    ) {
      throw new ContentTraversalLimitError();
    }
    if (
      visitedPages > 1 &&
      (typeof cursor !== 'string' || cursor.length === 0 || seenCursors.has(cursor))
    ) {
      throw new ContentTraversalLimitError();
    }
    if (typeof page.hasNextPage === 'function') {
      let hasNextPage: boolean;
      try {
        hasNextPage = page.hasNextPage();
      } catch {
        throw new ContentTraversalLimitError();
      }
      if (
        typeof hasNextPage !== 'boolean' ||
        (page.has_more !== undefined && page.has_more !== hasNextPage)
      ) {
        throw new ContentTraversalLimitError();
      }
      if (!hasNextPage) {
        break;
      }
      if (visitedPages >= MAX_THREAD_PAGES || typeof page.getNextPage !== 'function') {
        throw new ContentTraversalLimitError();
      }
      if (typeof cursor !== 'string' || cursor.length === 0 || seenCursors.has(cursor)) {
        throw new ContentTraversalLimitError();
      }
      seenCursors.add(cursor);
      page = await page.getNextPage();
      if (page == null) {
        throw new ContentTraversalLimitError();
      }
      continue;
    }

    if (typeof page.getNextPage === 'function' || typeof page.has_more !== 'boolean') {
      throw new ContentTraversalLimitError();
    }
    if (page.has_more !== true) {
      break;
    }
    if (visitedPages >= MAX_THREAD_PAGES) {
      throw new ContentTraversalLimitError();
    }
    if (typeof cursor !== 'string' || cursor.length === 0 || seenCursors.has(cursor)) {
      throw new ContentTraversalLimitError();
    }
    seenCursors.add(cursor);
    page = await openai.beta.threads.messages.list(threadId, {
      limit: PAGE_LIMIT,
      order: 'asc',
      after: cursor,
    });
  }

  return userMessages;
}

/**
 * Re-applies current policy to remote Assistants state that can become
 * model-bound without appearing in the current chat request.
 */
export async function preflightAssistantRunContent({
  config,
  openai,
  user,
  assistantId,
  threadId,
  getFiles,
  onTraversalFailure,
}: PreflightAssistantRunContentInput): Promise<AssistantContentInput | undefined> {
  const filters = config?.filters;
  const legacyPii = config?.messageFilter?.pii;
  const inspectAssistant = shouldInspectAssistant(filters);
  const inspectThread = shouldInspectThread(filters, legacyPii) && threadId != null;

  if (!inspectAssistant && !inspectThread) {
    return undefined;
  }

  const [assistant, storedMessages] = await Promise.all([
    inspectAssistant ? openai.beta.assistants.retrieve(assistantId) : Promise.resolve(undefined),
    inspectThread ? loadThreadUserMessages(openai, threadId) : Promise.resolve([]),
  ]);

  if (
    inspectAssistant &&
    (assistant == null || typeof assistant !== 'object' || Array.isArray(assistant))
  ) {
    throw new ContentTraversalLimitError();
  }

  let content = {
    assistant: assistant ?? undefined,
    storedMessages,
  };
  let resolvedFiles: CanonicalFileInspectionFile[] = [];
  if (hasActiveFilePolicy(filters)) {
    const units = [
      { assistant: content.assistant, storedMessages: [] as typeof storedMessages },
      ...storedMessages.map((message) => ({ assistant: undefined, storedMessages: [message] })),
    ];
    const fileInspection = await resolveCanonicalFileReferenceUnits({
      messageCount: storedMessages.length,
      onTraversalFailure,
      filters,
      input: units,
      user,
      getFiles,
    });
    content = {
      assistant: fileInspection.sanitizedInput[0]?.assistant,
      storedMessages: fileInspection.sanitizedInput.flatMap((unit) => unit.storedMessages),
    };
    resolvedFiles = fileInspection.hydratedFiles;
  }

  assertModelBoundContent({
    onTraversalFailure,
    filters,
    legacyPii,
    assistants: content.assistant == null ? undefined : [content.assistant],
    storedMessages: content.storedMessages,
    resolvedFiles,
  });

  return assistant ?? undefined;
}

/**
 * Re-inspects the exact user message after persisted conversation file
 * references have been attached and owner-resolved.
 */
export async function preflightAssistantUserMessageContent({
  config,
  user,
  message,
  fileIds,
  getFiles,
  onTraversalFailure,
}: PreflightAssistantUserMessageContentInput): Promise<void> {
  const filters = config?.filters;
  if (!hasActiveFilePolicy(filters)) {
    return;
  }

  const inspectionMessage =
    fileIds == null || fileIds.length === 0
      ? message
      : {
          ...message,
          file_ids: [...new Set([...(message.file_ids ?? []), ...fileIds])],
        };
  const fileInspection = await resolveCanonicalFileReferences({
    messageCount: 1,
    onTraversalFailure,
    filters,
    input: inspectionMessage,
    user,
    getFiles,
  });

  assertModelBoundContent({
    onTraversalFailure,
    filters,
    legacyPii: config?.messageFilter?.pii,
    submittedMessages: [fileInspection.sanitizedInput],
    resolvedFiles: fileInspection.hydratedFiles,
  });
}
