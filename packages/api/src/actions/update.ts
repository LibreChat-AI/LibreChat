import { Constants, actionDelimiter, actionDomainSeparator } from 'librechat-data-provider';
import type { ActionMetadata } from 'librechat-data-provider';
import type { ActionToolLike } from './tools';
import { mergeActionMetadataForUpdate } from './credentials';
import { mergeAgentActionTools } from './tools';

export const ACTION_CREDENTIAL_REFRESH_MESSAGE =
  'Action credentials must be re-entered when changing the domain, OpenAPI server URL, or authentication settings';

type StoredActionForUpdate = {
  metadata?: ActionMetadata | null;
};

export type PlanAgentActionUpdateParams = {
  agentActions: string[];
  agentTools: string[];
  incomingFunctions: ActionToolLike[];
  incomingMetadata: ActionMetadata;
  actionId: string;
  requestedActionId?: string;
  encodedDomain: string;
  legacyDomain?: string;
  previousLegacyDomain?: string;
  storedAction?: StoredActionForUpdate | null;
};

export type PlannedAgentActionUpdate = {
  actionId: string;
  metadata: ActionMetadata;
  actions: string[];
  tools: string[];
  targetChanged: boolean;
  requiresCredentialRefresh: boolean;
  deleteOAuthTokens: boolean;
};

export type ActionOAuthTokenDeleteQuery = {
  type: 'oauth' | 'oauth_refresh';
  identifier: RegExp;
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getUpdatedAgentActionRefs({
  agentActions,
  actionId,
  requestedActionId,
  encodedDomain,
}: Pick<
  PlanAgentActionUpdateParams,
  'agentActions' | 'actionId' | 'requestedActionId' | 'encodedDomain'
>): {
  actions: string[];
  previousEncodedDomain?: string;
} {
  const actions: string[] = [];
  let previousEncodedDomain: string | undefined;

  for (const action of agentActions) {
    const [actionDomain, currentActionId] = action.split(actionDelimiter);
    if (
      (requestedActionId && currentActionId === requestedActionId) ||
      currentActionId === actionId
    ) {
      previousEncodedDomain = actionDomain;
      continue;
    }

    actions.push(action);
  }

  actions.push(`${encodedDomain}${actionDelimiter}${actionId}`);

  return {
    actions,
    previousEncodedDomain,
  };
}

export function legacyActionDomainEncode(domain?: string): string {
  if (!domain) {
    return '';
  }

  if (domain.length <= Constants.ENCODED_DOMAIN_LENGTH) {
    return domain.replace(/\./g, actionDomainSeparator);
  }

  const modifiedDomain = Buffer.from(domain).toString('base64');
  return modifiedDomain.substring(0, Constants.ENCODED_DOMAIN_LENGTH);
}

export function buildActionOAuthTokenDeleteQueries(
  actionId: string,
): ActionOAuthTokenDeleteQuery[] {
  const escapedActionId = escapeRegExp(actionId);

  return [
    {
      type: 'oauth',
      identifier: new RegExp(`^[^:]+:${escapedActionId}$`),
    },
    {
      type: 'oauth_refresh',
      identifier: new RegExp(`^[^:]+:${escapedActionId}:refresh$`),
    },
  ];
}

export function planAgentActionUpdate({
  agentActions,
  agentTools,
  incomingFunctions,
  incomingMetadata,
  actionId,
  requestedActionId,
  encodedDomain,
  legacyDomain,
  previousLegacyDomain,
  storedAction,
}: PlanAgentActionUpdateParams): PlannedAgentActionUpdate {
  const metadataUpdate = storedAction
    ? mergeActionMetadataForUpdate({
        storedMetadata: storedAction.metadata ?? {},
        incomingMetadata,
      })
    : {
        metadata: incomingMetadata,
        targetChanged: false,
        requiresCredentialRefresh: false,
      };

  const { actions, previousEncodedDomain } = getUpdatedAgentActionRefs({
    agentActions,
    actionId,
    requestedActionId,
    encodedDomain,
  });

  const tools = mergeAgentActionTools({
    existingTools: agentTools,
    incomingFunctions,
    encodedDomain,
    actionId,
    requestedActionId,
    legacyDomain,
    previousEncodedDomain,
    previousLegacyDomain,
    previousRawSpec: storedAction?.metadata?.raw_spec,
  });

  return {
    actionId,
    actions,
    tools,
    metadata: metadataUpdate.metadata,
    targetChanged: metadataUpdate.targetChanged,
    requiresCredentialRefresh: metadataUpdate.requiresCredentialRefresh,
    deleteOAuthTokens: Boolean(metadataUpdate.targetChanged && requestedActionId),
  };
}
