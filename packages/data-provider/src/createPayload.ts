import type * as t from './types';
import { EndpointURLs } from './config';
import * as s from './schemas';

/** Resolves the browser's IANA timezone so the server can localize prompt variables. */
function getUserTimezone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}

export default function createPayload(submission: t.TSubmission) {
  const {
    isEdited,
    addedConvo,
    userMessage,
    isContinued,
    isTemporary,
    isRegenerate,
    compact,
    conversation,
    editedContent,
    ephemeralAgent,
    endpointOption,
    manualSkills,
    codeApprovalMode,
    codeEnvironmentMode,
    codeWorkspaces,
    clientRequestId,
    recoverySteerId,
    expectedPredecessorCreatedAt,
  } = submission;
  const { conversationId } = s.tConvoUpdateSchema.parse(conversation);
  const { endpoint: _e, endpointType } = endpointOption as {
    endpoint: s.EModelEndpoint;
    endpointType?: s.EModelEndpoint;
  };

  const endpoint = _e as s.EModelEndpoint;
  /** Custom endpoint names are user-defined and may contain `/`, which would
   * otherwise split into extra path segments and miss the `/:endpoint` route. */
  let server = `${EndpointURLs[s.EModelEndpoint.agents]}/${encodeURIComponent(endpoint)}`;
  if (s.isAssistantsEndpoint(endpoint)) {
    server =
      EndpointURLs[(endpointType ?? endpoint) as 'assistants' | 'azureAssistants'] +
      (isEdited ? '/modify' : '');
  }

  const payload: t.TPayload = {
    ...userMessage,
    ...endpointOption,
    endpoint,
    addedConvo,
    isTemporary,
    /** A compaction borrows the regenerate shape client-side only: the server
     *  must see it as a compaction, never as a regenerated user turn. */
    isRegenerate: compact === true ? undefined : isRegenerate,
    ...(compact === true && { compact: true }),
    editedContent,
    conversationId,
    isContinued: !!(isEdited && isContinued),
    ephemeralAgent: s.isAssistantsEndpoint(endpoint) ? undefined : ephemeralAgent,
    manualSkills: s.isAssistantsEndpoint(endpoint) ? undefined : manualSkills,
    codeApprovalMode: s.isAssistantsEndpoint(endpoint) ? undefined : codeApprovalMode,
    codeEnvironmentMode: s.isAssistantsEndpoint(endpoint) ? undefined : codeEnvironmentMode,
    codeWorkspaces: s.isAssistantsEndpoint(endpoint) ? undefined : codeWorkspaces,
    timezone: getUserTimezone(),
    clientRequestId,
    recoverySteerId,
    expectedPredecessorCreatedAt,
  };

  return { server, payload };
}
