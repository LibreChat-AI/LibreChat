import { EModelEndpoint, isEphemeralAgentId } from 'librechat-data-provider';
import type { AgentRoutingDecisionView } from 'librechat-data-provider';
import type { ConversationMethods } from '@librechat/data-schemas';
type AgentRoutingDecision = NonNullable<
  Awaited<ReturnType<ConversationMethods['getConvoAgentRoutingDecision']>>
>;
import type { RequestHandler, Response } from 'express';
import type { ServerRequest } from '~/types/http';
import { resolveRequestTenantId } from '~/middleware/tenant';

type RoutingIdentity = Parameters<ConversationMethods['getConvoAgentRoutingDecision']>[0];
type RoutingAction =
  | { action: 'select'; agentId: string; expectedRevision: number }
  | { action: 'switch_back'; expectedRevision: number; transitionId: string }
  | { action: 'automatic'; enabled: boolean; expectedRevision: number };

export interface AgentRoutingHttpDeps {
  get: ConversationMethods['getConvoAgentRoutingDecision'];
  select: ConversationMethods['selectConvoAgentRoutingDecision'];
  setAutomatic: ConversationMethods['setConvoAutomaticHandoffs'];
  canAccess: (agentId: string, userId: string, role?: string) => Promise<boolean>;
}

export function publicAgentRoutingDecision(
  decision: AgentRoutingDecision,
): AgentRoutingDecisionView {
  return {
    agentId: decision.agentId,
    revision: decision.revision,
    automaticHandoffsEnabled: decision.automaticHandoffsEnabled,
    ...(decision.previousAgentId != null && { previousAgentId: decision.previousAgentId }),
    ...(decision.transitionId != null && { transitionId: decision.transitionId }),
  };
}

export function parseAgentRoutingAction(value: unknown): RoutingAction | null {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const input = value as Partial<RoutingAction> & { agentId?: unknown; transitionId?: unknown };
  if (!Number.isSafeInteger(input.expectedRevision) || (input.expectedRevision ?? -1) < 0) {
    return null;
  }
  if (input.action === 'select' && typeof input.agentId === 'string' && input.agentId.length > 0) {
    if (isEphemeralAgentId(input.agentId)) return null;
    return { action: 'select', agentId: input.agentId, expectedRevision: input.expectedRevision! };
  }
  if (
    input.action === 'switch_back' &&
    typeof input.transitionId === 'string' &&
    input.transitionId.length > 0
  ) {
    return {
      action: 'switch_back',
      transitionId: input.transitionId,
      expectedRevision: input.expectedRevision!,
    };
  }
  if (input.action === 'automatic' && typeof input.enabled === 'boolean') {
    return {
      action: 'automatic',
      enabled: input.enabled,
      expectedRevision: input.expectedRevision!,
    };
  }
  return null;
}

interface RoutingHttpRequest extends ServerRequest {
  body: ServerRequest['body'] & { action?: unknown; expectedRevision?: unknown };
}

function routingIdentity(request: RoutingHttpRequest): RoutingIdentity | null {
  const conversationId = (request.params as { conversationId?: unknown }).conversationId;
  const user = request.user?.id;
  if (typeof conversationId !== 'string' || !conversationId || !user) return null;
  return { user, conversationId, tenantId: resolveRequestTenantId(request) ?? null };
}

function reply(res: Response, status: number, body: object): void {
  res.status(status).json(body);
}

export function createAgentRoutingReadHandler(
  deps: Pick<AgentRoutingHttpDeps, 'get'>,
): RequestHandler {
  return async (req, res) => {
    const identity = routingIdentity(req as RoutingHttpRequest);
    if (identity == null) return reply(res, 400, { code: 'AGENT_ROUTING_INVALID_REQUEST' });
    try {
      const current = await deps.get(identity);
      if (current == null) return reply(res, 404, { code: 'AGENT_ROUTING_NOT_FOUND' });
      return reply(res, 200, publicAgentRoutingDecision(current));
    } catch {
      return reply(res, 503, { code: 'AGENT_ROUTING_UNAVAILABLE' });
    }
  };
}

export function createAgentRoutingUpdateHandler(deps: AgentRoutingHttpDeps): RequestHandler {
  return async (req, res) => {
    const request = req as RoutingHttpRequest;
    const identity = routingIdentity(request);
    const action = parseAgentRoutingAction(request.body);
    if (identity == null || action == null) {
      return reply(res, 400, { code: 'AGENT_ROUTING_INVALID_REQUEST' });
    }
    try {
      const current = await deps.get(identity);
      if (current == null) return reply(res, 404, { code: 'AGENT_ROUTING_NOT_FOUND' });
      if (current.revision !== action.expectedRevision) {
        return reply(res, 409, publicAgentRoutingDecision(current));
      }
      if (action.action === 'automatic') {
        if (
          action.enabled &&
          (request.config?.endpoints?.[EModelEndpoint.agents]?.conversationHandoffs?.enabled !==
            true ||
            request.config?.modelSpecs?.enforce === true)
        ) {
          return reply(res, 403, { code: 'AGENT_ROUTING_DISABLED' });
        }
        const updated = await deps.setAutomatic({ ...identity, ...action });
        if (updated == null) return reply(res, 409, { code: 'AGENT_ROUTING_CHANGED' });
        return reply(res, 200, publicAgentRoutingDecision(updated));
      }
      let target: string | undefined;
      if (action.action === 'select') {
        target = action.agentId;
      } else if (
        current.transitionId === action.transitionId &&
        current.previousAgentId != null &&
        current.previousAgentId !== current.agentId
      ) {
        target = current.previousAgentId;
      }
      if (!target) return reply(res, 409, { code: 'AGENT_ROUTING_CHANGED' });
      if (!(await deps.canAccess(target, identity.user, request.user?.role))) {
        return reply(res, 403, { code: 'AGENT_ROUTING_TARGET_UNAVAILABLE' });
      }
      const updated = await deps.select({
        ...identity,
        agentId: target,
        expectedRevision: action.expectedRevision,
      });
      if (updated == null) return reply(res, 409, { code: 'AGENT_ROUTING_CHANGED' });
      return reply(res, 200, publicAgentRoutingDecision(updated));
    } catch {
      return reply(res, 503, { code: 'AGENT_ROUTING_UNAVAILABLE' });
    }
  };
}
