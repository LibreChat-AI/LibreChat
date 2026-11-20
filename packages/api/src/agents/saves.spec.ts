import { serverProductFactSchema } from 'librechat-data-provider';
import type { AgentSnapshot } from './saves';
import { observeAgentSave, trackAgentDeleted } from './saves';

const state = (overrides: Partial<AgentSnapshot> = {}): AgentSnapshot => ({
  id: 'agent-1',
  ...overrides,
});
const native = { source: 'native', groupId: 'group-1', selection: { type: 'production' } } as const;

describe('agent saves', () => {
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
    let resolve!: (value: AgentSnapshot | null) => void;
    const saved = new Promise<AgentSnapshot | null>((done) => {
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

  it('records a deleted agent by ID', () => {
    const req = setupSave();
    trackAgentDeleted(req, 'agent-1');
    expect(req.productTracker.mock.calls).toEqual([
      [{ name: 'librechat.agents.deleted', feature: 'agents', agentId: 'agent-1' }, context],
    ]);
    expect(serverProductFactSchema.parse(req.productTracker.mock.calls[0][0])).toBeTruthy();
  });
});
