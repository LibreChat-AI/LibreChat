import type { ComposerSubmitRoute } from '../submit';
import { submitFromComposer } from '../submit';

const route = (overrides: Partial<ComposerSubmitRoute> = {}): ComposerSubmitRoute => ({
  answerMode: { active: false, submitText: jest.fn(() => false) },
  steering: { duringRunActive: false, submitDuringRun: jest.fn(() => true) },
  submitMessage: jest.fn(),
  reset: jest.fn(),
  ...overrides,
});

describe('submitFromComposer', () => {
  it('starts an ordinary turn when nothing owns the composer', () => {
    const r = route();
    submitFromComposer(r, { text: 'hello' });
    expect(r.submitMessage).toHaveBeenCalledWith({ text: 'hello' });
    expect(r.steering.submitDuringRun).not.toHaveBeenCalled();
  });

  it('answers the paused run before any send or steer routing', () => {
    const r = route({
      answerMode: { active: true, submitText: jest.fn(() => true) },
      steering: { duringRunActive: true, submitDuringRun: jest.fn(() => true) },
    });
    submitFromComposer(r, { text: 'option b' });
    expect(r.answerMode.submitText).toHaveBeenCalledWith('option b');
    expect(r.steering.submitDuringRun).not.toHaveBeenCalled();
    expect(r.submitMessage).not.toHaveBeenCalled();
  });

  it('steers or queues instead of starting a turn while a run or a revealed follow-up is pending', () => {
    const r = route({
      steering: { duringRunActive: true, submitDuringRun: jest.fn(() => true) },
    });
    expect(submitFromComposer(r, { text: 'wait for it' })).toBeUndefined();
    expect(r.steering.submitDuringRun).toHaveBeenCalledWith('wait for it');
    expect(r.reset).toHaveBeenCalled();
    expect(r.submitMessage).not.toHaveBeenCalled();
  });

  it('keeps the text in the composer when the during-run route refuses it', () => {
    const r = route({
      steering: { duringRunActive: true, submitDuringRun: jest.fn(() => false) },
    });
    expect(submitFromComposer(r, { text: 'not now' })).toBe(false);
    expect(r.reset).not.toHaveBeenCalled();
    expect(r.submitMessage).not.toHaveBeenCalled();
  });
});
