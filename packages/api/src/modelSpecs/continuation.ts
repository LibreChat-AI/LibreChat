import { EModelEndpoint, resolveModelSpecEndpoint } from 'librechat-data-provider';
import type { TSpecsConfig } from 'librechat-data-provider';

interface AgentTriggerModelSpecRequest {
  _isAgentTrigger?: boolean;
  _agentEventBindingId?: string;
  user?: { id?: string; tenantId?: string };
  config?: { modelSpecs?: Pick<TSpecsConfig, 'enforce' | 'list'> | null };
  body?: Record<string, unknown>;
  resolvedConversation?: {
    user?: string;
    tenantId?: string;
    conversationId: string;
    agent_id?: string;
    spec?: string | null;
    agentEventBinding?: { bindingId: string };
  } | null;
}

/** Restore server-started turns without changing the agent already authorized by the route. */
export function restoreAgentTriggerModelSpec(req: AgentTriggerModelSpecRequest): void {
  const { body } = req;
  const modelSpecs = req.config?.modelSpecs;
  if (
    req._isAgentTrigger !== true ||
    body == null ||
    body.spec != null ||
    body.endpoint !== EModelEndpoint.agents ||
    !modelSpecs?.enforce ||
    !modelSpecs.list?.length ||
    typeof body.agent_id !== 'string' ||
    !req.user?.id
  ) {
    return;
  }

  const matchesAgent = (spec: NonNullable<TSpecsConfig['list']>[number]): boolean =>
    resolveModelSpecEndpoint(spec) === body.endpoint && spec.preset.agent_id === body.agent_id;

  let storedSpec: string | null | undefined;

  if (body.conversationId != null) {
    // The subagent turn guard resolves this even on the cached authorization path.
    const conversation = req.resolvedConversation;
    if (
      conversation == null ||
      conversation.conversationId !== body.conversationId ||
      conversation.user !== req.user.id ||
      (conversation.tenantId ?? undefined) !== (req.user.tenantId ?? undefined) ||
      conversation.agent_id !== body.agent_id
    ) {
      return;
    }
    storedSpec = conversation.spec;
    // Only the guard can establish this binding context after checking its owner and parent.
    if (
      storedSpec == null &&
      (!req._agentEventBindingId ||
        conversation.agentEventBinding?.bindingId !== req._agentEventBindingId)
    ) {
      return;
    }
  } else {
    const trigger = body.agentTrigger;
    if (
      trigger == null ||
      typeof trigger !== 'object' ||
      Array.isArray(trigger) ||
      !('version' in trigger) ||
      trigger.version !== 1
    ) {
      return;
    }
  }
  // A stored name fixes the choice; new turns require exactly one matching agent preset.
  let selected: NonNullable<TSpecsConfig['list']>[number] | undefined;
  for (const spec of modelSpecs.list) {
    if (storedSpec != null ? spec.name !== storedSpec : !matchesAgent(spec)) {
      continue;
    }
    if (selected != null) {
      return;
    }
    selected = spec;
  }
  if (selected == null || !selected.name || !matchesAgent(selected)) {
    return;
  }

  // Downstream resolves by name, so a collision must not select a different preset.
  let foundName = false;
  for (const spec of modelSpecs.list) {
    if (spec.name !== selected.name) {
      continue;
    }
    if (foundName) {
      return;
    }
    foundName = true;
  }
  body.spec = selected.name;
}
