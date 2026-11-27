import type { TMessage, TSubmission } from 'librechat-data-provider';
import { createHost, createScheduler } from '../__fixtures__/resumable';
import { ResumableRun, startGeneration } from '../resumable';

const submission = {
  userMessage: { messageId: 'u-1', conversationId: 'c-1', isCreatedByUser: true, text: 'Hi' },
  initialResponse: { messageId: 'u-1_', conversationId: 'c-1' } as TMessage,
  conversation: { conversationId: 'c-1', endpoint: 'agents' },
  endpointOption: { endpoint: 'agents' },
} as unknown as TSubmission;

const httpError = (status: number, data: unknown) =>
  Object.assign(new Error('failed'), { response: { status, data, headers: {} } });

const setup = () => {
  const host = createHost();
  const run = new ResumableRun(createScheduler().scheduler);
  return { host, run };
};

describe('startGeneration', () => {
  it('resolves to the stream a start names', async () => {
    const { host, run } = setup();
    (host.start as jest.Mock).mockResolvedValue({
      streamId: 's-1',
      generationCreatedAt: 1000,
      generationProtocolVersion: 2,
    });
    await expect(startGeneration(run, host, submission)).resolves.toEqual({
      status: 'stream',
      streamId: 's-1',
      resumed: false,
      generationCreatedAt: 1000,
      generationProtocolVersion: 2,
    });
    expect(host.events.clearStepMaps).toHaveBeenCalled();
  });

  it('reports a settled v2 start', async () => {
    const { host, run } = setup();
    (host.start as jest.Mock).mockResolvedValue({
      status: 'settled',
      conversationId: 'c-1',
      generationProtocolVersion: 2,
    });
    await expect(startGeneration(run, host, submission)).resolves.toEqual({
      status: 'settled',
      conversationId: 'c-1',
      generationProtocolVersion: 2,
    });
  });

  it('restores the queued turn when the predecessor fence was lost', async () => {
    const { host, run } = setup();
    (host.start as jest.Mock).mockRejectedValue(
      httpError(409, {
        status: 'predecessor_mismatch',
        code: 'GENERATION_PREDECESSOR_MISMATCH',
        streamId: 'c-1',
        conversationId: 'c-1',
        generationCreatedAt: 3000,
        active: true,
      }),
    );
    await expect(startGeneration(run, host, submission)).resolves.toMatchObject({
      status: 'predecessor_mismatch',
      generationCreatedAt: 3000,
    });
    expect(host.steers.restoreQueued).toHaveBeenCalledWith(submission);
  });

  it('writes the error card and idles the pane on a rejected start', async () => {
    const { host, run } = setup();
    const body = { message: 'forbidden' };
    (host.start as jest.Mock).mockRejectedValue(httpError(403, body));
    await expect(startGeneration(run, host, submission)).resolves.toBeNull();
    expect(host.steers.restoreQueued).toHaveBeenCalledWith(submission);
    expect(host.events.showStartFailure).toHaveBeenCalledWith(submission, body);
    expect(host.pane.setIsSubmitting).toHaveBeenCalledWith(false);
    expect(host.pane.setSubmission).toHaveBeenCalledWith(null);
  });

  it('blocks a recovery the server refused', async () => {
    const { host, run } = setup();
    (host.start as jest.Mock).mockRejectedValue(
      httpError(400, { code: 'RECOVERY_PAYLOAD_MISMATCH' }),
    );
    await startGeneration(run, host, { ...submission, recoverySteerId: 'steer-1' } as TSubmission);
    expect(host.steers.blockRecovery).toHaveBeenCalledWith('c-1', 'steer-1');
  });

  it('refuses a recovery the user already dealt with', async () => {
    const { host, run } = setup();
    (host.steers.isRecoveryHeld as jest.Mock).mockReturnValue(true);
    const recovery = { ...submission, recoverySteerId: 'steer-1' } as TSubmission;
    await expect(startGeneration(run, host, recovery)).resolves.toBeNull();
    expect(host.start).not.toHaveBeenCalled();
    expect(host.events.showStartFailure).toHaveBeenCalledWith(recovery, undefined, 'recovery_held');
  });

  it('stops quietly once the pane abandons the start', async () => {
    const { host, run } = setup();
    const controller = new AbortController();
    (host.start as jest.Mock).mockImplementation(async () => {
      controller.abort();
      throw Object.assign(new Error('offline'), { code: 'ERR_NETWORK' });
    });
    await expect(startGeneration(run, host, submission, controller.signal)).resolves.toBeNull();
    expect(host.events.showStartFailure).not.toHaveBeenCalled();
  });
});
