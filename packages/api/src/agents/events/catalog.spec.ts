import { AGENT_EVENT_TYPES, isAgentEventType } from 'librechat-data-provider';
import type { AgentEventType } from 'librechat-data-provider';
import type { Occurrence, Outcome } from './catalog';
import type { Payload } from './fixtures.helper';
import {
  set,
  user,
  HEAD_SHA,
  repository,
  REPOSITORY_ID,
  reviewSubmitted,
  INSTALLATION_ID,
  suitePullRequest,
  pullRequestClosed,
  issueCommentCreated,
  checkSuiteCompleted,
  reviewCommentCreated,
} from './fixtures.helper';
import { LIMITS, catalog, normalize } from './catalog';
import { itemKey } from './item';

const TOKEN = `ghp_${'a1B2'.repeat(9)}`;
const HOME = 'https://github.com/example-org/widgets';
const PAGE = `${HOME}/pull/42`;

const fixtures: Record<AgentEventType, () => Payload> = {
  'github.pull_request_review.submitted': reviewSubmitted,
  'github.pull_request_review_comment.created': reviewCommentCreated,
  'github.issue_comment.created': issueCommentCreated,
  'github.check_suite.completed': checkSuiteCompleted,
  'github.pull_request.closed': pullRequestClosed,
};

function read(type: AgentEventType, body: unknown = fixtures[type]()): Outcome {
  return normalize('github', catalog[type].event, body);
}

/** The occurrences of a delivery that must have produced some. */
function events(type: AgentEventType, body?: Payload): Occurrence[] {
  const outcome = read(type, body);
  if (!outcome.ok) {
    throw new Error(`expected events, got ${JSON.stringify(outcome.error)}`);
  }
  return outcome.value;
}

function only(type: AgentEventType, body?: Payload): Occurrence {
  const [first, ...rest] = events(type, body);
  expect(rest).toHaveLength(0);
  return first;
}

const malformed = (field: string): Outcome => ({ ok: false, error: { code: 'malformed', field } });
const ignored = (reason: 'event' | 'action' | 'item'): Outcome => ({
  ok: false,
  error: { code: 'ignored', reason },
});

const shared = {
  item: { provider: 'github', kind: 'pr', repo: REPOSITORY_ID, number: 42 },
  repo: { id: REPOSITORY_ID, name: 'example-org/widgets' },
  installation: INSTALLATION_ID,
};

describe('catalog', () => {
  it('lists every stored event type and nothing else', () => {
    expect(Object.keys(catalog).sort()).toEqual([...AGENT_EVENT_TYPES].sort());
  });

  it('names each type after its provider, event and action', () => {
    for (const type of AGENT_EVENT_TYPES) {
      const { provider, event, action } = catalog[type];
      expect(`${provider}.${event}.${action}`).toBe(type);
    }
  });

  it('keeps the stored ids it shipped with', () => {
    expect(AGENT_EVENT_TYPES).toEqual([
      'github.pull_request_review.submitted',
      'github.pull_request_review_comment.created',
      'github.issue_comment.created',
      'github.check_suite.completed',
      'github.pull_request.closed',
    ]);
  });

  it('recognises a stored id', () => {
    expect(AGENT_EVENT_TYPES.every(isAgentEventType)).toBe(true);
    expect(
      ['github.push', 'github.pull_request.opened', 'toString', '', 7, null].some(isAgentEventType),
    ).toBe(false);
  });
});

describe('normalize', () => {
  describe('each listed event', () => {
    it('reads a submitted review', () => {
      expect(read('github.pull_request_review.submitted')).toEqual({
        ok: true,
        value: [
          {
            ...shared,
            type: 'github.pull_request_review.submitted',
            actor: { id: 5002, login: 'example-reviewer', bot: false, association: 'collaborator' },
            occurredAt: Date.UTC(2026, 10, 20, 10, 31, 2),
            title: 'Add a retry to the widget loader',
            state: 'changes_requested',
            url: `${PAGE}#pullrequestreview-3100`,
            text: 'The retry count should come from config.',
            sha: HEAD_SHA,
          },
        ],
      });
    });

    it('reads a review comment', () => {
      expect(read('github.pull_request_review_comment.created')).toEqual({
        ok: true,
        value: [
          {
            ...shared,
            type: 'github.pull_request_review_comment.created',
            actor: { id: 5002, login: 'example-reviewer', bot: false, association: 'collaborator' },
            occurredAt: Date.UTC(2026, 10, 20, 10, 30, 40),
            title: 'Add a retry to the widget loader',
            url: `${PAGE}#discussion_r3200`,
            text: 'Three is a magic number here.',
            sha: HEAD_SHA,
          },
        ],
      });
    });

    it('reads a comment on a pull request', () => {
      expect(read('github.issue_comment.created')).toEqual({
        ok: true,
        value: [
          {
            ...shared,
            type: 'github.issue_comment.created',
            actor: { id: 5003, login: 'example-passerby', bot: false, association: 'none' },
            occurredAt: Date.UTC(2026, 10, 20, 11, 0, 0),
            title: 'Add a retry to the widget loader',
            url: `${PAGE}#issuecomment-3300`,
            text: 'Does this also cover the offline case?',
          },
        ],
      });
    });

    it('reads a finished check suite', () => {
      expect(read('github.check_suite.completed')).toEqual({
        ok: true,
        value: [
          {
            ...shared,
            type: 'github.check_suite.completed',
            actor: { id: 5001, login: 'example-author', bot: false },
            occurredAt: Date.UTC(2026, 10, 20, 10, 29, 10),
            state: 'failure',
            url: PAGE,
            sha: HEAD_SHA,
          },
        ],
      });
    });

    it('reads a merged pull request', () => {
      expect(read('github.pull_request.closed')).toEqual({
        ok: true,
        value: [
          {
            ...shared,
            type: 'github.pull_request.closed',
            actor: { id: 5004, login: 'example-maintainer', bot: false },
            occurredAt: Date.UTC(2026, 10, 20, 12, 0, 0),
            title: 'Add a retry to the widget loader',
            state: 'merged',
            url: PAGE,
          },
        ],
      });
    });

    it('reads a pull request closed without merging', () => {
      const body = set(pullRequestClosed(), 'pull_request.merged', false);
      expect(only('github.pull_request.closed', body).state).toBe('closed');
    });

    it.each(AGENT_EVENT_TYPES)('returns plain JSON for %s', (type) => {
      const outcome = read(type);
      expect(JSON.parse(JSON.stringify(outcome))).toEqual(outcome);
      expect(Object.values(events(type)[0])).not.toContain(undefined);
    });
  });

  describe('a delivery that is not an event', () => {
    it.each([['ping'], ['push'], ['issues'], ['check_run'], ['__proto__'], ['constructor'], ['']])(
      'ignores the unlisted event %p',
      (event) => {
        expect(normalize('github', event, reviewSubmitted())).toEqual(ignored('event'));
      },
    );

    it('ignores an unlisted event whatever its body is', () => {
      expect(normalize('github', 'ping', null)).toEqual(ignored('event'));
      expect(normalize('github', 'ping', 'zen')).toEqual(ignored('event'));
    });

    it.each<[AgentEventType, string]>([
      ['github.pull_request_review.submitted', 'dismissed'],
      ['github.pull_request_review.submitted', 'edited'],
      ['github.pull_request_review_comment.created', 'deleted'],
      ['github.issue_comment.created', 'edited'],
      ['github.check_suite.completed', 'requested'],
      ['github.pull_request.closed', 'opened'],
      ['github.pull_request.closed', 'Closed'],
      ['github.pull_request.closed', 'toString'],
    ])('ignores %s when the action is %p', (type, action) => {
      expect(read(type, set(fixtures[type](), 'action', action))).toEqual(ignored('action'));
    });

    it('reads an action only under its own event', () => {
      const body = set(reviewSubmitted(), 'action', 'completed');
      expect(read('github.pull_request_review.submitted', body)).toEqual(ignored('action'));
    });

    it('ignores a comment on a plain issue', () => {
      const body = set(issueCommentCreated(), 'issue.pull_request', undefined);
      expect(read('github.issue_comment.created', body)).toEqual(ignored('item'));
    });

    it('ignores a check suite that names no pull request, as for a branch in a fork', () => {
      const body = set(checkSuiteCompleted(), 'check_suite.pull_requests', []);
      expect(read('github.check_suite.completed', body)).toEqual(ignored('item'));
    });

    it('ignores a check suite whose pull requests all belong to another repository', () => {
      const body = set(checkSuiteCompleted(), 'check_suite.pull_requests', [
        suitePullRequest(42, 700999),
      ]);
      expect(read('github.check_suite.completed', body)).toEqual(ignored('item'));
    });
  });

  describe('a payload that cannot be read', () => {
    it.each([[null], [undefined], ['{}'], [42], [[reviewSubmitted()]]])(
      'reports the body %p',
      (body) => {
        expect(normalize('github', 'pull_request_review', body)).toEqual(malformed('body'));
      },
    );

    it.each([[undefined], [null], [7], [['submitted']]])('reports the action %p', (action) => {
      const body = set(reviewSubmitted(), 'action', action);
      expect(read('github.pull_request_review.submitted', body)).toEqual(malformed('action'));
    });

    it.each<[AgentEventType, string, Parameters<typeof set>[2], string]>([
      ['github.pull_request_review.submitted', 'review', undefined, 'review'],
      ['github.pull_request_review.submitted', 'review', [], 'review'],
      ['github.pull_request_review.submitted', 'pull_request', 'x', 'pull_request'],
      ['github.pull_request_review.submitted', 'review.state', undefined, 'review.state'],
      ['github.pull_request_review.submitted', 'review.state', 'changes requested', 'review.state'],
      ['github.pull_request_review.submitted', 'review.state', 'a'.repeat(33), 'review.state'],
      ['github.pull_request_review.submitted', 'pull_request.number', '42', 'pull_request.number'],
      ['github.pull_request_review.submitted', 'pull_request.number', 0, 'pull_request.number'],
      ['github.pull_request_review.submitted', 'pull_request.number', 4.2, 'pull_request.number'],
      ['github.pull_request_review.submitted', 'review.user', null, 'review.user'],
      ['github.pull_request_review.submitted', 'review.user.login', '', 'review.user.login'],
      ['github.pull_request_review.submitted', 'review.user.login', 7, 'review.user.login'],
      ['github.pull_request_review.submitted', 'review.user.type', undefined, 'review.user.type'],
      ['github.pull_request_review.submitted', 'review.user.id', -5, 'review.user.id'],
      ['github.pull_request_review.submitted', 'review.submitted_at', null, 'review.submitted_at'],
      ['github.pull_request_review.submitted', 'repository', undefined, 'repository'],
      ['github.pull_request_review.submitted', 'repository.id', '700100', 'repository.id'],
      ['github.pull_request_review.submitted', 'repository.full_name', 7, 'repository.full_name'],
      ['github.pull_request_review_comment.created', 'comment', undefined, 'comment'],
      ['github.pull_request_review_comment.created', 'pull_request', null, 'pull_request'],
      [
        'github.pull_request_review_comment.created',
        'pull_request.number',
        -1,
        'pull_request.number',
      ],
      ['github.pull_request_review_comment.created', 'comment.user', 'x', 'comment.user'],
      ['github.pull_request_review_comment.created', 'comment.created_at', 0, 'comment.created_at'],
      ['github.issue_comment.created', 'issue', undefined, 'issue'],
      ['github.issue_comment.created', 'comment', undefined, 'comment'],
      ['github.issue_comment.created', 'issue.number', null, 'issue.number'],
      ['github.issue_comment.created', 'comment.user.id', 0, 'comment.user.id'],
      ['github.issue_comment.created', 'comment.created_at', 'now', 'comment.created_at'],
      ['github.check_suite.completed', 'check_suite', undefined, 'check_suite'],
      [
        'github.check_suite.completed',
        'check_suite.pull_requests',
        null,
        'check_suite.pull_requests',
      ],
      [
        'github.check_suite.completed',
        'check_suite.pull_requests',
        {},
        'check_suite.pull_requests',
      ],
      [
        'github.check_suite.completed',
        'check_suite.pull_requests.0',
        42,
        'check_suite.pull_requests',
      ],
      [
        'github.check_suite.completed',
        'check_suite.pull_requests.0.base',
        null,
        'check_suite.pull_requests.base',
      ],
      [
        'github.check_suite.completed',
        'check_suite.pull_requests.0.base.repo',
        7,
        'check_suite.pull_requests.base.repo',
      ],
      [
        'github.check_suite.completed',
        'check_suite.pull_requests.0.base.repo.id',
        'x',
        'check_suite.pull_requests.base.repo.id',
      ],
      [
        'github.check_suite.completed',
        'check_suite.pull_requests.0.number',
        0,
        'check_suite.pull_requests.number',
      ],
      ['github.check_suite.completed', 'repository.id', null, 'repository.id'],
      ['github.check_suite.completed', 'sender', undefined, 'sender'],
      ['github.check_suite.completed', 'sender.login', null, 'sender.login'],
      ['github.check_suite.completed', 'check_suite.updated_at', 'soon', 'check_suite.updated_at'],
      ['github.pull_request.closed', 'pull_request', undefined, 'pull_request'],
      ['github.pull_request.closed', 'pull_request.merged', undefined, 'pull_request.merged'],
      ['github.pull_request.closed', 'pull_request.merged', 'true', 'pull_request.merged'],
      ['github.pull_request.closed', 'pull_request.number', null, 'pull_request.number'],
      ['github.pull_request.closed', 'sender', [], 'sender'],
      ['github.pull_request.closed', 'pull_request.closed_at', null, 'pull_request.closed_at'],
    ])('reports %s with %s set to %p', (type, path, value, field) => {
      expect(read(type, set(fixtures[type](), path, value))).toEqual(malformed(field));
    });

    it.each([
      ['a slash too many', 'example-org/widgets/extra'],
      ['no owner', 'widgets'],
      ['a space', 'example org/widgets'],
      ['an empty name', 'example-org/'],
      ['a line break', 'example-org/widgets\nx/y'],
      ['an owner past 100 characters', `${'o'.repeat(101)}/widgets`],
      ['a name past 100 characters', `example-org/${'w'.repeat(101)}`],
      ['a parent directory for a name', 'example-org/..'],
      ['the current directory for a name', 'example-org/.'],
      ['a dot in the owner', 'example.org/widgets'],
      ['a parent directory for an owner', '../widgets'],
    ])('reports a repository name with %s', (_name, value) => {
      const body = set(reviewSubmitted(), 'repository.full_name', value);
      expect(read('github.pull_request_review.submitted', body)).toEqual(
        malformed('repository.full_name'),
      );
    });

    it.each([
      ['a date alone', '2026-11-20'],
      ['words', 'yesterday at noon'],
      ['seconds since the epoch', 1795170662],
      ['a month that does not exist', '2026-13-20T10:31:02Z'],
      ['no zone', '2026-11-20T10:31:02'],
      ['text after the time', '2026-11-20T10:31:02Z; drop'],
      ['a time before 1970', '1969-12-31T23:59:59Z'],
    ])('reports a time given as %s', (_name, value) => {
      const body = set(reviewSubmitted(), 'review.submitted_at', value);
      expect(read('github.pull_request_review.submitted', body)).toEqual(
        malformed('review.submitted_at'),
      );
    });

    it('never repeats payload text in what it reports', () => {
      const body = reviewSubmitted();
      set(body, 'review.state', TOKEN);
      expect(JSON.stringify(read('github.pull_request_review.submitted', body))).not.toContain(
        'ghp_',
      );
      set(set(body, 'review.state', 'approved'), 'repository.full_name', `${TOKEN} leaked/x`);
      expect(JSON.stringify(read('github.pull_request_review.submitted', body))).not.toContain(
        'ghp_',
      );
    });

    it('lets a failure that is not about the payload through', () => {
      const body = {
        action: 'closed',
        get pull_request(): never {
          throw new Error('not a payload problem');
        },
      };
      expect(() => normalize('github', 'pull_request', body)).toThrow('not a payload problem');
    });
  });

  describe('identity', () => {
    it('keeps the same item through a rename and a transfer', () => {
      const before = only('github.pull_request_review.submitted');
      const after = only(
        'github.pull_request_review.submitted',
        set(reviewSubmitted(), 'repository.full_name', 'Another-Owner/Renamed.Widgets'),
      );
      expect(after.repo.name).toBe('Another-Owner/Renamed.Widgets');
      expect(itemKey(after.item)).toBe(itemKey(before.item));
      expect(itemKey(before.item)).toBe('github:pr:700100#42');
    });

    it('tells a repository that took over a name from the one that had it', () => {
      const first = only('github.issue_comment.created');
      const second = only(
        'github.issue_comment.created',
        set(issueCommentCreated(), 'repository.id', 700999),
      );
      expect(second.repo.name).toBe(first.repo.name);
      expect(itemKey(second.item)).not.toBe(itemKey(first.item));
    });

    it('takes the pull request number from the event, not from a link', () => {
      const body = set(reviewSubmitted(), 'pull_request.number', 77);
      expect(only('github.pull_request_review.submitted', body).item.number).toBe(77);
    });

    it('leaves out an installation the payload does not name', () => {
      for (const value of [undefined, null, 7, { id: '4400' }, { id: 0 }]) {
        const body = set(reviewSubmitted(), 'installation', value);
        const event = only('github.pull_request_review.submitted', body);
        expect(event).not.toHaveProperty('installation');
      }
    });
  });

  describe('the actor', () => {
    it('is the author of a review, not whoever sent the event', () => {
      const body = set(reviewSubmitted(), 'sender', user('someone-else', 6000));
      expect(only('github.pull_request_review.submitted', body).actor.login).toBe(
        'example-reviewer',
      );
    });

    it('is a bot when GitHub types the account as one', () => {
      const body = set(issueCommentCreated(), 'comment.user', user('example-ci[bot]', 7001, 'Bot'));
      expect(only('github.issue_comment.created', body).actor).toEqual({
        id: 7001,
        login: 'example-ci[bot]',
        bot: true,
        association: 'none',
      });
    });

    it('is not a bot for an organisation or for a name that only looks like one', () => {
      for (const account of [
        user('example-org', 9001, 'Organization'),
        user('pretend[bot]', 1),
        user('x', 2, 'bot'),
      ]) {
        const body = set(pullRequestClosed(), 'sender', account);
        expect(only('github.pull_request.closed', body).actor.bot).toBe(false);
      }
    });

    it('leaves out a relation GitHub did not state', () => {
      for (const value of [undefined, null, 7, 'FIRST TIMER', 'A'.repeat(33)]) {
        const body = set(issueCommentCreated(), 'comment.author_association', value);
        expect(only('github.issue_comment.created', body).actor).not.toHaveProperty('association');
      }
    });

    it('cuts a name past 100 characters', () => {
      const body = set(issueCommentCreated(), 'comment.user.login', 'n'.repeat(300));
      expect(only('github.issue_comment.created', body).actor.login).toBe(`${'n'.repeat(99)}…`);
    });
  });

  describe('display fields', () => {
    it('leaves out what the payload does not carry', () => {
      const body = reviewSubmitted();
      set(body, 'review.body', null);
      set(body, 'review.html_url', undefined);
      set(body, 'review.commit_id', undefined);
      set(body, 'pull_request.title', undefined);
      const event = only('github.pull_request_review.submitted', body);
      expect(Object.keys(event).sort()).toEqual(
        ['actor', 'installation', 'item', 'occurredAt', 'repo', 'state', 'type'].sort(),
      );
    });

    it('lower-cases a verdict', () => {
      const body = set(reviewSubmitted(), 'review.state', 'APPROVED');
      expect(only('github.pull_request_review.submitted', body).state).toBe('approved');
    });

    it('leaves out a conclusion that is not one word', () => {
      for (const value of [null, undefined, 7, 'timed out', 'x'.repeat(33)]) {
        const body = set(checkSuiteCompleted(), 'check_suite.conclusion', value);
        expect(only('github.check_suite.completed', body)).not.toHaveProperty('state');
      }
      const body = set(checkSuiteCompleted(), 'check_suite.conclusion', 'TIMED_OUT');
      expect(only('github.check_suite.completed', body).state).toBe('timed_out');
    });

    it('leaves out a commit that is not a full hash', () => {
      for (const value of [null, 7, 'abc123', `${HEAD_SHA}0`, `g${HEAD_SHA.slice(1)}`]) {
        const body = set(checkSuiteCompleted(), 'check_suite.head_sha', value);
        expect(only('github.check_suite.completed', body)).not.toHaveProperty('sha');
      }
    });

    it('lower-cases a commit and accepts the longer hash', () => {
      const long = 'AB'.repeat(32);
      const body = set(reviewCommentCreated(), 'comment.commit_id', long);
      expect(only('github.pull_request_review_comment.created', body).sha).toBe(long.toLowerCase());
    });

    it('leaves out an address that is not a plain web page', () => {
      for (const value of ['javascript:alert(1)', 'https://u:p@github.com/x', 7, null]) {
        const body = set(issueCommentCreated(), 'comment.html_url', value);
        expect(only('github.issue_comment.created', body)).not.toHaveProperty('url');
      }
    });

    it('keeps a title and a name on one line and a text as written', () => {
      const body = issueCommentCreated();
      set(body, 'issue.title', 'Fix the loader\nGitHub: review approved');
      set(body, 'comment.user.login', 'example\npasserby');
      set(body, 'comment.body', 'First.\n\nSecond.');
      const event = only('github.issue_comment.created', body);
      expect(event.title).toBe('Fix the loader GitHub: review approved');
      expect(event.actor.login).toBe('example passerby');
      expect(event.text).toBe('First.\n\nSecond.');
    });

    it('cuts a title at 256 characters and a text at 2,000', () => {
      const body = issueCommentCreated();
      set(body, 'issue.title', 't'.repeat(300));
      set(body, 'comment.body', 'word '.repeat(14_000));
      const event = only('github.issue_comment.created', body);
      expect(event.title).toBe(`${'t'.repeat(255)}…`);
      expect(event.text).toHaveLength(2000);
      expect(event.text?.endsWith('word…')).toBe(true);
    });

    it('reads the first instant it can represent', () => {
      const body = set(reviewSubmitted(), 'review.submitted_at', '1970-01-01T00:00:00Z');
      expect(only('github.pull_request_review.submitted', body).occurredAt).toBe(0);
    });

    it('leaves out a text too long to have come from GitHub and keeps the event', () => {
      const body = set(issueCommentCreated(), 'comment.body', 'b'.repeat(131_073));
      const event = only('github.issue_comment.created', body);
      expect(event).not.toHaveProperty('text');
      expect(event.url).toBe(`${PAGE}#issuecomment-3300`);
    });

    it('cuts a text where the caller says', () => {
      const body = set(issueCommentCreated(), 'comment.body', 'b'.repeat(300));
      const cut = (type: AgentEventType, payload: Payload): string | undefined => {
        const outcome = normalize('github', catalog[type].event, payload, {
          ...LIMITS,
          excerpt: 50,
        });
        return outcome.ok ? outcome.value[0].text : undefined;
      };
      expect(cut('github.issue_comment.created', body)).toBe(`${'b'.repeat(49)}…`);
      expect(
        cut(
          'github.pull_request_review.submitted',
          set(reviewSubmitted(), 'review.body', 'r'.repeat(300)),
        ),
      ).toBe(`${'r'.repeat(49)}…`);
      expect(
        cut(
          'github.pull_request_review_comment.created',
          set(reviewCommentCreated(), 'comment.body', 'c'.repeat(300)),
        ),
      ).toBe(`${'c'.repeat(49)}…`);
      expect(only('github.issue_comment.created', body).text).toBe('b'.repeat(300));
    });

    it('ships with a 2,000 character excerpt and ten events for a check suite', () => {
      expect(LIMITS).toEqual({ excerpt: 2000, fanout: 10 });
    });

    it('reads a time with an offset and a fraction', () => {
      const body = set(reviewSubmitted(), 'review.submitted_at', '2026-11-20T12:31:02.250+02:00');
      expect(only('github.pull_request_review.submitted', body).occurredAt).toBe(
        Date.UTC(2026, 10, 20, 10, 31, 2, 250),
      );
    });
  });

  describe('a check suite', () => {
    const suite = (pulls: Payload[]): Payload =>
      set(checkSuiteCompleted(), 'check_suite.pull_requests', pulls);

    it('yields one event for each pull request it heads', () => {
      const [first, second, ...rest] = events(
        'github.check_suite.completed',
        suite([suitePullRequest(42), suitePullRequest(43)]),
      );
      expect(rest).toHaveLength(0);
      expect(first.item.number).toBe(42);
      expect(second.item.number).toBe(43);
      expect(second.url).toBe('https://github.com/example-org/widgets/pull/43');
      expect(second).toEqual({ ...first, item: second.item, url: second.url });
    });

    it('counts a pull request once', () => {
      const body = suite([suitePullRequest(42), suitePullRequest(42), suitePullRequest(43)]);
      expect(
        events('github.check_suite.completed', body).map((event) => event.item.number),
      ).toEqual([42, 43]);
    });

    it('skips a pull request opened against another repository', () => {
      const body = suite([suitePullRequest(7, 700999), suitePullRequest(42)]);
      expect(only('github.check_suite.completed', body).item).toEqual(shared.item);
    });

    it('yields at most ten events', () => {
      const body = suite(
        Array.from({ length: 12 }, (_unused, index) => suitePullRequest(index + 1)),
      );
      expect(
        events('github.check_suite.completed', body).map((event) => event.item.number),
      ).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    });

    it('reads past any number of pull requests of other repositories', () => {
      const foreign = Array.from({ length: 500 }, (_unused, index) =>
        suitePullRequest(index + 1, 700999),
      );
      expect(
        only('github.check_suite.completed', suite([...foreign, suitePullRequest(42)])).item,
      ).toEqual(shared.item);
    });

    it('stops reading once it has as many as it may yield', () => {
      const pulls = Array.from({ length: 10 }, (_unused, index) => suitePullRequest(index + 1));
      const body = set(suite([...pulls, suitePullRequest(11)]), 'check_suite.pull_requests.10', 7);
      expect(events('github.check_suite.completed', body)).toHaveLength(10);
      const early = set(suite([...pulls]), 'check_suite.pull_requests.9', 7);
      expect(read('github.check_suite.completed', early)).toEqual(
        malformed('check_suite.pull_requests'),
      );
    });

    it('yields as many events as the caller allows', () => {
      const body = suite(
        Array.from({ length: 12 }, (_unused, index) => suitePullRequest(index + 1)),
      );
      const numbers = (fanout: number): number[] => {
        const outcome = normalize('github', 'check_suite', body, { ...LIMITS, fanout });
        return outcome.ok ? outcome.value.map((event) => event.item.number) : [];
      };
      expect(numbers(2)).toEqual([1, 2]);
      expect(numbers(1)).toEqual([1]);
      expect(numbers(50)).toHaveLength(12);
    });

    it('builds the page from the repository address, or leaves it out', () => {
      const trailing = set(checkSuiteCompleted(), 'repository.html_url', `${HOME}/`);
      expect(only('github.check_suite.completed', trailing).url).toBe(PAGE);
      for (const value of [undefined, 'not an address', `${HOME}#readme`]) {
        const body = set(checkSuiteCompleted(), 'repository.html_url', value);
        expect(only('github.check_suite.completed', body)).not.toHaveProperty('url');
      }
    });

    it('does not read the sender of a suite it ignores', () => {
      const body = set(suite([]), 'sender', undefined);
      expect(read('github.check_suite.completed', body)).toEqual(ignored('item'));
    });
  });

  describe('credentials', () => {
    it('removes a token from the text it copies', () => {
      const body = issueCommentCreated();
      set(body, 'comment.body', `try ${TOKEN} or https://bot:${TOKEN}@github.com/x`);
      set(body, 'issue.title', `Rotate ${TOKEN}`);
      const event = only('github.issue_comment.created', body);
      expect(event.text).toBe('try [redacted] or https://[redacted]@github.com/x');
      expect(event.title).toBe('Rotate [redacted]');
    });

    it.each(AGENT_EVENT_TYPES)('copies nothing it does not name from %s', (type) => {
      const body = fixtures[type]();
      const marker = 'SECRET-MARKER';
      const plant = (node: Payload): void => {
        node.token = marker;
        node.access_tokens_url = `https://api.github.com/x?token=${marker}`;
      };
      plant(body);
      for (const value of Object.values(body)) {
        if (value != null && typeof value === 'object' && !Array.isArray(value)) {
          plant(value);
        }
      }
      set(body, 'repository.clone_url', `https://x-access-token:${marker}@github.com/o/r.git`);
      set(body, 'repository.description', marker);
      set(body, 'sender.email', `${marker}@example.com`);
      set(body, 'installation.node_id', marker);
      const outcome = read(type, body);
      expect(outcome.ok).toBe(true);
      expect(JSON.stringify(outcome)).not.toContain(marker);
    });

    it('drops the query of an address it copies', () => {
      const body = set(
        issueCommentCreated(),
        'comment.html_url',
        `${PAGE}?access_token=${TOKEN}#issuecomment-3300`,
      );
      expect(only('github.issue_comment.created', body).url).toBe(`${PAGE}#issuecomment-3300`);
    });
  });

  it.each([
    ['example_emu/.github'],
    ['o/...'],
    ['o/.x'],
    [`${'o'.repeat(100)}/${'w'.repeat(100)}`],
  ])('accepts the repository name %s', (name) => {
    const body = set(reviewSubmitted(), 'repository.full_name', name);
    expect(only('github.pull_request_review.submitted', body).repo.name).toBe(name);
  });

  it('names the repository the event was delivered for', () => {
    const body = set(reviewSubmitted(), 'repository', repository('o/r', 5));
    expect(only('github.pull_request_review.submitted', body).repo).toEqual({ id: 5, name: 'o/r' });
  });
});
