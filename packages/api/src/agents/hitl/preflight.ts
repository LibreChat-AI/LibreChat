import type { Agents, UserSubmittedMessageFieldPath } from 'librechat-data-provider';
import type {
  AssertResumeContentAllowedInput,
  ResumeContentProtectionDependencies,
} from './protection';
import {
  assertResumeContentAllowed,
  getResumeUserSubmittedMessageFieldPaths,
  getResumeUserSubmittedPaths,
  mergeUserSubmittedMessageFieldPaths,
  mergeUserSubmittedPaths,
} from './protection';
import { attachAskUserQuestionAnswer } from './resume';

interface ResumePreflightBody {
  readonly answer?: string;
  readonly decisions?: readonly Agents.ToolApprovalResolution[];
}

interface ResumePreflightJobMetadata {
  readonly responseMessageId?: string;
  readonly userMessage?: Agents.UserMessageMeta;
  readonly userSubmittedPaths?: readonly string[];
  readonly userSubmittedMessageFieldPaths?: readonly UserSubmittedMessageFieldPath[];
}

export interface ResumeUserSubmittedProvenance {
  readonly userSubmittedPaths: string[];
  readonly userSubmittedMessageFieldPaths: UserSubmittedMessageFieldPath[];
}

export interface GetResumeProvenanceInput {
  readonly content: AssertResumeContentAllowedInput['seedContent'];
  readonly messageFieldContent?: AssertResumeContentAllowedInput['seedContent'];
  readonly pendingAction: Pick<Agents.PendingAction, 'payload'> | null | undefined;
  readonly body: ResumePreflightBody | null | undefined;
  readonly existingPaths?: readonly string[];
  readonly existingMessageFieldPaths?: readonly UserSubmittedMessageFieldPath[];
}

export interface PreflightResumeContentInput {
  readonly appConfig: AssertResumeContentAllowedInput['appConfig'];
  readonly endpointOption: AssertResumeContentAllowedInput['endpointOption'];
  readonly conversationId: string;
  readonly user: AssertResumeContentAllowedInput['user'];
  readonly jobMetadata: ResumePreflightJobMetadata;
  readonly pendingAction: Agents.PendingAction;
  readonly body: ResumePreflightBody;
  readonly resumeValue: AssertResumeContentAllowedInput['resumeValue'];
  readonly resumeState: Agents.ResumeState | null | undefined;
  readonly liveFiles: AssertResumeContentAllowedInput['liveFiles'];
  readonly isTemporary: boolean;
  readonly checkpointNamespace?: string;
  readonly resolvedAddedAgent: AssertResumeContentAllowedInput['resolvedAddedAgent'];
}

export interface PreflightResumeContentResult extends ResumeUserSubmittedProvenance {
  readonly seedContent: AssertResumeContentAllowedInput['seedContent'];
  readonly storedMessages: AssertResumeContentAllowedInput['storedMessages'];
}

/** Compose the exact assistant paths authored by a user across resume segments. */
export function getResumeProvenance({
  content,
  messageFieldContent = content,
  pendingAction,
  body,
  existingPaths,
  existingMessageFieldPaths,
}: GetResumeProvenanceInput): ResumeUserSubmittedProvenance {
  return {
    userSubmittedPaths: mergeUserSubmittedPaths(
      existingPaths,
      getResumeUserSubmittedPaths(content, pendingAction, body),
    ),
    userSubmittedMessageFieldPaths: mergeUserSubmittedMessageFieldPaths(
      existingMessageFieldPaths,
      getResumeUserSubmittedMessageFieldPaths(messageFieldContent, pendingAction, body),
    ),
  };
}

/**
 * Build and inspect the exact model-bound projection for a HITL continuation.
 * The legacy controller supplies lifecycle state and database adapters; all
 * content/provenance policy decisions remain in typed code here.
 */
export async function preflightResumeContent(
  {
    appConfig,
    endpointOption,
    conversationId,
    user,
    jobMetadata,
    pendingAction,
    body,
    resumeValue,
    resumeState,
    liveFiles,
    isTemporary,
    checkpointNamespace = '',
    resolvedAddedAgent,
  }: PreflightResumeContentInput,
  dependencies: ResumeContentProtectionDependencies,
): Promise<PreflightResumeContentResult> {
  const initialSeedContent: AssertResumeContentAllowedInput['seedContent'] =
    resumeState?.aggregatedContent ?? [];
  const seedContent =
    pendingAction.payload.type === 'ask_user_question' && typeof body.answer === 'string'
      ? attachAskUserQuestionAnswer(
          [...initialSeedContent],
          pendingAction.payload.question,
          body.answer,
          pendingAction.payload.tool_call_id,
        )
      : initialSeedContent;
  const provenance = getResumeProvenance({
    content: seedContent,
    messageFieldContent: initialSeedContent,
    pendingAction,
    body,
    existingPaths: jobMetadata.userSubmittedPaths,
    existingMessageFieldPaths: jobMetadata.userSubmittedMessageFieldPaths,
  });
  const userMessage = jobMetadata.userMessage;
  const storedMessages: AssertResumeContentAllowedInput['storedMessages'] = userMessage
    ? [
        {
          ...userMessage,
          isCreatedByUser: true,
          role: 'user',
          files: liveFiles,
        },
        {
          messageId: jobMetadata.responseMessageId ?? `${userMessage.messageId}_`,
          parentMessageId: userMessage.messageId,
          isCreatedByUser: false,
          role: 'assistant',
          content: seedContent,
          ...provenance,
        },
      ]
    : [];

  await assertResumeContentAllowed(
    {
      appConfig,
      endpointOption,
      conversationId,
      targetMessageId: userMessage?.messageId,
      user,
      storedMessages,
      seedContent,
      resumeValue,
      liveFiles,
      isTemporary,
      checkpointNamespace,
      resolvedAddedAgent,
    },
    dependencies,
  );

  return { seedContent, storedMessages, ...provenance };
}
