import type { AgentTriggerDeliveryMethods, MessageMethods } from '@librechat/data-schemas';
import { claimBackgroundToolResult } from './backgroundClaims';

describe('manual background receipt arbitration', () => {
  const input = {
    userId: 'user',
    conversationId: 'conversation',
    taskId: 'task',
    kind: 'manual' as const,
    claimId: 'poll',
  };
  const receipt = { kind: 'wakeup' as const, claimId: 'delivery', claimedAt: new Date() };
  function fixture() {
    const methods = {
      claimBackgroundToolResults: jest
        .fn<
          ReturnType<MessageMethods['claimBackgroundToolResults']>,
          Parameters<MessageMethods['claimBackgroundToolResults']>
        >()
        .mockResolvedValue({
          status: 'acquired',
          messageId: 'recovered-parent',
          results: [
            {
              taskId: 'task',
              toolCallId: 'call',
              toolName: 'tool',
              status: 'completed',
              output: 'done',
            },
          ],
        }),
      releaseBackgroundToolResultClaims: jest.fn(async () => true),
    };
    const lookup = jest
      .fn<
        ReturnType<AgentTriggerDeliveryMethods['getAgentBackgroundToolResultClaim']>,
        Parameters<AgentTriggerDeliveryMethods['getAgentBackgroundToolResultClaim']>
      >()
      .mockResolvedValue(null);
    return { methods, lookup };
  }
  it('uses the recovered parent identity when the process-local registry is gone', async () => {
    const { methods, lookup } = fixture();
    lookup.mockResolvedValue(receipt);
    await expect(claimBackgroundToolResult(methods, lookup, input)).resolves.toEqual({
      status: 'claimed',
      claim: receipt,
      messageId: 'recovered-parent',
    });
    expect(lookup).toHaveBeenCalledWith(
      expect.objectContaining({ parentMessageId: 'recovered-parent' }),
    );
    expect(methods.releaseBackgroundToolResultClaims).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: 'recovered-parent', taskIds: ['task'] }),
    );
  });
  it('releases a speculative message claim if receipt lookup fails', async () => {
    const { methods, lookup } = fixture();
    lookup.mockRejectedValue(new Error('database unavailable'));
    await expect(claimBackgroundToolResult(methods, lookup, input)).rejects.toThrow(
      'database unavailable',
    );
    expect(methods.releaseBackgroundToolResultClaims).toHaveBeenCalledTimes(1);
  });
  it('does not report arbitration as complete if rollback fails', async () => {
    const { methods, lookup } = fixture();
    lookup.mockResolvedValue(receipt);
    methods.releaseBackgroundToolResultClaims.mockResolvedValue(false);
    await expect(claimBackgroundToolResult(methods, lookup, input)).rejects.toThrow(
      'could not be released',
    );
  });
  it('does not claim the projection when its known receipt already has an owner', async () => {
    const { methods, lookup } = fixture();
    lookup.mockResolvedValue(receipt);
    await expect(
      claimBackgroundToolResult(methods, lookup, { ...input, messageId: 'parent' }),
    ).resolves.toMatchObject({ status: 'claimed', messageId: 'parent' });
    expect(methods.claimBackgroundToolResults).not.toHaveBeenCalled();
  });
});
