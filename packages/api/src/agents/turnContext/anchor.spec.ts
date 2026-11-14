import { ContextPartKeys, contributeContext, listContextParts } from '../systemParts';
import { applyTurnMemoryToAgent } from './anchor';

describe('applyTurnMemoryToAgent', () => {
  it('replaces the live per-turn memory of a handoff target with the anchored memory block', () => {
    const agent: { instructions: string; additional_instructions?: string } = {
      instructions: 'Base',
    };
    contributeContext(agent, ContextPartKeys.memory, 'Live memory.');
    expect(listContextParts(agent).find(({ key }) => key === 'memory')?.kind).toBe('turn');

    contributeContext(agent, ContextPartKeys.memory, undefined);
    applyTurnMemoryToAgent(agent, { memoryBlock: 'Anchored memory.' });

    expect(agent.additional_instructions).toBe('Anchored memory.');
    expect(listContextParts(agent).filter(({ kind }) => kind === 'turn')).toEqual([
      expect.objectContaining({ key: 'memory', text: '' }),
    ]);
    expect(listContextParts(agent).find(({ key }) => key === 'conversation')).toMatchObject({
      kind: 'conversation',
      text: 'Anchored memory.',
    });
  });
});
