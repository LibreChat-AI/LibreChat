import type { SubagentIdentity, SubagentUpdateEvent } from 'librechat-data-provider';
import { captureSubagentIdentity } from './subagentIdentity';

const event = (overrides: Partial<SubagentUpdateEvent> = {}): SubagentUpdateEvent => ({
  runId: 'parent',
  subagentRunId: 'child',
  subagentType: 'agent-1',
  subagentKind: 'agent',
  subagentAgentId: 'agent-1',
  phase: 'start',
  timestamp: '',
  ...overrides,
});

describe('captureSubagentIdentity', () => {
  it('captures execution identity and retains it across frames with missing metadata', () => {
    const target: { subagentIdentity?: SubagentIdentity } = {};
    captureSubagentIdentity(target, event());
    const identity = target.subagentIdentity;
    expect(identity).toEqual({ subagentKind: 'agent', subagentAgentId: 'agent-1' });
    captureSubagentIdentity(target, event({ phase: 'stop', subagentKind: undefined }));
    captureSubagentIdentity(target, event());
    expect(target.subagentIdentity).toBe(identity);
  });
  it('keeps graph kind and execution subject separate from a colliding type/member ID', () => {
    const target: { subagentIdentity?: SubagentIdentity } = {};
    captureSubagentIdentity(
      target,
      event({ subagentKind: 'graph', subagentAgentId: 'graph:agent-1', memberAgentId: 'agent-1' }),
    );
    expect(target.subagentIdentity).toEqual({
      subagentKind: 'graph',
      subagentAgentId: 'graph:agent-1',
    });
  });
  it('does not invent identity from incomplete legacy events', () => {
    const target: { subagentIdentity?: SubagentIdentity } = {};
    captureSubagentIdentity(target, event({ subagentKind: undefined }));
    captureSubagentIdentity(target, event({ subagentAgentId: '' }));
    expect(target.subagentIdentity).toBeUndefined();
  });
});
