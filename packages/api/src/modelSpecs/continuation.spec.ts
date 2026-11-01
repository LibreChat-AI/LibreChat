import { EModelEndpoint } from 'librechat-data-provider';
import type { TModelSpec } from 'librechat-data-provider';
import { restoreAgentTriggerModelSpec } from './continuation';

const spec: TModelSpec = {
  name: 'saved-agent',
  label: 'Saved Agent',
  preset: { endpoint: EModelEndpoint.agents, agent_id: 'agent-1' },
};

function request() {
  return {
    _isAgentTrigger: true,
    user: { id: 'user-1', tenantId: 'tenant-1' },
    config: { modelSpecs: { enforce: true, list: [spec] } },
    body: {
      endpoint: EModelEndpoint.agents,
      agent_id: 'agent-1',
      conversationId: 'conversation-1',
    } as Record<string, unknown>,
    resolvedConversation: {
      user: 'user-1',
      tenantId: 'tenant-1',
      conversationId: 'conversation-1',
      agent_id: 'agent-1',
      spec: 'saved-agent',
    },
  };
}

function scheduleRequest() {
  const req = request();
  delete req.body.conversationId;
  req.body.newConversationId = 'new-conversation';
  req.body.agentTrigger = {
    version: 1,
    event: {
      type: 'schedule.occurrence',
      occurredAt: 1_000,
      source: { type: 'schedule', id: 'schedule-1' },
    },
  };
  return req;
}

describe('trusted continuation model specs', () => {
  it.each(['agent-queued-turn', 'subagent-completion', 'background-tool-completion'])(
    'restores the owned conversation spec for %s without using event metadata',
    (source) => {
      const req = request();
      req.body.agentContinuationAdmission = { source, spec: 'forged-spec' };
      req.body.agentCompletion = { version: 1, sourceId: source, spec: 'forged-spec' };
      restoreAgentTriggerModelSpec(req);
      expect(req.body.spec).toBe('saved-agent');
    },
  );

  it('selects the unique saved-agent spec for a new scheduled conversation', () => {
    const req = scheduleRequest();
    restoreAgentTriggerModelSpec(req);
    expect(req.body.spec).toBe('saved-agent');
  });

  it.each([request, scheduleRequest])(
    'does not trust a forged trigger body or transport marker',
    (make) => {
      const req = make();
      req._isAgentTrigger = false;
      req.body._isAgentTrigger = true;
      req.body['x-lc-agent-trigger'] = '1';
      restoreAgentTriggerModelSpec(req);
      expect(req.body).not.toHaveProperty('spec');
    },
  );

  it.each(['user', 'tenantId', 'conversationId', 'agent_id', 'spec'] as const)(
    'does not restore a mismatched conversation %s',
    (field) => {
      const req = request();
      req.resolvedConversation[field] = 'different';
      restoreAgentTriggerModelSpec(req);
      expect(req.body).not.toHaveProperty('spec');
    },
  );

  it.each(['explicit-spec', '', 123])(
    'preserves an explicitly submitted spec %s for validation',
    (value) => {
      const req = request();
      req.body.spec = value;
      restoreAgentTriggerModelSpec(req);
      expect(req.body.spec).toBe(value);
    },
  );

  it.each(['agent_id', 'endpoint'] as const)(
    'does not switch the authorized %s through a changed preset',
    (field) => {
      const req = request();
      req.config.modelSpecs.list = [{ ...spec, preset: { ...spec.preset, [field]: 'different' } }];
      restoreAgentTriggerModelSpec(req);
      expect(req.body).not.toHaveProperty('spec');
    },
  );

  it('fails closed when several schedule specs name the same agent', () => {
    const req = scheduleRequest();
    req.config.modelSpecs.list.push({ ...spec, name: 'other-preset' });
    restoreAgentTriggerModelSpec(req);
    expect(req.body).not.toHaveProperty('spec');
  });

  it('fails closed when the guard has no resolved conversation', () => {
    const { resolvedConversation: _conversation, ...req } = request();
    restoreAgentTriggerModelSpec(req);
    expect(req.body).not.toHaveProperty('spec');
  });

  it('does not infer a new conversation spec from unsigned schedule metadata', () => {
    const req = request();
    delete req.body.conversationId;
    restoreAgentTriggerModelSpec(req);
    expect(req.body).not.toHaveProperty('spec');
  });

  it.each(['api', 'webhook', 'queue', 'custom'])(
    'restores a signed source-neutral %s fire',
    (source) => {
      const req = scheduleRequest();
      req.body.agentTrigger = { version: 1, event: { source: { type: source } } };
      restoreAgentTriggerModelSpec(req);
      expect(req.body.spec).toBe('saved-agent');
    },
  );

  it.each(['unsigned', 'ambiguous', 'invalid', 'retargeted'])(
    'refuses a source-neutral fire that is %s',
    (failure) => {
      const req = scheduleRequest();
      req.body.agentTrigger = { version: 1, event: { source: { type: 'webhook' } } };
      if (failure === 'unsigned') req._isAgentTrigger = false;
      if (failure === 'ambiguous') req.config.modelSpecs.list.push({ ...spec, name: 'other' });
      if (failure === 'invalid') req.body.spec = 'invalid';
      if (failure === 'retargeted') req.body.agent_id = 'other-agent';
      restoreAgentTriggerModelSpec(req);
      expect(req.body.spec).toBe(failure === 'invalid' ? 'invalid' : undefined);
    },
  );

  function bindingRequest() {
    const req = request();
    const { spec: _spec, ...conversation } = req.resolvedConversation;
    return {
      ...req,
      _agentEventBindingId: 'binding-1',
      resolvedConversation: { ...conversation, agentEventBinding: { bindingId: 'binding-1' } },
    };
  }

  it('restores only a guard-authorized spec-less binding target', () => {
    const req = bindingRequest();
    restoreAgentTriggerModelSpec(req);
    expect(req.body.spec).toBe('saved-agent');
  });

  it.each(['user', 'tenantId', 'conversationId', 'agent_id'] as const)(
    'refuses a binding with a mismatched %s',
    (field) => {
      const req = bindingRequest();
      req.resolvedConversation[field] = 'different';
      restoreAgentTriggerModelSpec(req);
      expect(req.body).not.toHaveProperty('spec');
    },
  );

  it.each(['unverified', 'unsigned', 'ambiguous', 'explicit', 'ordinary'])(
    'does not widen fallback for an %s binding request',
    (failure) => {
      const req = bindingRequest();
      if (failure === 'unverified') req._agentEventBindingId = 'different';
      if (failure === 'unsigned') req._isAgentTrigger = false;
      if (failure === 'ambiguous') req.config.modelSpecs.list.push({ ...spec, name: 'other' });
      if (failure === 'explicit') req.body.spec = 'invalid';
      if (failure === 'ordinary') {
        req._agentEventBindingId = '';
        req.body._agentEventBindingId = 'binding-1';
      }
      restoreAgentTriggerModelSpec(req);
      expect(req.body.spec).toBe(failure === 'explicit' ? 'invalid' : undefined);
    },
  );

  it.each(['removed', 'retargeted'])(
    'never reselects an ordinary conversation’s %s spec',
    (failure) => {
      const req = request();
      if (failure === 'removed') req.resolvedConversation.spec = 'removed';
      else
        req.config.modelSpecs.list = [
          { ...spec, preset: { ...spec.preset, agent_id: 'other-agent' } },
        ];
      req.config.modelSpecs.list.push({ ...spec, name: 'replacement' });
      restoreAgentTriggerModelSpec(req);
      expect(req.body).not.toHaveProperty('spec');
    },
  );

  it('leaves non-enforced requests unchanged', () => {
    const req = request();
    req.config.modelSpecs.enforce = false;
    restoreAgentTriggerModelSpec(req);
    expect(req.body).not.toHaveProperty('spec');
  });
});
