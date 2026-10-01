import { hasActivePiiPatterns } from 'librechat-data-provider';
import type { FiltersConfig, MessageFilterPiiConfig } from 'librechat-data-provider';
import type { CanonicalFileInspectionUser, GetCanonicalFilesForInspection } from './files';
import type { ModelBoundContentInput } from '../middleware/modelBoundContent';
import type { StoredMessageContentInput } from './adapters/submissions';
import type { LocatorTraversalReporter } from './diagnostics';
import type { ChatSubmissionBody } from './adapters/chat';
import type { TextContentFragment } from './types';
import { hasActiveFilePolicy, resolveCanonicalFileReferences } from './files';
import { assertModelBoundContent } from '../middleware/modelBoundContent';
import { extractStoredMessageContent } from './adapters/submissions';
import { ContentFilterError } from '../middleware/contentFilter';
import { inspectContentWithTraversal } from './runtime';
import { extractChatContent } from './adapters/chat';

function assertMutationContentAllowed(
  filters: FiltersConfig | undefined,
  extract: () => Iterable<TextContentFragment>,
): void {
  if (!hasActivePiiPatterns(filters?.messages?.pii)) {
    return;
  }
  const { finding, traversalError } = inspectContentWithTraversal(extract, { filters });
  if (finding != null) {
    throw new ContentFilterError(finding);
  }
  if (traversalError != null) {
    throw traversalError;
  }
}

/** Re-inspect the exact stored-message projection produced by a mutation. */
export function assertStoredMessageMutationAllowed(
  filters: FiltersConfig | undefined,
  message: StoredMessageContentInput,
): void {
  assertMutationContentAllowed(filters, () => extractStoredMessageContent(message));
}

/** Re-inspect chat fields, including persisted quotes merged into edited user text. */
export function assertChatMutationAllowed(
  filters: FiltersConfig | undefined,
  chat: Pick<ChatSubmissionBody, 'text' | 'quotes'>,
): void {
  assertMutationContentAllowed(filters, () => extractChatContent(chat));
}

export interface StoredMessageBranchPolicyInput {
  readonly filters?: FiltersConfig;
  readonly legacyPii?: MessageFilterPiiConfig;
  readonly message: StoredMessageContentInput;
  readonly user?: CanonicalFileInspectionUser;
}

/**
 * Hydrate canonical file rows and inspect the exact branch message before it
 * can be persisted. The legacy route supplies only database and transport
 * adapters; policy projection and fail-close semantics remain typed here.
 */
export async function assertStoredMessageBranchAllowed(
  input: StoredMessageBranchPolicyInput,
  dependencies: {
    readonly getFiles: GetCanonicalFilesForInspection;
    readonly onTraversalFailure?: LocatorTraversalReporter;
  },
): Promise<void> {
  let storedMessage: StoredMessageContentInput = input.message;
  let resolvedFiles: NonNullable<ModelBoundContentInput['resolvedFiles']> = [];
  if (hasActiveFilePolicy(input.filters)) {
    const inspection = await resolveCanonicalFileReferences({
      messageCount: 1,
      onTraversalFailure: dependencies.onTraversalFailure,
      filters: input.filters,
      input: input.message,
      user: input.user,
      getFiles: dependencies.getFiles,
    });
    storedMessage = inspection.sanitizedInput;
    resolvedFiles = inspection.hydratedFiles;
  }
  assertModelBoundContent({
    onTraversalFailure: dependencies.onTraversalFailure,
    filters: input.filters,
    legacyPii: input.legacyPii,
    storedMessages: [storedMessage],
    resolvedFiles,
  });
}
