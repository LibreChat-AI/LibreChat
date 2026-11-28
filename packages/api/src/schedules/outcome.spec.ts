import { ContentTypes } from 'librechat-data-provider';
import { completedOutcome } from './outcome';

const reply = [{ type: ContentTypes.TEXT, text: 'Done.' }];
const failed = [{ type: ContentTypes.ERROR, error: '{"type":"model_rate_limit"}' }];

describe('completedOutcome', () => {
  it('settles a reply with no error part as success', () => {
    expect(completedOutcome({ content: reply })).toEqual({ status: 'success' });
    expect(completedOutcome({ content: [] })).toEqual({ status: 'success' });
    expect(completedOutcome({})).toEqual({ status: 'success' });
  });

  it('settles a response that ended in an error part as an error', () => {
    expect(completedOutcome({ content: failed })).toEqual({
      status: 'error',
      error: 'Scheduled run ended with an error response',
    });
  });

  it('counts a failure that followed real work', () => {
    expect(completedOutcome({ content: [...reply, null, ...failed] }).status).toBe('error');
  });

  it('never stores the error part text', () => {
    const content = [{ type: ContentTypes.ERROR, error: 'PRIVATE provider wording' }];
    const outcome = completedOutcome({ content });
    expect(JSON.stringify(outcome)).not.toContain('PRIVATE');
  });

  it.each([
    ['stopped', { stopped: true }, 'Scheduled run was stopped'],
    ['preempted', { preempted: true }, 'Scheduled run was interrupted before completion'],
    [
      'out of steps',
      { stepLimit: true },
      'Scheduled run reached its tool call limit before completion',
    ],
  ])('keeps a run that was %s interrupted, error part or not', (_label, signal, error) => {
    expect(completedOutcome({ ...signal, content: reply })).toEqual({
      status: 'interrupted',
      error,
    });
    expect(completedOutcome({ ...signal, content: failed })).toEqual({
      status: 'interrupted',
      error,
    });
  });

  it('names the stop before the preempt and the preempt before the step limit', () => {
    expect(completedOutcome({ stopped: true, preempted: true, stepLimit: true }).error).toBe(
      'Scheduled run was stopped',
    );
    expect(completedOutcome({ preempted: true, stepLimit: true }).error).toBe(
      'Scheduled run was interrupted before completion',
    );
  });
});
