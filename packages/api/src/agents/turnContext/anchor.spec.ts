import {
  ContextPartKeys,
  assembleSystemPrompt,
  contributeContext,
  listContextParts,
} from '../systemParts';
import { applyTurnContextToRuntime, applyTurnMemoryToAgent, getConversationAgents } from './anchor';

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

  it('keeps the anchored memory out of the tail the SDK relocates when the conversation block is cached', () => {
    const agent: { instructions: string; additional_instructions?: string } = {
      instructions: 'Base',
    };
    contributeContext(agent, ContextPartKeys.memory, 'Live memory.');
    const options = { stableContext: true, conversationBlock: true };
    expect(assembleSystemPrompt(agent, options)).toMatchObject({
      conversation_instructions: '',
      additional_instructions: 'Live memory.',
    });

    contributeContext(agent, ContextPartKeys.memory, undefined);
    applyTurnMemoryToAgent(agent, { memoryBlock: 'Anchored memory.' });

    expect(assembleSystemPrompt(agent, options)).toMatchObject({
      conversation_instructions: 'Anchored memory.',
      additional_instructions: '',
    });
  });
});
