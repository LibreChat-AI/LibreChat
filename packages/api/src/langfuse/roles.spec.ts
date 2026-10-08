import { resolveTraceRole } from './roles';

describe('resolveTraceRole', () => {
  it('names the run, its saved agent and the wrappers around a model call', () => {
    expect(resolveTraceRole('agent', 'AgentGraph')).toEqual({ role: 'run' });
    expect(resolveTraceRole('agent', 'MultiAgentGraph')).toEqual({ role: 'run' });
    expect(resolveTraceRole('span', 'agent_ZwXQuP527oibHg8S2qNV3')).toEqual({
      role: 'agent',
      agentId: 'agent_ZwXQuP527oibHg8S2qNV3',
    });
    expect(resolveTraceRole('agent', 'agent')).toEqual({ role: 'plumbing' });
    expect(resolveTraceRole('span', 'AgentModelCall')).toEqual({ role: 'plumbing' });
    expect(resolveTraceRole('span', 'prompt')).toEqual({ role: 'plumbing' });
    expect(resolveTraceRole('span', 'tool-dispatch')).toEqual({ role: 'tools' });
  });

  it('tells the model calls that wrote activity labels from the ones that answered', () => {
    expect(resolveTraceRole('generation', 'StepLabel')).toEqual({ role: 'stepLabel' });
    expect(resolveTraceRole('generation', 'ReasoningLabel')).toEqual({ role: 'reasoningLabel' });
    expect(resolveTraceRole('generation', 'MultiStepLabelGeneration')).toEqual({
      role: 'phaseLabel',
    });
    expect(resolveTraceRole('span', 'MultiStepLabel')).toEqual({ role: 'plumbing' });
    expect(resolveTraceRole('generation', 'llm')).toEqual({ role: 'model' });
    expect(resolveTraceRole('generation', 'ChatOpenAI')).toEqual({});
    expect(resolveTraceRole('span', 'llm')).toEqual({});
  });

  it('gives no role to a name a deployment or a tool chose', () => {
    expect(resolveTraceRole('tool', 'tool-dispatch')).toEqual({});
    expect(resolveTraceRole('tool', 'agent_lookup')).toEqual({});
    expect(resolveTraceRole('generation', 'agent_ZwXQuP527oibHg8S2qNV3')).toEqual({});
    expect(resolveTraceRole('generation', 'AgentGraph')).toEqual({});
    expect(resolveTraceRole('span', 'StepLabel')).toEqual({});
    expect(resolveTraceRole('span', 'My Research Agent')).toEqual({});
  });
});
