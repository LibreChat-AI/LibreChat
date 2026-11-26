import { hasActivePiiFields, hasActivePiiPatterns } from 'librechat-data-provider';
import type { FiltersConfig } from 'librechat-data-provider';
import type {
  AgentContentInput,
  TextContentFragment,
  UninspectableFileBlockResponse,
  CanonicalFileInspectionFile,
  CanonicalFileInspectionUser,
  UninspectableNestedContentResponse,
} from '~/protection';
import type { ContentFilterBlockResponse } from '~/middleware/contentFilter';
import {
  inspectContent,
  extractFileContent,
  extractAgentContent,
  hasActiveFilePolicy,
  getBlockedOpaqueFileField,
  isContentTraversalProtected,
  getContentTraversalFragments,
  isContentTraversalLimitError,
  resolveCanonicalFileReferences,
  contentFilterUninspectableResponse,
} from '~/protection';
import { contentFilterBlockResponse } from '~/middleware/contentFilter';
import { reportLocatorTraversalFailure } from '~/app/metrics';

/** Body of a refused agent definition; `error` is the stable code the routes already send. */
export type AgentContentFilterBody =
  | ContentFilterBlockResponse
  | UninspectableFileBlockResponse
  | UninspectableNestedContentResponse;

/** A refused agent definition. Every refusal maps to HTTP 400 with `details` as the body. */
export interface AgentContentFilterError {
  code: AgentContentFilterBody['error'];
  details: AgentContentFilterBody;
}

export type AgentContentCheck = { ok: true } | { ok: false; error: AgentContentFilterError };

/** Tenant-scoped file lookup. The owner filter is omitted on purpose: see `checkAgentContent`. */
export type GetAgentContentFiles = (
  filter: { file_id: { $in: string[] }; tenantId?: string | null },
  sort: object,
  select: object,
) => Promise<CanonicalFileInspectionFile[] | null | undefined>;

export interface AgentContentCheckInput {
  filters?: FiltersConfig;
  user?: CanonicalFileInspectionUser;
  /** Agent definition as it will be saved, after tool-resource file pruning. */
  agentData: AgentContentInput & { avatar?: { filepath?: unknown } | null };
  getFiles: GetAgentContentFiles;
}

const ALLOWED: AgentContentCheck = { ok: true };

function refuse(details: AgentContentFilterBody): AgentContentCheck {
  return { ok: false, error: { code: details.error, details } };
}

function isFileReferenceRefusal(
  error: unknown,
): error is { statusCode: 400; body: AgentContentFilterBody } {
  const candidate = error as { statusCode?: unknown; body?: unknown } | null;
  return candidate?.statusCode === 400 && candidate.body != null;
}

/** Maps a refused agent definition to the HTTP status and body the agent routes send. */
export function agentContentFilterErrorResponse(error: AgentContentFilterError): {
  status: 400;
  body: AgentContentFilterBody;
} {
  return { status: 400, body: error.details };
}

/**
 * Inspects an agent definition, and the files it references, against the request's content
 * filters before an agent write. Refusals return `ok: false`; unexpected failures throw.
 */
export async function checkAgentContent({
  filters,
  user,
  agentData,
  getFiles,
}: AgentContentCheckInput): Promise<AgentContentCheck> {
  const definitionPolicyActive =
    hasActivePiiPatterns(filters?.agentInstructions?.pii) ||
    hasActivePiiPatterns(filters?.conversationStarters?.pii) ||
    hasActivePiiPatterns(filters?.modelParameters?.pii) ||
    hasActivePiiFields(filters?.toolArguments?.pii, ['name', 'arguments']);
  const filePolicyActive = hasActiveFilePolicy(filters);
  if (!definitionPolicyActive && !filePolicyActive) {
    return ALLOWED;
  }
  let opaqueAgentData: unknown = agentData;
  let hydratedFiles: CanonicalFileInspectionFile[] = [];
  if (filePolicyActive) {
    try {
      const fileInspection = await resolveCanonicalFileReferences({
        onTraversalFailure: reportLocatorTraversalFailure,
        filters,
        input: agentData,
        user,
        /**
         * Every caller prunes tool-resource IDs against current ownership or
         * the existing agent's already-authorized resources before reaching
         * this point. Preserve that authorization decision while hydrating the
         * canonical rows for content inspection.
         */
        getFiles: ({ file_id, tenantId }, sort, select) =>
          getFiles({ file_id, ...(tenantId != null && { tenantId }) }, sort, select),
      });
      opaqueAgentData = fileInspection.sanitizedInput;
      hydratedFiles = fileInspection.hydratedFiles;
    } catch (error) {
      if (isFileReferenceRefusal(error)) {
        return refuse(error.body);
      }
      throw error;
    }
  }
  const avatarPath = agentData?.avatar?.filepath;
  const uninspectableField = getBlockedOpaqueFileField(filters, opaqueAgentData);
  if (uninspectableField != null) {
    return refuse(contentFilterUninspectableResponse(uninspectableField));
  }
  const fileFragments: TextContentFragment[] = hydratedFiles.flatMap(extractFileContent);
  if (typeof avatarPath === 'string' && !avatarPath.toLowerCase().startsWith('data:')) {
    fileFragments.push(...extractFileContent({ filepath: avatarPath }));
  }
  let agentFragments: readonly TextContentFragment[];
  let traversalError;
  try {
    agentFragments = extractAgentContent(agentData);
  } catch (error) {
    if (!isContentTraversalLimitError(error)) {
      throw error;
    }
    agentFragments = getContentTraversalFragments(error);
    traversalError = error;
  }
  const finding = inspectContent([...agentFragments, ...fileFragments], { filters });
  if (finding != null) {
    return refuse(contentFilterBlockResponse(finding));
  }
  if (traversalError != null && isContentTraversalProtected({ error: traversalError, filters })) {
    return refuse(traversalError.body);
  }
  return ALLOWED;
}
