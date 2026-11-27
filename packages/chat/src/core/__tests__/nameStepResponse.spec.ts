import { Constants, StepEvents } from 'librechat-data-provider';
import type { TSubmission } from 'librechat-data-provider';
import type { StepEvent } from '../reducer';
import { nameStepResponse } from '../resumable/events';

const submission = { userMessage: { messageId: 'u1' } } as TSubmission;
const runStep = (runId: string | undefined): StepEvent =>
  ({ event: StepEvents.ON_RUN_STEP, data: { id: 's0', runId, index: 0 } }) as StepEvent;

describe('nameStepResponse', () => {
  it('tells the usage writers the reply id a run step carries', () => {
    const nameResponse = jest.fn();

    nameStepResponse({ nameResponse }, runStep('stored-reply'), submission);

    expect(nameResponse).toHaveBeenCalledWith('stored-reply', submission);
  });

  it('says nothing for a step that names no row of its own, or for any other event', () => {
    const nameResponse = jest.fn();

    nameStepResponse({ nameResponse }, runStep(undefined), submission);
    nameStepResponse(
      { nameResponse },
      runStep(Constants.USE_PRELIM_RESPONSE_MESSAGE_ID as string),
      submission,
    );
    nameStepResponse(
      { nameResponse },
      { event: StepEvents.ON_MESSAGE_DELTA, data: { id: 's0', delta: {} } } as StepEvent,
      submission,
    );

    expect(nameResponse).not.toHaveBeenCalled();
  });

  it('is harmless where no usage is kept', () => {
    expect(() => nameStepResponse(undefined, runStep('stored-reply'), submission)).not.toThrow();
    expect(() => nameStepResponse({}, runStep('stored-reply'), submission)).not.toThrow();
  });
});
