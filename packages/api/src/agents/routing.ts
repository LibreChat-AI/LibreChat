import { EModelEndpoint, isEphemeralAgentId } from 'librechat-data-provider';
import type { ConversationMethods } from '@librechat/data-schemas';
import type { RequestHandler } from 'express';
import type { ServerRequest } from '~/types/http';
import { resolveRequestTenantId } from '~/middleware/tenant';

type RoutingDecision = NonNullable<
  Awaited<ReturnType<ConversationMethods['getConvoAgentRoutingDecision']>>
>;
type RoutingIdentity = Parameters<ConversationMethods['getConvoAgentRoutingDecision']>[0];

export interface ResolvedAgentRoutingConversation {
  conversationId: string;
  user?: string;
  tenantId?: string | null;
  endpoint?: string;
  agent_id?: string;
  agentRoutingRevision?: number;
  automaticHandoffsEnabled?: boolean;
  subagentThread?: unknown;
}

export interface AgentRoutingSelectionInput {
  identity: RoutingIdentity;
  requestedAgentId?: string;
  enabled: boolean;
  /** Resume, event actors, edit/regeneration, and children retain their own execution identities. */
  ordinaryUserTurn: boolean;
  modelSpecEnforced?: boolean;
  conversation?: ResolvedAgentRoutingConversation | null;
}

export type AgentRoutingSelection =
  | { status: 'passthrough' }
  | { status: 'missing' | 'conflict' }
  | { status: 'selected'; agentId: string; decision: RoutingDecision };

export async function resolveAgentRoutingSelection(
  input: AgentRoutingSelectionInput,
  read: ConversationMethods['getConvoAgentRoutingLookup'],
): Promise<AgentRoutingSelection> {
  const { identity, enabled, ordinaryUserTurn, modelSpecEnforced, conversation } = input;
  if (
    !ordinaryUserTurn ||
    modelSpecEnforced ||
    !identity.conversationId ||
    identity.conversationId === 'new' ||
    conversation === null
  ) {
    return { status: 'passthrough' };
  }

  let decision: RoutingDecision | null;
  if (conversation != null) {
    if (
      conversation.conversationId !== identity.conversationId ||
      conversation.user !== identity.user
    ) {
      return { status: 'missing' };
    }
    if (identity.tenantId == null && conversation.tenantId != null) {
      // The ordinary web chat has no trusted tenant identity. Preserve its existing
      // owner-checked route instead of promoting or guessing among tenant copies.
      return { status: 'passthrough' };
    }
    if ((conversation.tenantId ?? null) !== identity.tenantId) {
      return { status: 'missing' };
    }
    if (conversation.endpoint !== EModelEndpoint.agents || conversation.subagentThread != null) {
      return { status: 'passthrough' };
    }
    decision = {
      agentId: conversation.agent_id ?? null,
      revision: conversation.agentRoutingRevision ?? 0,
      automaticHandoffsEnabled: conversation.automaticHandoffsEnabled !== false,
    };
  } else {
    const lookup = await read(identity);
    if (lookup?.kind === 'passthrough') {
      return { status: 'passthrough' };
    }
    decision = lookup?.kind === 'eligible' ? lookup.decision : null;
  }
  if (decision == null) {
    // An access-cache hit can omit the row. Without a tenant scope, the
    // routing lookup cannot distinguish a tenant-stamped row from no row;
    // let existing owner/agent guards handle it without authorizing a switch.
    return identity.tenantId == null ? { status: 'passthrough' } : { status: 'missing' };
  }
  if (decision.agentId == null || isEphemeralAgentId(decision.agentId)) {
    return { status: 'passthrough' };
  }
  if (!enabled && decision.revision === 0) {
    return { status: 'passthrough' };
  }
  return { status: 'selected', agentId: decision.agentId, decision };
}

interface AgentRoutingTurnBody {
  endpoint?: string;
  isRegenerate?: boolean;
  isContinued?: boolean;
  compact?: boolean;
  editedContent?: string | null;
  overrideParentMessageId?: string | null;
  overrideConvoId?: string;
  addedConvo?: object;
}

type RoutingHttpRequest = ServerRequest & {
  body: ServerRequest['body'] & AgentRoutingTurnBody & { agent_id?: string };
  _isAgentTrigger?: boolean;
  _agentHandoffSelection?: { agentId: string; revision: number };
};

function isOrdinaryAgentRoutingTurn(
  body: AgentRoutingTurnBody | undefined,
  isAgentTrigger: boolean | undefined,
): boolean {
  return (
    body?.endpoint === EModelEndpoint.agents &&
    isAgentTrigger !== true &&
    body.isRegenerate !== true &&
    body.isContinued !== true &&
    body.compact !== true &&
    body.editedContent == null &&
    body.overrideParentMessageId == null &&
    body.overrideConvoId == null &&
    body.addedConvo == null
  );
}

/** An access marker cannot supply the current route; load the row once and reuse it downstream. */
export function shouldLoadAgentRoutingConversation(req: {
  baseUrl?: string;
  path?: string;
  body?: AgentRoutingTurnBody;
  config?: { modelSpecs?: { enforce?: boolean } };
  _isAgentTrigger?: boolean;
}): boolean {
  return (
    req.baseUrl === '/api/agents/chat' &&
    req.path !== '/resume' &&
    req.config?.modelSpecs?.enforce !== true &&
    isOrdinaryAgentRoutingTurn(req.body, req._isAgentTrigger)
  );
}

/** Runs after conversation access and before agent VIEW checks and endpoint option building. */
export function createAgentRoutingMiddleware(
  read: ConversationMethods['getConvoAgentRoutingLookup'],
): RequestHandler {
  return async (req, res, next) => {
    const request = req as RoutingHttpRequest;
    const body = request.body;
    const userId = request.user?.id;
    if (!userId || !body || request.path === '/resume') {
      next();
      return;
    }
    const ordinaryUserTurn = isOrdinaryAgentRoutingTurn(body, request._isAgentTrigger);
    const loaded = request.resolvedConversation;
    let conversation: ResolvedAgentRoutingConversation | null | undefined;
    if (loaded === null) {
      conversation = null;
    } else if (typeof loaded?.conversationId === 'string') {
      conversation = {
        conversationId: loaded.conversationId,
        user: loaded.user,
        tenantId: loaded.tenantId,
        endpoint: loaded.endpoint,
        agent_id: loaded.agent_id,
        agentRoutingRevision: loaded.agentRoutingRevision,
        automaticHandoffsEnabled: loaded.automaticHandoffsEnabled,
        subagentThread: loaded.subagentThread,
      };
    }
    try {
      const selection = await resolveAgentRoutingSelection(
        {
          identity: {
            user: userId,
            tenantId: resolveRequestTenantId(request) ?? null,
            conversationId: body.conversationId ?? '',
          },
          requestedAgentId: body.agent_id,
          enabled: request.config?.endpoints?.agents?.conversationHandoffs?.enabled === true,
          ordinaryUserTurn,
          modelSpecEnforced: request.config?.modelSpecs?.enforce === true,
          conversation,
        },
        read,
      );
      if (selection.status === 'missing' || selection.status === 'conflict') {
        res.status(selection.status === 'missing' ? 404 : 409).json({
          code:
            selection.status === 'missing'
              ? 'AGENT_ROUTING_CONVERSATION_MISSING'
              : 'AGENT_ROUTING_MODEL_SPEC_CONFLICT',
        });
        return;
      }
      if (selection.status === 'selected') {
        body.agent_id = selection.agentId;
        request._agentHandoffSelection = {
          agentId: selection.agentId,
          revision: selection.decision.revision,
        };
      }
      next();
    } catch {
      res.status(503).json({ code: 'AGENT_ROUTING_UNAVAILABLE' });
    }
  };
}
