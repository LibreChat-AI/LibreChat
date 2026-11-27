import {
  SUBSCRIPTION_CAP_MAX,
  SUBSCRIPTION_EVENTS_MAX,
  SUBSCRIPTION_FILTER_MAX,
  subscriptionCreateSchema,
  subscriptionUpdateSchema,
  SUBSCRIPTION_ID_MAX_LENGTH,
  SUBSCRIPTION_WINDOW_MAX_MS,
  SUBSCRIPTION_EVENT_MAX_LENGTH,
  SUBSCRIPTION_FILTER_MAX_LENGTH,
  SUBSCRIPTION_PROMPT_MAX_LENGTH,
} from './subscriptions';

const base = {
  connection: 'conn_1',
  agentId: 'agent_1',
  events: ['pull_request.review'],
  prompt: 'Read the review.',
};

const accepts = (input: unknown) => subscriptionCreateSchema.safeParse(input).success;
const edits = (input: unknown) => subscriptionUpdateSchema.safeParse(input).success;

describe('subscriptionCreateSchema', () => {
  it('fills what a create may leave out, and leaves the actor rule to the deployment', () => {
    expect(subscriptionCreateSchema.parse(base)).toEqual({
      ...base,
      target: 'new',
      bots: false,
      enabled: true,
    });
  });

  it('keeps every field that is sent', () => {
    const full = {
      ...base,
      filters: { repositories: ['octo/site'], branches: ['main'], labels: ['bug'] },
      target: 'new',
      actors: 'linked',
      bots: true,
      cap: { perHour: 5 },
      window: { ms: 60_000 },
      enabled: false,
    };
    expect(subscriptionCreateSchema.parse(full)).toEqual(full);
  });

  it('trims text and drops repeated entries', () => {
    const parsed = subscriptionCreateSchema.parse({
      connection: ' conn_1 ',
      agentId: ' agent_1 ',
      events: [' check_suite.completed ', 'check_suite.completed', 'pull_request.review'],
      prompt: '  Read the review.  ',
      filters: { repositories: [' octo/site ', 'octo/site'] },
    });
    expect(parsed.connection).toBe('conn_1');
    expect(parsed.agentId).toBe('agent_1');
    expect(parsed.events).toEqual(['check_suite.completed', 'pull_request.review']);
    expect(parsed.prompt).toBe('Read the review.');
    expect(parsed.filters).toEqual({ repositories: ['octo/site'] });
  });

  it.each(['connection', 'agentId', 'events', 'prompt'])('requires %s', (field) => {
    const { [field as keyof typeof base]: _omitted, ...rest } = base;
    expect(accepts(rest)).toBe(false);
  });

  it.each(['connection', 'agentId', 'prompt'])('refuses a blank %s', (field) => {
    expect(accepts({ ...base, [field]: '   ' })).toBe(false);
  });

  it('bounds the ids it refers to', () => {
    const longest = 'c'.repeat(SUBSCRIPTION_ID_MAX_LENGTH);
    expect(accepts({ ...base, connection: longest, agentId: longest })).toBe(true);
    expect(accepts({ ...base, connection: `${longest}c` })).toBe(false);
    expect(accepts({ ...base, agentId: `${longest}c` })).toBe(false);
  });

  it('bounds the event list and each entry', () => {
    const many = Array.from({ length: SUBSCRIPTION_EVENTS_MAX }, (_, index) => `event.${index}`);
    expect(accepts({ ...base, events: many })).toBe(true);
    expect(accepts({ ...base, events: [...many, 'event.more'] })).toBe(false);
    expect(accepts({ ...base, events: [] })).toBe(false);
    expect(accepts({ ...base, events: [' '] })).toBe(false);
    expect(accepts({ ...base, events: ['e'.repeat(SUBSCRIPTION_EVENT_MAX_LENGTH)] })).toBe(true);
    expect(accepts({ ...base, events: ['e'.repeat(SUBSCRIPTION_EVENT_MAX_LENGTH + 1)] })).toBe(
      false,
    );
  });

  it('bounds the prompt', () => {
    expect(accepts({ ...base, prompt: 'p'.repeat(SUBSCRIPTION_PROMPT_MAX_LENGTH) })).toBe(true);
    expect(accepts({ ...base, prompt: 'p'.repeat(SUBSCRIPTION_PROMPT_MAX_LENGTH + 1) })).toBe(
      false,
    );
  });

  it.each(['repositories', 'branches', 'labels'])('bounds the %s filter', (dimension) => {
    const many = Array.from({ length: SUBSCRIPTION_FILTER_MAX }, (_, index) => `value-${index}`);
    const filter = (values: string[]) => ({ ...base, filters: { [dimension]: values } });
    expect(accepts(filter(many))).toBe(true);
    expect(accepts(filter([...many, 'more']))).toBe(false);
    expect(accepts(filter([]))).toBe(false);
    expect(accepts(filter([' ']))).toBe(false);
    expect(accepts(filter(['v'.repeat(SUBSCRIPTION_FILTER_MAX_LENGTH)]))).toBe(true);
    expect(accepts(filter(['v'.repeat(SUBSCRIPTION_FILTER_MAX_LENGTH + 1)]))).toBe(false);
  });

  it('accepts only the actor rules and targets there are', () => {
    expect(accepts({ ...base, actors: 'write' })).toBe(true);
    expect(accepts({ ...base, actors: 'any' })).toBe(true);
    expect(accepts({ ...base, actors: 'everyone' })).toBe(false);
    expect(accepts({ ...base, target: 'item' })).toBe(false);
  });

  it('bounds the run cap and the window', () => {
    expect(accepts({ ...base, cap: { perHour: 1 } })).toBe(true);
    expect(accepts({ ...base, cap: { perHour: SUBSCRIPTION_CAP_MAX } })).toBe(true);
    expect(accepts({ ...base, cap: { perHour: 0 } })).toBe(false);
    expect(accepts({ ...base, cap: { perHour: SUBSCRIPTION_CAP_MAX + 1 } })).toBe(false);
    expect(accepts({ ...base, cap: { perHour: 1.5 } })).toBe(false);
    expect(accepts({ ...base, window: { ms: 0 } })).toBe(true);
    expect(accepts({ ...base, window: { ms: SUBSCRIPTION_WINDOW_MAX_MS } })).toBe(true);
    expect(accepts({ ...base, window: { ms: -1 } })).toBe(false);
    expect(accepts({ ...base, window: { ms: SUBSCRIPTION_WINDOW_MAX_MS + 1 } })).toBe(false);
    expect(accepts({ ...base, window: { ms: 0.5 } })).toBe(false);
  });

  it('refuses a field it does not know, at every level', () => {
    expect(accepts({ ...base, user: 'someone-else' })).toBe(false);
    expect(accepts({ ...base, revision: 9 })).toBe(false);
    expect(accepts({ ...base, filters: { teams: ['core'] } })).toBe(false);
    expect(accepts({ ...base, cap: { perHour: 1, perDay: 2 } })).toBe(false);
    expect(accepts({ ...base, window: { ms: 1, s: 2 } })).toBe(false);
  });
});

describe('subscriptionUpdateSchema', () => {
  it('leaves a field that was not sent absent, so an edit cannot reset it', () => {
    expect(subscriptionUpdateSchema.parse({ prompt: 'New.' })).toEqual({ prompt: 'New.' });
    expect(subscriptionUpdateSchema.parse({ enabled: false, expectedRevision: 2 })).toEqual({
      enabled: false,
      expectedRevision: 2,
    });
  });

  it('clears a field that may be left out, and only such a field', () => {
    expect(subscriptionUpdateSchema.parse({ filters: null, cap: null, window: null })).toEqual({
      filters: null,
      cap: null,
      window: null,
    });
    expect(edits({ prompt: null })).toBe(false);
    expect(edits({ events: null })).toBe(false);
    expect(edits({ actors: null })).toBe(false);
  });

  it('keeps the bounds of a create', () => {
    expect(edits({ events: [] })).toBe(false);
    expect(edits({ prompt: ' ' })).toBe(false);
    expect(edits({ cap: { perHour: 0 } })).toBe(false);
    expect(edits({ window: { ms: -1 } })).toBe(false);
    expect(edits({ filters: { labels: [] } })).toBe(false);
    expect(edits({ actors: 'everyone' })).toBe(false);
  });

  it('does not move a subscription to another connection or agent', () => {
    expect(edits({ connection: 'conn_2' })).toBe(false);
    expect(edits({ agentId: 'agent_2' })).toBe(false);
  });

  it('refuses an edit that changes nothing', () => {
    expect(edits({})).toBe(false);
    expect(edits({ expectedRevision: 1 })).toBe(false);
    expect(edits({ prompt: undefined, expectedRevision: 1 })).toBe(false);
    expect(edits({ prompt: undefined, cap: null })).toBe(true);
  });

  it('takes the revision an edit was made from as a whole number from zero', () => {
    expect(edits({ bots: true, expectedRevision: 0 })).toBe(true);
    expect(edits({ bots: true, expectedRevision: -1 })).toBe(false);
    expect(edits({ bots: true, expectedRevision: 1.5 })).toBe(false);
  });
});
