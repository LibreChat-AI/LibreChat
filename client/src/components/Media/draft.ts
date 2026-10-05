import type { MediaDraft, PendingMedia } from './state';
import { mediaParameterContext } from './context';
import { offeringId } from './options';
import { emptyDraft } from './state';

function submittedParameterContexts(
  draft: Pick<MediaDraft, 'operation' | 'inputs' | 'parameters' | 'parameterContexts'>,
) {
  const contexts = { ...draft.parameterContexts };
  const context = mediaParameterContext(draft);
  for (const key of Object.keys(draft.parameters) as Array<keyof MediaDraft['parameters']>) {
    contexts[key] ??= context;
  }
  return contexts;
}

/** Release submitted content while retaining the user's generation preferences. */
export function clearSubmittedMediaDraft(draft: MediaDraft): MediaDraft {
  return {
    ...emptyDraft(),
    offering: draft.offering,
    operation: draft.operation,
    parameters: draft.parameters,
    parameterContexts: submittedParameterContexts(draft),
    providerTag: draft.providerTag,
    providerOptionsText: draft.providerOptionsText,
    temporary: draft.temporary,
    compare: draft.compare,
    revision: draft.revision + 1,
  };
}

/** An accepted request owns its destination settings, even if its source has since changed. */
export function submittedMediaThreadDraft(
  source: MediaDraft,
  command: Extract<PendingMedia, { kind: 'submission' }>,
): MediaDraft {
  const unchanged = source.revision === command.draftRevision;
  const { request, following } = command;
  const comparison = following
    ? {
        offering: offeringId(following.selection),
        providerTag: following.selection.providerTag,
      }
    : undefined;
  return {
    ...(unchanged ? clearSubmittedMediaDraft(source) : emptyDraft()),
    offering: offeringId(request.selection),
    operation: request.operation,
    providerTag: request.selection.providerTag,
    parameters: unchanged ? source.parameters : request.parameters,
    parameterContexts: unchanged
      ? submittedParameterContexts(source)
      : submittedParameterContexts(request),
    temporary: request.temporary,
    compare: unchanged ? source.compare : comparison,
    // Revision one denotes implicit catalog defaults; this selection was explicitly submitted.
    revision: 2,
  };
}
