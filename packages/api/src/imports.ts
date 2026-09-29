import { HITL_MESSAGE_FILTER_FIELDS } from 'librechat-data-provider';
import type {
  FiltersConfig,
  MessageFilterPiiConfig,
  UserSubmittedMessageFieldPath,
} from 'librechat-data-provider';
import type {
  CanonicalFileInspectionFile,
  CanonicalFileInspectionUser,
  GetCanonicalFilesForInspection,
} from './protection/files';
import type {
  ConversationImportContentInput,
  StoredMessageContentInput,
} from './protection/adapters/submissions';
import type { ModelBoundContentInput } from './middleware/modelBoundContent';
import type { LocatorTraversalReporter } from './protection/diagnostics';
import {
  getContentTraversalFragments,
  getContentTraversalScopes,
  isContentTraversalLimitError,
  isContentTraversalProtected,
  isNestedMessageTraversalProtected,
} from './protection/adapters/nested';
import {
  getBlockedOpaqueFileField,
  hasActiveFilePolicy,
  resolveCanonicalFileReferenceUnits,
  UninspectableFileError,
} from './protection/files';
import { assertModelBoundContent as assertModelBoundContentAtBoundary } from './middleware/modelBoundContent';
import {
  getUserSubmittedMessageFieldPathState,
  getUserSubmittedPathState,
} from './protection/provenance';
import { createConfiguredContentInspector, inspectContent } from './protection/runtime';
import { extractConversationImportContent } from './protection/adapters/submissions';
import { ContentFilterError } from './middleware/contentFilter';
import { aggregateAuditFindings } from './protection/audit';

export interface ConversationImportMessage extends StoredMessageContentInput {
  readonly isCreatedByUser?: boolean;
  readonly isUserSubmitted?: boolean;
  readonly userSubmittedPaths?: readonly string[];
  readonly userSubmittedMessageFieldPaths?: readonly UserSubmittedMessageFieldPath[];
}

export interface ConversationImportSnapshot {
  readonly conversations: ConversationImportContentInput['conversations'];
  readonly messages: readonly ConversationImportMessage[];
}

export interface ConversationImportProtectionContext {
  readonly onTraversalFailure?: LocatorTraversalReporter;
  readonly user?: CanonicalFileInspectionUser;
  readonly getFiles?: GetCanonicalFilesForInspection;
  readonly trustedLiveFiles?: readonly CanonicalFileInspectionFile[];
  readonly legacyPii?: MessageFilterPiiConfig | null;
  /** Injectable only at the legacy package boundary and in focused tests. */
  readonly assertModelBoundContent?: (input: ModelBoundContentInput) => void;
}

const getNoCanonicalFiles: GetCanonicalFilesForInspection = async () => [];
const hitlMessageFilterFieldSet = new Set<string>(HITL_MESSAGE_FILTER_FIELDS);

/**
 * Applies the active policy to the complete normalized import snapshot before
 * the legacy importer starts any writes. Canonical resolution operates on an
 * inspection copy, so a rejected preflight never mutates the pending batch.
 * Audit findings are aggregated across the snapshot so a large conversation
 * reports each finding once instead of once per matching fragment.
 */
export async function assertConversationImportContentAllowed(
  filters: FiltersConfig | null | undefined,
  snapshot: ConversationImportSnapshot,
  context: ConversationImportProtectionContext = {},
): Promise<void> {
  return aggregateAuditFindings(() => inspectConversationImportContent(filters, snapshot, context));
}

async function inspectConversationImportContent(
  filters: FiltersConfig | null | undefined,
  snapshot: ConversationImportSnapshot,
  context: ConversationImportProtectionContext,
): Promise<void> {
  const activeFilters = filters ?? undefined;
  const legacyPii = context.legacyPii ?? undefined;
  if (activeFilters == null && legacyPii == null) {
    return;
  }

  if (activeFilters != null) {
    let conversationFragments;
    let conversationTraversalError;
    try {
      conversationFragments = [
        ...extractConversationImportContent({
          conversations: snapshot.conversations,
          messages: [],
        }),
      ];
    } catch (error) {
      if (!isContentTraversalLimitError(error)) {
        throw error;
      }
      conversationFragments = getContentTraversalFragments(error);
      conversationTraversalError = error;
    }
    const conversationFinding = inspectContent(conversationFragments, {
      filters: activeFilters,
    });
    if (conversationFinding != null) {
      throw new ContentFilterError(conversationFinding);
    }
    if (
      conversationTraversalError != null &&
      isContentTraversalProtected({
        error: conversationTraversalError,
        filters: activeFilters,
      })
    ) {
      throw conversationTraversalError;
    }
  }

  /**
   * External imports mark every row `isUserSubmitted`, while native copy,
   * fork, and share snapshots retain durable whole-row/path provenance. Reuse
   * the model-bound invariant so copied model prose is not reclassified as
   * caller-authored content when policy changes.
   */
  let storedMessages = snapshot.messages;
  let resolvedFiles: CanonicalFileInspectionFile[] = [];
  if (hasActiveFilePolicy(activeFilters)) {
    const fileInspection = await resolveCanonicalFileReferenceUnits({
      messageCount: snapshot.messages.length,
      onTraversalFailure: context.onTraversalFailure,
      filters: activeFilters,
      input: snapshot.messages,
      user: context.user,
      trustedLiveFiles: context.trustedLiveFiles,
      getFiles: context.getFiles ?? getNoCanonicalFiles,
    });
    storedMessages = fileInspection.sanitizedInput;
    resolvedFiles = fileInspection.hydratedFiles;
  }

  const assertModelBoundContent =
    context.assertModelBoundContent ?? assertModelBoundContentAtBoundary;
  if (resolvedFiles.length > 0) {
    assertModelBoundContent({
      onTraversalFailure: context.onTraversalFailure,
      filters: activeFilters,
      resolvedFiles,
    });
  }

  for (const message of storedMessages) {
    try {
      assertModelBoundContent({
        onTraversalFailure: context.onTraversalFailure,
        filters: activeFilters,
        legacyPii,
        storedMessages: [message],
      });
    } catch (error) {
      if (!isContentTraversalLimitError(error)) {
        throw error;
      }

      const submittedPathState = getUserSubmittedPathState(message);
      const submittedMessageFieldState = getUserSubmittedMessageFieldPathState(message);
      const explicitPaths = submittedPathState.paths;
      const exactMessageFields = submittedMessageFieldState.entries.map((entry) => entry.field);
      const isExactMessageFieldTraversal = getContentTraversalScopes(error).some(
        (scope) =>
          scope.source === 'message' &&
          scope.fields.some((field) => hitlMessageFilterFieldSet.has(field)),
      );
      if (isExactMessageFieldTraversal) {
        throw error;
      }
      const isStrictUnattributedAssistant =
        activeFilters?.messages?.unattributedAssistantContent === 'inspect' &&
        typeof message.isUserSubmitted !== 'boolean' &&
        explicitPaths.length === 0 &&
        exactMessageFields.length === 0 &&
        (message.isCreatedByUser === false ||
          message.role === 'assistant' ||
          message.role === 'ai');
      const isWholeMessageSubmitted =
        message.isCreatedByUser === true ||
        message.isUserSubmitted === true ||
        submittedPathState.overflowed ||
        isStrictUnattributedAssistant;
      const relevantFragments = getContentTraversalFragments(error).filter(
        (fragment) =>
          isWholeMessageSubmitted ||
          fragment.source === 'tool_argument' ||
          explicitPaths.some(
            (path) => fragment.path === path || fragment.path.startsWith(`${path}/`),
          ),
      );
      const messageFinding = createConfiguredContentInspector({
        filters: activeFilters,
        legacyPii,
      })?.inspect(relevantFragments);
      if (messageFinding != null) {
        throw new ContentFilterError(messageFinding);
      }

      if (isWholeMessageSubmitted) {
        const uninspectableField = getBlockedOpaqueFileField(activeFilters, message);
        if (uninspectableField != null) {
          throw new UninspectableFileError(uninspectableField);
        }
      }

      let traversalFilters = activeFilters;
      if (!isWholeMessageSubmitted && explicitPaths.length === 0 && activeFilters != null) {
        traversalFilters = { ...activeFilters, messages: undefined };
      }
      if (
        isNestedMessageTraversalProtected({
          filters: traversalFilters,
          legacyPii: isWholeMessageSubmitted || explicitPaths.length > 0 ? legacyPii : undefined,
          roles:
            isWholeMessageSubmitted || explicitPaths.length > 0 ? ['user'] : [message.role, 'tool'],
        })
      ) {
        throw error;
      }
    }
  }
}
