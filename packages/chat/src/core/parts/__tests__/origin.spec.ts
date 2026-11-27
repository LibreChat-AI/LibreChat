import type { TMessage } from 'librechat-data-provider';
import { parseEventOrigin } from '../origin';

type Row = Pick<TMessage, 'isCreatedByUser' | 'isUserSubmitted' | 'trigger'>;

const detail = {
  repo: 'acme/widgets',
  number: 17,
  actor: 'octocat',
  url: 'https://github.com/acme/widgets/pull/17#pullrequestreview-1',
  title: 'Add the widget',
  text: 'Looks good to me.',
};

function row(overrides: Partial<Row> = {}, kind = 'subscription'): Row {
  return {
    isCreatedByUser: true,
    trigger: {
      event: {
        type: 'github.pull_request_review.submitted',
        occurredAt: '2025-11-24T16:00:00.000Z',
      },
      subject: { kind, id: 'sub_1' },
      detail,
    },
    ...overrides,
  };
}

describe('parseEventOrigin', () => {
  it('reads the event, the pull request, the link and the account', () => {
    expect(parseEventOrigin(row())).toEqual({
      type: 'github.pull_request_review.submitted',
      repo: 'acme/widgets',
      number: 17,
      actor: 'octocat',
      url: 'https://github.com/acme/widgets/pull/17#pullrequestreview-1',
    });
  });

  it('carries none of the text the event authors wrote', () => {
    const origin = parseEventOrigin(row());
    expect(JSON.stringify(origin)).not.toContain('Add the widget');
    expect(JSON.stringify(origin)).not.toContain('Looks good');
  });

  it('links only a plain web address', () => {
    const unsafe = row({
      trigger: { ...row().trigger!, detail: { ...detail, url: 'javascript:alert(1)' } },
    });
    expect(parseEventOrigin(unsafe)).not.toHaveProperty('url');
  });

  it('is null for a message an event subscription did not start', () => {
    expect(parseEventOrigin(undefined)).toBeNull();
    expect(parseEventOrigin(row({ isCreatedByUser: false }))).toBeNull();
    expect(parseEventOrigin(row({ isUserSubmitted: true }))).toBeNull();
    expect(parseEventOrigin(row({}, 'schedule'))).toBeNull();
    expect(parseEventOrigin(row({ trigger: { ...row().trigger!, detail: undefined } }))).toBeNull();
    expect(parseEventOrigin({ isCreatedByUser: true })).toBeNull();
  });
});
