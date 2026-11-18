import { serverProductFactSchema } from 'librechat-data-provider';
import type { AgentBindingState } from '@librechat/data-schemas';
import type { ServerRequest } from '~/types';
import { createAgentBindingObserver, observeAgentSave } from './bindings';

const state = (overrides: Partial<AgentBindingState> = {}): AgentBindingState => ({
  id: 'agent-1',
  ...overrides,
});
const native = { source: 'native', groupId: 'group-1', selection: { type: 'production' } } as const;

function setup(enabled = true) {
  const productTracker = jest.fn();
  const req = { productTracking: { enabled }, productTracker } as Pick<
    ServerRequest,
    'productTracking' | 'productTracker'
  >;
  return { track: productTracker, observe: createAgentBindingObserver(req) };
}

describe('confirmed agent bindings', () => {
  it('records create links once per explicit skill ID', () => {
    const { track, observe } = setup();
    observe(undefined, state({ instructionsPrompt: native, skills: ['s1', 's1'] }));
    expect(track.mock.calls.map(([fact]) => fact)).toEqual([
      {
        name: 'librechat.prompts.linked_to_agent',
        feature: 'prompts',
        groupId: 'group-1',
        agentId: 'agent-1',
      },
      {
        name: 'librechat.skills.linked_to_agent',
        feature: 'skills',
        skillId: 's1',
        agentId: 'agent-1',
      },
    ]);
  });
  it('ignores unchanged bindings and skill ordering', () => {
    const { track, observe } = setup();
    observe(
      state({ instructionsPrompt: native, skills: ['s1', 's2'] }),
      state({ instructionsPrompt: native, skills: ['s2', 's1'] }),
    );
    expect(track).not.toHaveBeenCalled();
  });
  it.each([
    { source: 'native', groupId: 'group-1', selection: { type: 'exact', promptId: 'revision-2' } },
    { source: 'langfuse', groupId: 'group-1', selection: { type: 'exact', version: 3 } },
  ] as const)('records replacement of the prompt selection or source', (replacement) => {
    const { track, observe } = setup();
    observe(state({ instructionsPrompt: native }), state({ instructionsPrompt: replacement }));
    expect(track.mock.calls.map(([fact]) => fact.name)).toEqual([
      'librechat.prompts.unlinked_from_agent',
      'librechat.prompts.linked_to_agent',
    ]);
  });
  it('records only changed skill IDs and does not infer full-catalog links', () => {
    const { track, observe } = setup();
    observe(state({ skills: ['s1', 's2'] }), state({ skills: ['s2', 's3'] }));
    expect(track.mock.calls.map(([fact]) => [fact.name, fact.skillId])).toEqual([
      ['librechat.skills.unlinked_from_agent', 's1'],
      ['librechat.skills.linked_to_agent', 's3'],
    ]);
    track.mockClear();
    observe(undefined, state({ skills: [] }));
    expect(track).not.toHaveBeenCalled();
  });
  it('honors disabled tracking', () => {
    const { track, observe } = setup(false);
    observe(undefined, state({ instructionsPrompt: native, skills: ['s1'] }));
    expect(track).not.toHaveBeenCalled();
  });
});

describe('ordinary agent saves', () => {
  const context = { sessionId: 'd79706cc-4ddf-4cf7-b99a-333755af9be8' };
  const setupSave = (enabled = true) => ({
    productTracking: { enabled },
    productTrackingContext: context,
    productTracker: jest.fn(),
  });

  it('records each saved snapshot without comparing prior links or retaining content', async () => {
    const req = setupSave();
    const savedB = {
      ...state({ instructionsPrompt: { ...native, groupId: 'prompt-b' }, skills: ['s1', 's1'] }),
      instructions: 'private instructions',
      name: 'private agent name',
    };
    const savedC = state({
      instructionsPrompt: { ...native, groupId: 'prompt-c' },
      skills: ['s2'],
    });
    expect(await observeAgentSave(req, async () => savedB)).toBe(savedB);
    expect(await observeAgentSave(req, async () => savedC)).toBe(savedC);
    expect(req.productTracker.mock.calls).toEqual([
      [
        {
          name: 'librechat.agents.saved',
          feature: 'agents',
          agentId: 'agent-1',
          promptGroupId: 'prompt-b',
          skillIds: ['s1'],
        },
        context,
      ],
      [
        {
          name: 'librechat.agents.saved',
          feature: 'agents',
          agentId: 'agent-1',
          promptGroupId: 'prompt-c',
          skillIds: ['s2'],
        },
        context,
      ],
    ]);
    for (const [fact] of req.productTracker.mock.calls) {
      expect(serverProductFactSchema.parse(fact)).toEqual(fact);
    }
  });

  it('records empty attachments and repeated saves as saved state', async () => {
    const req = setupSave();
    const save = jest.fn(async () => state());
    await observeAgentSave(req, save);
    await observeAgentSave(req, save);
    expect(save).toHaveBeenCalledTimes(2);
    expect(req.productTracker).toHaveBeenCalledTimes(2);
    expect(req.productTracker).toHaveBeenLastCalledWith(
      {
        name: 'librechat.agents.saved',
        feature: 'agents',
        agentId: 'agent-1',
        promptGroupId: null,
        skillIds: [],
      },
      context,
    );
  });

  it('waits for persistence and records nothing for missing or failed writes', async () => {
    const req = setupSave();
    let resolve!: (value: AgentBindingState | null) => void;
    const saved = new Promise<AgentBindingState | null>((done) => {
      resolve = done;
    });
    const pending = observeAgentSave(req, () => saved);
    expect(req.productTracker).not.toHaveBeenCalled();
    resolve(null);
    expect(await pending).toBeNull();
    const error = new Error('private database failure');
    const save = jest.fn(async () => {
      throw error;
    });
    await expect(observeAgentSave(req, save)).rejects.toBe(error);
    expect(save).toHaveBeenCalledTimes(1);
    expect(req.productTracker).not.toHaveBeenCalled();
  });

  it('does not change successful saves when tracking is disabled or delivery fails', async () => {
    const saved = state();
    const disabled = setupSave(false);
    expect(await observeAgentSave(disabled, async () => saved)).toBe(saved);
    expect(disabled.productTracker).not.toHaveBeenCalled();
    const req = setupSave();
    req.productTracker.mockImplementationOnce(() => {
      throw new Error('offline');
    });
    expect(await observeAgentSave(req, async () => saved)).toBe(saved);
    req.productTracker.mockRejectedValueOnce(new Error('offline'));
    expect(await observeAgentSave(req, async () => saved)).toBe(saved);
    await new Promise<void>((resolve) => setImmediate(resolve));
  });
});
