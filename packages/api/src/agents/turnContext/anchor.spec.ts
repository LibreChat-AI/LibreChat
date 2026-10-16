import { applyTurnContextToRuntime, getConversationAgents } from './anchor';

describe('getConversationAgents', () => {
  it('is empty without a plan and holds the primary and the other agents with one', () => {
    const primary = { id: 'a' };
    const other = { id: 'b' };
    expect(getConversationAgents(null, primary, [other]).size).toBe(0);
    expect([...getConversationAgents({}, primary, [other])]).toEqual([primary, other]);
  });
});

describe('applyTurnContextToRuntime', () => {
  it('renders the agent and records the memory and retrieved texts', () => {
    const agent: { instructions: string; additional_instructions?: string } = {
      instructions: 'Base',
    };
    const memories = new Set<string>();
    const files = new Set<string>();
    applyTurnContextToRuntime(
      agent as never,
      { block: 'Anchored.', memoryTexts: ['m1'], ragTexts: ['r1'] },
      { memories, files },
    );
    expect(agent.additional_instructions).toContain('Anchored.');
    expect([...memories]).toEqual(['m1']);
    expect([...files]).toEqual(['r1']);
  });
});
