import { resolveTraceViewerConfig } from 'librechat-data-provider';
import type { AppConfig, ConversationTraceRefs } from '@librechat/data-schemas';
import type { LangfuseScoreDestination } from './destinations';
import type { TraceQuery } from '~/traces/types';

process.env.CREDS_KEY =
  process.env.CREDS_KEY ?? '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

jest.mock(
  '@librechat/data-schemas',
  () => ({
    logger: { debug: jest.fn(), error: jest.fn(), warn: jest.fn(), info: jest.fn() },
  }),
  { virtual: true },
);

jest.mock('~/admin/secrets', () => ({
  decryptConfigSecret: jest.fn((value: string) => value),
}));

import { createLangfuseTraceReader, resolveLangfuseReadDestinations } from './reader';
import { getLangfuseDestinationId } from './destinations';
import { TraceReadError } from '~/traces/types';
import { traceIdForMessage } from './trace';

const NOW = Date.UTC(2026, 8, 12, 12, 0, 0);
const FIRST_MESSAGE_AT = new Date(Date.UTC(2026, 8, 12, 11, 0, 0));
const RESPONSE_TRACE = traceIdForMessage('response-1');
const TITLE_TRACE = traceIdForMessage('title-response-1');
const FOREIGN_TRACE = traceIdForMessage('someone-elses-response');

const central: LangfuseScoreDestination = {
  id: 'central-id',
  name: 'central',
  baseUrl: 'https://central.langfuse.test',
  authorization: 'Basic central',
};
const connection: LangfuseScoreDestination = {
  id: 'connection-id',
  name: 'connection',
  baseUrl: 'https://tenant.langfuse.test/base/',
  authorization: 'Basic tenant',
  headers: { 'X-Gateway': 'token' },
};

function createRefs(overrides: Partial<ConversationTraceRefs> = {}): ConversationTraceRefs {
  return {
    firstMessageAt: FIRST_MESSAGE_AT,
    sampledMessages: [{ messageId: 'response-1', langfuseDestinationIds: ['connection-id'] }],
    ...overrides,
  };
}

function createQuery(overrides: Partial<TraceQuery> = {}): TraceQuery {
  return {
    userId: 'owner',
    conversationId: 'convo-1',
    settings: resolveTraceViewerConfig({ enabled: true }),
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function observation(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'obs-root',
    traceId: RESPONSE_TRACE,
    startTime: '2026-09-12T11:30:00.000Z',
    endTime: '2026-09-12T11:30:05.000Z',
    projectId: 'project',
    parentObservationId: null,
    type: 'AGENT',
    name: 'AgentGraph',
    level: 'DEFAULT',
    statusMessage: '',
    ...overrides,
  };
}

type RoutedRequest = { origin: string; probe: boolean; traceIds: string[]; cursor: string | null };

function routeOf(url: string): RoutedRequest {
  const parsed = new URL(url);
  const filter: FilterCondition[] = JSON.parse(parsed.searchParams.get('filter') ?? '[]');
  return {
    origin: parsed.origin,
    probe: filter.some(({ column }) => column === 'parentObservationId'),
    traceIds: (filter.find(({ column }) => column === 'traceId')?.value as string[]) ?? [],
    cursor: parsed.searchParams.get('cursor'),
  };
}

function setup({
  refs = createRefs(),
  destinations = [central, connection],
  responses = [] as Array<Response | Error>,
  route,
}: {
  refs?: ConversationTraceRefs;
  destinations?: LangfuseScoreDestination[];
  responses?: Array<Response | Error>;
  /** Answers each Langfuse request by what it asks for, instead of by arrival order. */
  route?: (request: RoutedRequest) => Response | Error;
} = {}) {
  const fetchMock = jest.fn(async (url: string, _init: RequestInit): Promise<Response> => {
    const next = route ? route(routeOf(url)) : responses.shift();
    if (next == null) {
      throw new Error('unexpected fetch');
    }
    if (next instanceof Error) {
      throw next;
    }
    return next;
  });
  /** Same paging contract as the data-schemas query, which has its own database spec. */
  const getConversationTraceRefs = jest.fn(
    async ({
      messageId,
      through,
      limit,
    }: {
      messageId?: string;
      through?: { messageId: string; orderKey: string };
      limit?: number;
    } = {}) => {
      const all = refs.sampledMessages.map((message) => ({
        ...message,
        orderKey: `key:${message.messageId}`,
      }));
      if (messageId != null) {
        return {
          ...refs,
          sampledMessages: all.filter((message) => message.messageId === messageId),
        };
      }
      const end =
        through != null
          ? all.findIndex(
              (message) =>
                message.messageId === through.messageId && message.orderKey === through.orderKey,
            )
          : all.length - 1;
      if (through != null && end === -1) {
        return { ...refs, sampledMessages: [] };
      }
      const start = limit != null ? Math.max(0, end - limit + 1) : 0;
      return { ...refs, sampledMessages: all.slice(start, end + 1) };
    },
  );
  /** Same rule as the data-schemas query, which has its own database spec. */
  const hasSampledTraceMessage = jest.fn(async ({ destinationIds }: { destinationIds: string[] }) =>
    refs.sampledMessages.some(
      ({ langfuseDestinationIds }) =>
        langfuseDestinationIds == null ||
        langfuseDestinationIds.some((id) => destinationIds.includes(id)),
    ),
  );
  const resolveDestinations = jest.fn(async () => destinations);
  const reader = createLangfuseTraceReader({
    getConversationTraceRefs,
    hasSampledTraceMessage,
    resolveDestinations,
    fetch: fetchMock,
    now: () => NOW,
  });
  return {
    reader,
    fetchMock,
    getConversationTraceRefs,
    hasSampledTraceMessage,
    resolveDestinations,
  };
}

function requestedUrl(fetchMock: jest.Mock, call = 0): URL {
  return new URL(String(fetchMock.mock.calls[call][0]));
}

type FilterCondition = { column: string; operator: string; value: string | string[] };

function requestedFilter(fetchMock: jest.Mock, call = 0): FilterCondition[] {
  return JSON.parse(requestedUrl(fetchMock, call).searchParams.get('filter') ?? '[]');
}

function requestedTraceIds(fetchMock: jest.Mock, call = 0): string[] {
  const condition = requestedFilter(fetchMock, call).find(({ column }) => column === 'traceId');
  return (condition?.value as string[]) ?? [];
}

function tracesOf(...messageIds: string[]): string[] {
  return messageIds.flatMap((id) => [traceIdForMessage(id), traceIdForMessage(`title-${id}`)]);
}

const TENANT = 'https://tenant.langfuse.test';
const CENTRAL = 'https://central.langfuse.test';

/** A probe answer: one root observation per trace the project holds. */
function rootsFor(request: RoutedRequest, ...messageIds: string[]): Response {
  const held = new Set(messageIds.map((id) => traceIdForMessage(id)));
  return jsonResponse({
    data: request.traceIds
      .filter((traceId) => held.has(traceId))
      .map((traceId) => ({ id: `root-${traceId}`, traceId })),
  });
}

/** A read answer: one observation per requested turn the project holds. */
function recordsFor(request: RoutedRequest, ...messageIds: string[]): Response {
  return jsonResponse({
    data: messageIds
      .filter((id) => request.traceIds.includes(traceIdForMessage(id)))
      .map((id) => observation({ id, traceId: traceIdForMessage(id) })),
  });
}

/** Every request, as a readable line, in the order the reader made them. */
function calls(fetchMock: jest.Mock): string[] {
  return fetchMock.mock.calls.map(([url]) => {
    const request = routeOf(String(url));
    const host = request.origin === TENANT ? 'tenant' : 'central';
    return `${request.probe ? 'probe' : 'read'} ${host}${request.cursor ? ` @${request.cursor}` : ''}`;
  });
}

function encodeTestCursor(cursor: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}

describe('createLangfuseTraceReader', () => {
  describe('isAvailable', () => {
    it('is unavailable without a sampled response and never reads Langfuse', async () => {
      const { reader, fetchMock, getConversationTraceRefs } = setup({
        refs: createRefs({ sampledMessages: [] }),
      });

      await expect(reader.isAvailable(createQuery())).resolves.toEqual({ available: false });
      expect(getConversationTraceRefs).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('is unavailable when no configured destination received the trace', async () => {
      const { reader } = setup({
        refs: createRefs({
          sampledMessages: [{ messageId: 'response-1', langfuseDestinationIds: ['retired-id'] }],
        }),
      });

      await expect(reader.isAvailable(createQuery())).resolves.toEqual({ available: false });
    });

    it('stays available when only newer responses reached a readable destination', async () => {
      const { reader, hasSampledTraceMessage } = setup({
        refs: createRefs({
          sampledMessages: [
            { messageId: 'response-0', langfuseDestinationIds: ['retired-id'] },
            { messageId: 'response-1', langfuseDestinationIds: ['connection-id'] },
          ],
        }),
      });

      await expect(reader.isAvailable(createQuery())).resolves.toEqual({ available: true });
      expect(hasSampledTraceMessage).toHaveBeenCalledWith({
        user: 'owner',
        conversationId: 'convo-1',
        destinationIds: ['central-id', 'connection-id'],
      });
    });

    it('explains once when no destination can read traces at all', async () => {
      const { reader, hasSampledTraceMessage } = setup({ destinations: [] });
      const { logger } = jest.requireMock<{ logger: { warn: jest.Mock } }>(
        '@librechat/data-schemas',
      );
      logger.warn.mockClear();

      await expect(reader.isAvailable(createQuery())).resolves.toEqual({ available: false });
      await expect(reader.isAvailable(createQuery())).resolves.toEqual({ available: false });

      expect(hasSampledTraceMessage).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(logger.warn.mock.calls[0][0]).toContain('no destination with read credentials');
    });

    it('answers from one existence query without loading every response or reading Langfuse', async () => {
      const { reader, fetchMock, getConversationTraceRefs, hasSampledTraceMessage } = setup();

      await expect(reader.isAvailable(createQuery())).resolves.toEqual({ available: true });
      expect(hasSampledTraceMessage).toHaveBeenCalledTimes(1);
      expect(getConversationTraceRefs).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('listRecords', () => {
    it('reads the session from the recorded destination with its credentials and window', async () => {
      const { reader, fetchMock } = setup({ responses: [jsonResponse({ data: [], meta: {} })] });

      await expect(reader.listRecords(createQuery())).resolves.toEqual({
        records: [],
        sourceId: 'connection-id',
      });

      const url = requestedUrl(fetchMock);
      expect(url.origin + url.pathname).toBe(
        'https://tenant.langfuse.test/base/api/public/v2/observations',
      );
      expect(Object.fromEntries(url.searchParams)).toEqual({
        fields: 'core,basic,time,model,usage',
        limit: '1000',
        filter: expect.any(String),
      });
      expect(requestedFilter(fetchMock)).toEqual([
        { type: 'string', column: 'sessionId', operator: '=', value: 'convo-1' },
        { type: 'stringOptions', column: 'userId', operator: 'any of', value: ['owner'] },
        {
          type: 'stringOptions',
          column: 'traceId',
          operator: 'any of',
          value: [RESPONSE_TRACE, TITLE_TRACE],
        },
        { type: 'datetime', column: 'startTime', operator: '<', value: '2026-09-12T12:10:00.000Z' },
        {
          type: 'datetime',
          column: 'startTime',
          operator: '>=',
          value: '2026-09-12T10:50:00.000Z',
        },
      ]);
      const init = fetchMock.mock.calls[0][1] as RequestInit;
      expect(new Headers(init.headers).get('Authorization')).toBe('Basic tenant');
      expect(new Headers(init.headers).get('X-Gateway')).toBe('token');
      expect(init.redirect).toBe('error');
    });

    it('reads central when it is the only destination recorded on the messages', async () => {
      const { reader, fetchMock } = setup({
        refs: createRefs({
          sampledMessages: [{ messageId: 'response-1', langfuseDestinationIds: ['central-id'] }],
        }),
        responses: [jsonResponse({ data: [] })],
      });

      await reader.listRecords(createQuery());

      expect(requestedUrl(fetchMock).origin).toBe('https://central.langfuse.test');
    });

    it('reads the project holding the newest turn first after a conversation moved projects', async () => {
      const refs = createRefs({
        sampledMessages: [
          { messageId: 'response-0', langfuseDestinationIds: ['central-id'] },
          { messageId: 'response-1', langfuseDestinationIds: ['central-id'] },
          { messageId: 'response-2', langfuseDestinationIds: ['connection-id'] },
        ],
      });
      const { reader, fetchMock } = setup({
        refs,
        responses: [
          jsonResponse({
            data: [observation({ id: 'newest', traceId: traceIdForMessage('response-2') })],
          }),
        ],
      });

      const page = await reader.listRecords(createQuery());

      expect(requestedUrl(fetchMock).origin).toBe('https://tenant.langfuse.test');
      expect(page).toMatchObject({ sourceId: 'connection-id', records: [{ id: 'newest' }] });

      const later = setup({ refs, responses: [jsonResponse({ data: [] })] });
      await later.reader.listRecords({ ...createQuery(), cursor: page.nextCursor });

      expect(requestedUrl(later.fetchMock).origin).toBe('https://central.langfuse.test');
    });

    it('asks for only the observations exported under the requesting user id', async () => {
      const refs = createRefs({
        sampledMessages: [
          { messageId: 'response-1', langfuseDestinationIds: ['central-id', 'connection-id'] },
        ],
      });
      const { reader, fetchMock } = setup({
        refs,
        route: (request) =>
          request.probe ? rootsFor(request, 'response-1') : recordsFor(request, 'response-1'),
      });

      await reader.listRecords(createQuery());
      await reader.getRecord({ ...createQuery(), recordId: 'response-1', messageId: 'response-1' });

      const owner = {
        type: 'stringOptions',
        column: 'userId',
        operator: 'any of',
        value: ['owner'],
      };
      expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(4);
      fetchMock.mock.calls.forEach((_call, index) => {
        expect(requestedFilter(fetchMock, index)).toContainEqual(owner);
      });
    });

    it('shows no trace while traces are exported under a user field that is not the internal id', async () => {
      const { reader, fetchMock, hasSampledTraceMessage } = setup({
        responses: [jsonResponse({ data: [observation()] })],
      });
      const query = createQuery({
        appConfig: { langfuse: { trace: { userIdField: 'name' } } } as AppConfig,
      });

      await expect(reader.isAvailable(query)).resolves.toEqual({ available: false });
      await expect(reader.listRecords(query)).rejects.toMatchObject({ code: 'not_found' });
      await expect(
        reader.getRecord({ ...query, recordId: 'obs-root', messageId: 'response-1' }),
      ).resolves.toBeNull();
      expect(hasSampledTraceMessage).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();

      const ignoredField = createQuery({
        appConfig: {
          langfuse: { trace: { userIdField: 'not-a-user-field' } },
        } as unknown as AppConfig,
      });
      await expect(reader.isAvailable(ignoredField)).resolves.toEqual({ available: true });
    });

    it('reads a turn only its preferred project holds without asking any project first', async () => {
      const { reader, fetchMock } = setup({
        refs: createRefs({
          sampledMessages: [{ messageId: 'response-1', langfuseDestinationIds: ['connection-id'] }],
        }),
        route: (request) => recordsFor(request, 'response-1'),
      });

      await reader.listRecords(createQuery());

      expect(calls(fetchMock)).toEqual(['read tenant']);
    });

    it('reads a turn two projects could hold from the preferred one that holds it', async () => {
      const refs = createRefs({
        sampledMessages: [
          { messageId: 'response-1', langfuseDestinationIds: ['central-id', 'connection-id'] },
        ],
      });
      const both = setup({
        refs,
        route: (request) =>
          request.probe ? rootsFor(request, 'response-1') : recordsFor(request, 'response-1'),
      });
      const onlyCentral = setup({
        refs,
        route: (request) => {
          const held = request.origin === CENTRAL ? ['response-1'] : [];
          return request.probe ? rootsFor(request, ...held) : recordsFor(request, ...held);
        },
      });

      await both.reader.listRecords(createQuery());
      const page = await onlyCentral.reader.listRecords(createQuery());

      expect(calls(both.fetchMock)).toEqual(['probe tenant', 'probe central', 'read tenant']);
      expect(calls(onlyCentral.fetchMock)).toEqual([
        'probe tenant',
        'probe central',
        'read central',
      ]);
      expect(page).toMatchObject({ sourceId: 'central-id', records: [{ id: 'response-1' }] });
    });

    it('pages turns in order whichever projects hold them', async () => {
      const refs = createRefs({
        sampledMessages: [
          { messageId: 'response-0', langfuseDestinationIds: ['central-id'] },
          { messageId: 'legacy-1' },
          { messageId: 'response-2', langfuseDestinationIds: ['connection-id'] },
          { messageId: 'response-3', langfuseDestinationIds: ['central-id'] },
          { messageId: 'response-4', langfuseDestinationIds: ['central-id'] },
        ],
      });
      const held: Record<string, string[]> = {
        [TENANT]: ['response-2'],
        [CENTRAL]: ['response-0', 'legacy-1', 'response-3', 'response-4'],
      };
      const pages: Array<{ sourceId?: string; records: string[] }> = [];
      let cursor: string | undefined;
      do {
        const { reader } = setup({
          refs,
          route: (request) =>
            request.probe
              ? rootsFor(request, ...held[request.origin])
              : recordsFor(request, ...held[request.origin]),
        });
        const page = await reader.listRecords({ ...createQuery(), cursor });
        pages.push({ sourceId: page.sourceId, records: page.records.map(({ id }) => id).sort() });
        cursor = page.nextCursor;
      } while (cursor);

      expect(pages).toEqual([
        { sourceId: 'central-id', records: ['response-3', 'response-4'] },
        { sourceId: 'connection-id', records: ['response-2'] },
        { sourceId: 'central-id', records: ['legacy-1', 'response-0'] },
      ]);
    });

    it('reads a title run from the project that holds it when it landed apart from its run', async () => {
      const refs = createRefs({
        sampledMessages: [
          { messageId: 'response-1', langfuseDestinationIds: ['central-id', 'connection-id'] },
        ],
      });
      const titleTrace = traceIdForMessage('title-response-1');
      const route = (request: RoutedRequest) => {
        const traceIds =
          request.origin === TENANT ? [traceIdForMessage('response-1')] : [titleTrace];
        const asked = traceIds.filter((traceId) => request.traceIds.includes(traceId));
        return jsonResponse({
          data: asked.map((traceId) =>
            request.probe
              ? { id: `root-${traceId}`, traceId }
              : observation({ id: traceId === titleTrace ? 'title' : 'run', traceId }),
          ),
        });
      };
      const pages: Array<{ sourceId?: string; records: string[] }> = [];
      let cursor: string | undefined;
      do {
        const { reader } = setup({ refs, route });
        const page = await reader.listRecords({ ...createQuery(), cursor });
        pages.push({ sourceId: page.sourceId, records: page.records.map(({ id }) => id) });
        cursor = page.nextCursor;
      } while (cursor);

      expect(pages).toEqual([
        { sourceId: 'connection-id', records: ['run'] },
        { sourceId: 'central-id', records: ['title'] },
      ]);
    });

    it('reads a title run that started after its run first when the two sit in different projects', async () => {
      const refs = createRefs({
        sampledMessages: [
          { messageId: 'response-0', langfuseDestinationIds: ['connection-id'] },
          { messageId: 'response-1', langfuseDestinationIds: ['central-id', 'connection-id'] },
        ],
      });
      const runTrace = traceIdForMessage('response-1');
      const titleTrace = traceIdForMessage('title-response-1');
      const olderTrace = traceIdForMessage('response-0');
      const held: Record<string, Record<string, string>> = {
        [TENANT]: {
          [runTrace]: '2026-09-12T11:30:00.000Z',
          [olderTrace]: '2026-09-12T11:20:00.000Z',
        },
        [CENTRAL]: { [titleTrace]: '2026-09-12T11:30:09.000Z' },
      };
      const route = (request: RoutedRequest) =>
        jsonResponse({
          data: Object.entries(held[request.origin])
            .filter(([traceId]) => request.traceIds.includes(traceId))
            .map(([traceId, startTime]) =>
              request.probe
                ? { id: `root-${traceId}`, traceId, startTime }
                : observation({ id: traceId, traceId, startTime }),
            ),
        });
      const pages: string[][] = [];
      let cursor: string | undefined;
      do {
        const { reader } = setup({ refs, route });
        const page = await reader.listRecords({ ...createQuery(), cursor });
        pages.push(page.records.map(({ id }) => id));
        cursor = page.nextCursor;
      } while (cursor);

      expect(pages).toEqual([[titleTrace], [runTrace, olderTrace]]);
    });

    it('reports a failed read of a title run a probe found, instead of dropping it', async () => {
      const refs = createRefs({
        sampledMessages: [
          { messageId: 'response-1', langfuseDestinationIds: ['central-id', 'connection-id'] },
        ],
      });
      const runTrace = traceIdForMessage('response-1');
      const titleTrace = traceIdForMessage('title-response-1');
      const route = (request: RoutedRequest) => {
        const held = request.origin === TENANT ? runTrace : titleTrace;
        if (request.probe) {
          return jsonResponse({
            data: request.traceIds.includes(held) ? [{ id: `root-${held}`, traceId: held }] : [],
          });
        }
        if (request.origin === CENTRAL) {
          return jsonResponse({ message: 'down' }, 503);
        }
        return jsonResponse({
          data: request.traceIds.includes(runTrace)
            ? [observation({ id: 'run', traceId: runTrace })]
            : [],
        });
      };
      const first = setup({ refs, route });

      const page = await first.reader.listRecords(createQuery());

      expect(page.records.map(({ id }) => id)).toEqual(['run']);
      const later = setup({ refs, route });
      await expect(
        later.reader.listRecords({ ...createQuery(), cursor: page.nextCursor }),
      ).rejects.toMatchObject({ code: 'upstream_error' });
    });

    it('loads sampled responses a segment at a time, ending at the turn a page starts from', async () => {
      const sampledMessages = Array.from({ length: 60 }, (_, index) => ({
        messageId: `response-${index}`,
        langfuseDestinationIds: ['connection-id'],
      }));
      const refs = createRefs({ sampledMessages });
      const first = setup({ refs, route: (request) => recordsFor(request, 'response-59') });

      const page = await first.reader.listRecords(createQuery());

      expect(first.getConversationTraceRefs).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 51 }),
      );
      expect(first.getConversationTraceRefs.mock.calls[0][0]).not.toHaveProperty('through');
      const later = setup({ refs, route: (request) => recordsFor(request, 'response-9') });
      await later.reader.listRecords({ ...createQuery(), cursor: page.nextCursor });

      expect(later.getConversationTraceRefs).toHaveBeenCalledWith(
        expect.objectContaining({
          through: { messageId: 'response-9', orderKey: 'key:response-9' },
          limit: 51,
        }),
      );
      expect(requestedTraceIds(later.fetchMock).sort()).toEqual(
        tracesOf(...sampledMessages.slice(0, 10).map(({ messageId }) => messageId)).sort(),
      );
    });

    it('moves to the next older window of responses within a request when a window has no records', async () => {
      const sampledMessages = Array.from({ length: 60 }, (_, index) => ({
        messageId: `response-${index}`,
        langfuseDestinationIds: ['connection-id'],
      }));
      const { reader, getConversationTraceRefs } = setup({
        refs: createRefs({ sampledMessages }),
        route: (request) => recordsFor(request, 'response-3'),
      });

      const page = await reader.listRecords(createQuery());

      expect(page.records.map(({ id }) => id)).toEqual(['response-3']);
      expect(page.nextCursor).toBeUndefined();
      expect(
        getConversationTraceRefs.mock.calls.map(([input]) => input?.through?.messageId),
      ).toEqual([undefined, 'response-9']);
    });

    it('reports a list read whose cursor repeats instead of serving the same records again', async () => {
      const { reader } = setup({
        route: () =>
          jsonResponse({ data: [observation({ id: 'same' })], meta: { cursor: 'same' } }),
      });

      await expect(
        reader.listRecords(
          createQuery({ settings: resolveTraceViewerConfig({ enabled: true, maxRecords: 2000 }) }),
        ),
      ).rejects.toMatchObject({ code: 'upstream_error' });
    });

    it('treats a root lookup that repeats its cursor as a failed project', async () => {
      const { reader, fetchMock } = setup({
        refs: createRefs({ sampledMessages: [{ messageId: 'legacy-response' }] }),
        route: (request) => {
          if (request.origin === TENANT && request.probe) {
            return jsonResponse({
              data: [{ id: 'root', traceId: traceIdForMessage('legacy-response') }],
              meta: { cursor: 'same' },
            });
          }
          return request.probe
            ? rootsFor(request, 'legacy-response')
            : recordsFor(request, 'legacy-response');
        },
      });

      const page = await reader.listRecords(createQuery());

      expect(calls(fetchMock)).toEqual([
        'probe tenant',
        'probe tenant @same',
        'probe central',
        'read central',
      ]);
      expect(page).toMatchObject({ sourceId: 'central-id' });
    });

    it('bounds how many turns one read asks a project for', async () => {
      const sampledMessages = Array.from({ length: 51 }, (_, index) => ({
        messageId: `response-${index}`,
        langfuseDestinationIds: ['connection-id'],
      }));
      const refs = createRefs({ sampledMessages });
      const first = setup({ refs, responses: [jsonResponse({ data: [observation()] })] });

      const page = await first.reader.listRecords(createQuery());

      expect(requestedTraceIds(first.fetchMock).sort()).toEqual(
        tracesOf(...sampledMessages.slice(1).map(({ messageId }) => messageId)).sort(),
      );
      const later = setup({ refs, responses: [jsonResponse({ data: [] })] });
      await later.reader.listRecords({ ...createQuery(), cursor: page.nextCursor });
      expect(requestedTraceIds(later.fetchMock)).toEqual(tracesOf('response-0'));
    });

    it('fails over when the preferred project fails to answer or to read', async () => {
      const refs = createRefs({
        sampledMessages: [
          { messageId: 'response-1', langfuseDestinationIds: ['central-id', 'connection-id'] },
        ],
      });
      const probeFails = setup({
        refs,
        route: (request) => {
          if (request.origin === TENANT) {
            return jsonResponse({ message: 'expired key' }, 401);
          }
          return request.probe
            ? rootsFor(request, 'response-1')
            : recordsFor(request, 'response-1');
        },
      });
      const readFails = setup({
        refs,
        route: (request) => {
          if (request.probe) {
            return rootsFor(request, 'response-1');
          }
          return request.origin === TENANT
            ? jsonResponse({ message: 'down' }, 503)
            : recordsFor(request, 'response-1');
        },
      });

      const afterProbe = await probeFails.reader.listRecords(createQuery());
      const afterRead = await readFails.reader.listRecords(createQuery());

      expect(calls(probeFails.fetchMock)).toEqual([
        'probe tenant',
        'probe central',
        'read central',
      ]);
      expect(calls(readFails.fetchMock)).toEqual([
        'probe tenant',
        'probe central',
        'read tenant',
        'probe central',
        'read central',
      ]);
      expect(afterProbe).toMatchObject({ sourceId: 'central-id', records: [{ id: 'response-1' }] });
      expect(afterRead).toMatchObject({ sourceId: 'central-id', records: [{ id: 'response-1' }] });
    });

    it('reports a failure that could hide a turn instead of a partial or empty trace', async () => {
      const refs = createRefs({
        sampledMessages: [
          { messageId: 'response-0', langfuseDestinationIds: ['central-id', 'connection-id'] },
          { messageId: 'response-1', langfuseDestinationIds: ['connection-id'] },
        ],
      });
      const route = (request: RoutedRequest) => {
        if (request.origin === CENTRAL) {
          return jsonResponse({ message: 'down' }, 503);
        }
        return request.probe ? rootsFor(request) : recordsFor(request, 'response-1');
      };
      const first = setup({ refs, route });

      const page = await first.reader.listRecords(createQuery());

      expect(page.records.map(({ id }) => id)).toEqual(['response-1']);
      const later = setup({ refs, route });
      await expect(
        later.reader.listRecords({ ...createQuery(), cursor: page.nextCursor }),
      ).rejects.toMatchObject({ code: 'upstream_error' });
    });

    it('reports a failed continuation instead of replaying its segment from another project', async () => {
      const refs = createRefs({
        sampledMessages: [
          { messageId: 'response-1', langfuseDestinationIds: ['central-id', 'connection-id'] },
        ],
      });
      const first = setup({
        refs,
        route: (request) =>
          request.probe
            ? rootsFor(request, 'response-1')
            : jsonResponse({ data: [observation({ id: 'a' })], meta: { cursor: 'next' } }),
      });
      const { nextCursor } = await first.reader.listRecords(
        createQuery({ settings: resolveTraceViewerConfig({ enabled: true, maxRecords: 1 }) }),
      );
      const later = setup({
        refs,
        route: (request) => {
          if (request.probe) {
            return rootsFor(request, 'response-1');
          }
          return request.origin === TENANT
            ? jsonResponse({ message: 'down' }, 503)
            : recordsFor(request, 'response-1');
        },
      });

      await expect(
        later.reader.listRecords({ ...createQuery(), cursor: nextCursor }),
      ).rejects.toMatchObject({ code: 'upstream_error' });
      expect(calls(later.fetchMock)).not.toContain('read central');
    });
    it('reads a turn no project shows a root for yet from the preferred one, since a running turn has none', async () => {
      const { reader, fetchMock } = setup({
        refs: createRefs({ sampledMessages: [{ messageId: 'legacy-response' }] }),
        route: (request) =>
          request.probe
            ? rootsFor(request)
            : jsonResponse({
                data: [
                  observation({
                    id: 'streaming-call',
                    parentObservationId: 'root-not-exported',
                    traceId: traceIdForMessage('legacy-response'),
                    endTime: null,
                  }),
                ],
              }),
      });

      const page = await reader.listRecords(createQuery());

      expect(calls(fetchMock)).toEqual(['probe tenant', 'probe central', 'read tenant']);
      expect(page.records).toEqual([
        expect.objectContaining({ id: 'streaming-call', status: 'running' }),
      ]);
    });

    it('reports a continuation the trace no longer matches, or one Langfuse rejects, as changed', async () => {
      const refs = createRefs({
        sampledMessages: [{ messageId: 'response-1', langfuseDestinationIds: ['connection-id'] }],
      });
      const stale = encodeTestCursor({
        m: 'response-1',
        p: 'key:response-1',
        s: 'connection-id',
        c: 'old',
        h: 'other',
      });
      const staleSegment = setup({ refs, route: (request) => recordsFor(request, 'response-1') });
      const rejected = setup({
        refs,
        route: (request) =>
          request.cursor != null
            ? jsonResponse({ message: 'bad cursor' }, 400)
            : recordsFor(request, 'response-1'),
      });
      const first = setup({
        refs,
        responses: [jsonResponse({ data: [observation({ id: 'a' })], meta: { cursor: 'next' } })],
      });
      const { nextCursor } = await first.reader.listRecords(
        createQuery({ settings: resolveTraceViewerConfig({ enabled: true, maxRecords: 1 }) }),
      );

      await expect(
        staleSegment.reader.listRecords({ ...createQuery(), cursor: stale }),
      ).rejects.toMatchObject({ code: 'invalid_request' });
      await expect(
        rejected.reader.listRecords({ ...createQuery(), cursor: nextCursor }),
      ).rejects.toMatchObject({ code: 'invalid_request' });
      expect(calls(staleSegment.fetchMock)).toEqual([]);
      expect(calls(rejected.fetchMock)).toEqual(['read tenant @next']);
    });
    it('reads a failed turn from the trace of the run its error row stands for', async () => {
      const runTrace = traceIdForMessage('run-1');
      const { reader, fetchMock } = setup({
        refs: createRefs({
          sampledMessages: [
            {
              messageId: 'user-1_',
              langfuseRunId: 'run-1',
              langfuseDestinationIds: ['connection-id'],
            },
          ],
        }),
        responses: [
          jsonResponse({
            data: [
              observation({ id: 'failed-call', traceId: runTrace, level: 'ERROR' }),
              observation({ id: 'row-id-trace', traceId: traceIdForMessage('user-1_') }),
            ],
          }),
        ],
      });

      const page = await reader.listRecords(createQuery());

      expect(requestedTraceIds(fetchMock)).toEqual(tracesOf('run-1'));
      expect(page.records).toEqual([
        expect.objectContaining({ id: 'failed-call', messageId: 'user-1_', status: 'error' }),
      ]);
    });

    it('reports a page whose observations all fail to parse as an upstream failure', async () => {
      const { reader } = setup({
        responses: [jsonResponse({ data: [{ id: 'renamed-fields', trace_id: RESPONSE_TRACE }] })],
      });

      await expect(reader.listRecords(createQuery())).rejects.toMatchObject({
        code: 'upstream_error',
      });
    });

    it('passes the tenant scope to both conversation reads', async () => {
      const { reader, getConversationTraceRefs, hasSampledTraceMessage } = setup({
        responses: [jsonResponse({ data: [observation()] })],
      });

      await reader.isAvailable(createQuery({ tenantId: 'tenant-a' }));
      await reader.listRecords(createQuery({ tenantId: 'tenant-a' }));

      expect(hasSampledTraceMessage).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: 'tenant-a' }),
      );
      expect(getConversationTraceRefs).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: 'tenant-a' }),
      );
    });

    it('treats two credentials for one project as one source instead of replaying its page', async () => {
      const centralAlias = { ...central, id: 'connection-id', authorization: 'Basic alias' };
      const { reader, fetchMock } = setup({
        destinations: [centralAlias, connection],
        refs: createRefs({ sampledMessages: [{ messageId: 'response-1' }] }),
        responses: [jsonResponse({ data: [observation()] })],
      });

      const page = await reader.listRecords(createQuery());

      expect(page.nextCursor).toBeUndefined();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('normalizes owned observations and drops traces the user does not own', async () => {
      const { reader } = setup({
        responses: [
          jsonResponse({
            data: [
              observation(),
              observation({
                id: 'obs-llm',
                parentObservationId: 'obs-root',
                type: 'GENERATION',
                name: 'llm',
                model: 'claude-haiku-4-5',
                completionStartTime: '2026-09-12T11:30:01.000Z',
                usageDetails: {
                  input: 120,
                  output: 30,
                  total: 150,
                  output_reasoning: 10,
                  input_cache_read: 80,
                  input_cache_creation: 40,
                },
                totalCost: 0.0042,
              }),
              observation({
                id: 'obs-tool',
                parentObservationId: 'obs-root',
                type: 'TOOL',
                name: 'web_search',
                endTime: null,
              }),
              observation({
                id: 'obs-failed',
                parentObservationId: 'obs-root',
                type: 'CHAIN',
                name: 'tool-dispatch',
                level: 'ERROR',
                statusMessage: 'Error: Host tool execution failed',
              }),
              observation({
                id: 'obs-title',
                traceId: TITLE_TRACE,
                type: 'CHAIN',
                name: '',
                providedModelName: 'title-model',
              }),
              observation({ id: 'obs-foreign', traceId: FOREIGN_TRACE }),
              { id: 'malformed' },
            ],
          }),
        ],
      });

      const { records } = await reader.listRecords(createQuery());

      expect(records).toEqual([
        {
          id: 'obs-root',
          traceId: RESPONSE_TRACE,
          messageId: 'response-1',
          parentId: null,
          kind: 'agent',
          role: 'run',
          name: 'AgentGraph',
          startTime: '2026-09-12T11:30:00.000Z',
          endTime: '2026-09-12T11:30:05.000Z',
          status: 'ok',
        },
        {
          id: 'obs-llm',
          traceId: RESPONSE_TRACE,
          messageId: 'response-1',
          parentId: 'obs-root',
          kind: 'generation',
          role: 'model',
          name: 'llm',
          model: 'claude-haiku-4-5',
          startTime: '2026-09-12T11:30:00.000Z',
          endTime: '2026-09-12T11:30:05.000Z',
          completionStartTime: '2026-09-12T11:30:01.000Z',
          status: 'ok',
          usage: {
            input: 120,
            output: 30,
            total: 150,
            reasoning: 10,
            cacheRead: 80,
            cacheWrite: 40,
          },
          cost: 0.0042,
        },
        {
          id: 'obs-tool',
          traceId: RESPONSE_TRACE,
          messageId: 'response-1',
          parentId: 'obs-root',
          kind: 'tool',
          name: 'web_search',
          startTime: '2026-09-12T11:30:00.000Z',
          status: 'running',
        },
        {
          id: 'obs-failed',
          traceId: RESPONSE_TRACE,
          messageId: 'response-1',
          parentId: 'obs-root',
          kind: 'span',
          role: 'tools',
          name: 'tool-dispatch',
          startTime: '2026-09-12T11:30:00.000Z',
          endTime: '2026-09-12T11:30:05.000Z',
          status: 'error',
          statusMessage: 'Error: Host tool execution failed',
        },
        {
          id: 'obs-title',
          traceId: TITLE_TRACE,
          messageId: 'response-1',
          parentId: null,
          kind: 'span',
          name: 'chain',
          model: 'title-model',
          startTime: '2026-09-12T11:30:00.000Z',
          endTime: '2026-09-12T11:30:05.000Z',
          status: 'ok',
          origin: 'title',
        },
      ]);
    });

    describe('tool round names', () => {
      const round = (id: string, startTime: string) =>
        observation({
          id,
          parentObservationId: 'obs-root',
          type: 'CHAIN',
          name: 'tool-dispatch',
          startTime,
        });
      const listed = () =>
        jsonResponse({
          data: [
            observation(),
            round('round-1', '2026-09-12T11:30:01.000Z'),
            round('round-2', '2026-09-12T11:30:03.000Z'),
          ],
        });
      const naming = () =>
        createQuery({ settings: resolveTraceViewerConfig({ enabled: true, showToolNames: true }) });
      const toolsOf = (records: Array<{ id: string; tools?: string[] }>) =>
        Object.fromEntries(records.map((record) => [record.id, record.tools]));

      it("names each listed round from the round's own input, in one read scoped to those rounds", async () => {
        const { reader, fetchMock } = setup({
          responses: [
            listed(),
            jsonResponse({
              data: [
                { id: 'round-1', input: '[{"name":"web_search","args":{"query":"secret"}}]' },
                { id: 'round-2', input: [{ name: 'bash_tool' }, { name: 'read_file' }] },
                { id: 'round-elsewhere', input: '[{"name":"not_listed"}]' },
                { id: 'obs-root', input: '[{"name":"not_a_round"}]' },
                { input: 'malformed' },
              ],
            }),
          ],
        });

        const { records } = await reader.listRecords(naming());

        expect(toolsOf(records)).toEqual({
          'obs-root': undefined,
          'round-1': ['web_search'],
          'round-2': ['bash_tool', 'read_file'],
        });
        expect(JSON.stringify(records)).not.toContain('secret');
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(requestedUrl(fetchMock, 1).searchParams.get('fields')).toBe('core,io');
        expect(requestedTraceIds(fetchMock, 1)).toEqual(requestedTraceIds(fetchMock, 0));
        expect(requestedFilter(fetchMock, 1)).toEqual(
          expect.arrayContaining([
            { type: 'string', column: 'sessionId', operator: '=', value: 'convo-1' },
            expect.objectContaining({ column: 'userId' }),
            { type: 'string', column: 'name', operator: '=', value: 'tool-dispatch' },
            {
              type: 'datetime',
              column: 'startTime',
              operator: '>=',
              value: '2026-09-12T11:30:01.000Z',
            },
            {
              type: 'datetime',
              column: 'startTime',
              operator: '<=',
              value: '2026-09-12T11:30:03.000Z',
            },
          ]),
        );
      });

      it('leaves the rounds unnamed, and the page intact, when the names cannot be read', async () => {
        const { reader } = setup({ responses: [listed(), new Error('socket hang up')] });

        const { records } = await reader.listRecords(naming());

        expect(records.map((record) => record.id)).toEqual(['obs-root', 'round-1', 'round-2']);
        expect(toolsOf(records)).toEqual({});
      });

      it('leaves a round unnamed when its input is not the list of calls it ran', async () => {
        const { reader } = setup({
          responses: [
            listed(),
            jsonResponse({
              data: [{ id: 'round-1', input: '{"messages":[{"role":"system","content":"x"}]}' }],
            }),
          ],
        });

        const { records } = await reader.listRecords(naming());

        expect(toolsOf(records)).toEqual({});
      });

      it('reads no names unless the deployment asked for them, or when no round is listed', async () => {
        const unset = setup({ responses: [listed()] });
        await unset.reader.listRecords(createQuery());
        expect(unset.fetchMock).toHaveBeenCalledTimes(1);

        const none = setup({ responses: [jsonResponse({ data: [observation()] })] });
        await none.reader.listRecords(naming());
        expect(none.fetchMock).toHaveBeenCalledTimes(1);
      });

      it('reads the rounds a few at a time, following the cursor until every listed round is seen', async () => {
        const { reader, fetchMock } = setup({
          responses: [
            listed(),
            jsonResponse({
              data: [{ id: 'round-2', input: '[{"name":"bash_tool"}]' }],
              meta: { cursor: 'more-rounds' },
            }),
            jsonResponse({ data: [{ id: 'round-1', input: '[{"name":"web_search"}]' }] }),
          ],
        });

        const { records } = await reader.listRecords(naming());

        expect(toolsOf(records)).toMatchObject({
          'round-1': ['web_search'],
          'round-2': ['bash_tool'],
        });
        expect(fetchMock).toHaveBeenCalledTimes(3);
        expect(requestedUrl(fetchMock, 1).searchParams.get('limit')).toBe('50');
        expect(requestedUrl(fetchMock, 2).searchParams.get('cursor')).toBe('more-rounds');
      });

      it('stops once every listed round is seen, whatever the cursor offers', async () => {
        const { reader, fetchMock } = setup({
          responses: [
            listed(),
            jsonResponse({
              data: [
                { id: 'round-1', input: '[{"name":"web_search"}]' },
                { id: 'round-2', input: '{"messages":[]}' },
              ],
              meta: { cursor: 'more-rounds' },
            }),
          ],
        });

        await reader.listRecords(naming());

        expect(fetchMock).toHaveBeenCalledTimes(2);
      });

      it('stops at its byte budget, keeping the names it has and the page it was adding to', async () => {
        const huge = 'x'.repeat(9 * 1024 * 1024);
        const { reader, fetchMock } = setup({
          responses: [
            listed(),
            jsonResponse({
              data: [{ id: 'round-2', input: '[{"name":"bash_tool"}]' }],
              meta: { cursor: 'more-rounds' },
            }),
            jsonResponse({
              data: [{ id: 'round-1', input: '[{"name":"web_search"}]', output: huge }],
            }),
            jsonResponse({ data: [] }),
          ],
        });

        const { records } = await reader.listRecords(naming());

        expect(records.map((record) => record.id)).toEqual(['obs-root', 'round-1', 'round-2']);
        expect(toolsOf(records)).toEqual({ 'round-2': ['bash_tool'] });
        expect(fetchMock).toHaveBeenCalledTimes(3);
      });
    });

    it('follows Langfuse cursors up to maxRecords and returns the next cursor', async () => {
      const { reader, fetchMock } = setup({
        responses: [
          jsonResponse({
            data: [observation({ id: 'a' }), observation({ id: 'b' })],
            meta: { cursor: 'cursor-1' },
          }),
          jsonResponse({ data: [observation({ id: 'c' })], meta: { cursor: 'cursor-2' } }),
        ],
      });

      const page = await reader.listRecords(
        createQuery({ settings: resolveTraceViewerConfig({ enabled: true, maxRecords: 3 }) }),
      );

      expect(page.records.map(({ id }) => id)).toEqual(['a', 'b', 'c']);
      expect(JSON.parse(Buffer.from(page.nextCursor ?? '', 'base64url').toString())).toEqual({
        m: 'response-1',
        p: 'key:response-1',
        s: 'connection-id',
        c: 'cursor-2',
        h: expect.any(String),
      });
      expect(requestedUrl(fetchMock, 0).searchParams.get('limit')).toBe('3');
      expect(requestedUrl(fetchMock, 0).searchParams.has('cursor')).toBe(false);
      expect(requestedUrl(fetchMock, 1).searchParams.get('limit')).toBe('1');
      expect(requestedUrl(fetchMock, 1).searchParams.get('cursor')).toBe('cursor-1');
    });

    it('continues a page from the same segment after newer turns arrive', async () => {
      const first = setup({
        responses: [jsonResponse({ data: [observation({ id: 'a' })], meta: { cursor: 'next' } })],
        refs: createRefs({
          sampledMessages: [{ messageId: 'response-1', langfuseDestinationIds: ['central-id'] }],
        }),
      });
      const { nextCursor, sourceId } = await first.reader.listRecords(
        createQuery({ settings: resolveTraceViewerConfig({ enabled: true, maxRecords: 1 }) }),
      );
      expect(sourceId).toBe('central-id');

      const later = setup({
        responses: [jsonResponse({ data: [observation({ id: 'b' })], meta: { cursor: null } })],
        refs: createRefs({
          sampledMessages: [
            { messageId: 'response-1', langfuseDestinationIds: ['central-id'] },
            { messageId: 'response-2', langfuseDestinationIds: ['connection-id'] },
            { messageId: 'response-3', langfuseDestinationIds: ['connection-id'] },
          ],
        }),
      });
      const page = await later.reader.listRecords({ ...createQuery(), cursor: nextCursor });

      expect(page).toMatchObject({ sourceId: 'central-id', records: [{ id: 'b' }] });
      expect(page.nextCursor).toBeUndefined();
      expect(requestedUrl(later.fetchMock).origin).toBe('https://central.langfuse.test');
      expect(requestedTraceIds(later.fetchMock)).toEqual(tracesOf('response-1'));
    });

    it('keeps paging a project whose id resolved after the first page', async () => {
      const unresolvedCentral = { ...central, id: undefined };
      const first = setup({
        destinations: [unresolvedCentral],
        refs: createRefs({ sampledMessages: [{ messageId: 'response-1' }] }),
        responses: [jsonResponse({ data: [observation({ id: 'a' })], meta: { cursor: 'next' } })],
      });
      const { nextCursor, sourceId } = await first.reader.listRecords(
        createQuery({ settings: resolveTraceViewerConfig({ enabled: true, maxRecords: 1 }) }),
      );
      const later = setup({
        destinations: [central],
        refs: createRefs({ sampledMessages: [{ messageId: 'response-1' }] }),
        responses: [jsonResponse({ data: [observation({ id: 'b' })] })],
      });

      const page = await later.reader.listRecords({ ...createQuery(), cursor: nextCursor });

      expect(sourceId).toBe('name:central');
      expect(page.records.map(({ id }) => id)).toEqual(['b']);
    });

    it('rejects a forged cursor, one without a position and a turn the conversation no longer has', async () => {
      const { reader, fetchMock } = setup();

      for (const cursor of [
        'bm90IGpzb24',
        encodeTestCursor({ m: 'response-1' }),
        encodeTestCursor({ m: 'deleted-response', p: 'key:deleted-response' }),
      ]) {
        await expect(reader.listRecords({ ...createQuery(), cursor })).rejects.toMatchObject({
          code: 'invalid_request',
        });
      }
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('reports a conversation without an eligible trace as not found', async () => {
      const { reader, fetchMock } = setup({ refs: createRefs({ sampledMessages: [] }) });

      await expect(reader.listRecords(createQuery())).rejects.toMatchObject({ code: 'not_found' });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it.each([
      [401, 'unauthorized'],
      [403, 'unauthorized'],
      [404, 'unsupported'],
      [429, 'rate_limited'],
      [500, 'upstream_error'],
      [400, 'upstream_error'],
    ])('maps a Langfuse %s to %s', async (status, code) => {
      const failure = jsonResponse({ message: 'nope' }, status);
      const { reader } = setup({ responses: [failure] });

      const error = await reader.listRecords(createQuery()).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(TraceReadError);
      expect(error).toMatchObject({ code });
      /** The failed response's body is released, so its connection returns to the pool. */
      expect(failure.bodyUsed).toBe(true);
    });

    it('treats a cursor Langfuse rejects as an invalid request', async () => {
      const { reader } = setup({
        responses: [
          jsonResponse({ data: [observation({ id: 'a' })], meta: { cursor: 'expired' } }),
          jsonResponse({ message: 'bad cursor' }, 400),
        ],
      });

      await expect(
        reader.listRecords(
          createQuery({ settings: resolveTraceViewerConfig({ enabled: true, maxRecords: 2000 }) }),
        ),
      ).rejects.toMatchObject({ code: 'invalid_request' });
    });

    it('stops the Langfuse request when the client goes away', async () => {
      const controller = new AbortController();
      const fetchMock = jest.fn(
        (_url: string, init: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
            controller.abort();
          }),
      );
      const reader = createLangfuseTraceReader({
        getConversationTraceRefs: async () => createRefs(),
        hasSampledTraceMessage: async () => true,
        resolveDestinations: async () => [connection],
        fetch: fetchMock,
        now: () => NOW,
      });

      await expect(
        reader.listRecords(createQuery({ signal: controller.signal })),
      ).rejects.toMatchObject({ code: 'upstream_error', message: 'The trace read was cancelled' });
      expect(fetchMock.mock.calls[0][1].signal?.aborted).toBe(true);
    });

    it('bounds each Langfuse request by the configured timeout', async () => {
      const timeoutSpy = jest.spyOn(AbortSignal, 'timeout');
      const { reader } = setup({ responses: [jsonResponse({ data: [] })] });

      await reader.listRecords(
        createQuery({
          settings: resolveTraceViewerConfig({ enabled: true, requestTimeoutMs: 45_000 }),
        }),
      );

      expect(timeoutSpy).toHaveBeenCalledWith(45_000);
      timeoutSpy.mockRestore();
    });

    it('treats a point-in-time event without an end as completed, not running', async () => {
      const { reader } = setup({
        responses: [
          jsonResponse({
            data: [
              observation({ id: 'event', type: 'EVENT', name: 'checkpoint', endTime: null }),
              observation({ id: 'open-span', type: 'SPAN', endTime: null }),
            ],
          }),
        ],
      });

      const { records } = await reader.listRecords(createQuery());

      expect(records.find(({ id }) => id === 'event')).toMatchObject({
        kind: 'event',
        status: 'ok',
        endTime: '2026-09-12T11:30:00.000Z',
      });
      expect(records.find(({ id }) => id === 'open-span')).toMatchObject({ status: 'running' });
      expect(records.find(({ id }) => id === 'open-span')).not.toHaveProperty('endTime');
    });

    it('maps an aborted request to a timeout and a broken body to an upstream error', async () => {
      const timeout = new Error('The operation was aborted due to timeout');
      timeout.name = 'TimeoutError';
      const { reader } = setup({
        responses: [timeout, new Response('<html>', { status: 200 })],
      });

      await expect(reader.listRecords(createQuery())).rejects.toMatchObject({ code: 'timeout' });
      await expect(reader.listRecords(createQuery())).rejects.toMatchObject({
        code: 'upstream_error',
      });
    });
  });

  describe('getRecord', () => {
    it('reads one observation by id within the session and withholds content by default', async () => {
      const { reader, fetchMock } = setup({
        responses: [jsonResponse({ data: [observation({ input: 'secret prompt' })] })],
      });

      const detail = await reader.getRecord({
        ...createQuery(),
        recordId: 'obs-root',
        messageId: 'response-1',
      });

      expect(detail).toEqual({
        record: expect.objectContaining({ id: 'obs-root', messageId: 'response-1' }),
        contentAvailable: false,
      });
      const params = requestedUrl(fetchMock).searchParams;
      expect(params.get('fields')).toBe('core,basic,time,model,usage');
      expect(JSON.parse(params.get('filter') ?? '[]')).toEqual([
        { type: 'string', column: 'id', operator: '=', value: 'obs-root' },
        { type: 'string', column: 'sessionId', operator: '=', value: 'convo-1' },
        { type: 'stringOptions', column: 'userId', operator: 'any of', value: ['owner'] },
        {
          type: 'stringOptions',
          column: 'traceId',
          operator: 'any of',
          value: [RESPONSE_TRACE, TITLE_TRACE],
        },
        { type: 'datetime', column: 'startTime', operator: '<', value: '2026-09-12T12:10:00.000Z' },
        {
          type: 'datetime',
          column: 'startTime',
          operator: '>=',
          value: '2026-09-12T10:50:00.000Z',
        },
      ]);
    });

    it('returns truncated input, output and metadata when the deployment allows it', async () => {
      const { reader, fetchMock } = setup({
        responses: [
          jsonResponse({
            data: [
              observation({
                input: '{"messages":[{"role":"user","content":"hello"}]}',
                output: 'short',
                metadata: { agentId: 'agent_1' },
              }),
            ],
          }),
        ],
      });

      const detail = await reader.getRecord({
        ...createQuery({
          settings: resolveTraceViewerConfig({
            enabled: true,
            showInputOutput: true,
            maxContentLength: 12,
          }),
        }),
        recordId: 'obs-root',
        messageId: 'response-1',
      });

      expect(requestedUrl(fetchMock).searchParams.get('fields')).toBe(
        'core,basic,time,model,usage,io,metadata',
      );
      expect(detail).toMatchObject({
        contentAvailable: true,
        input: { value: '{"messages":', truncated: true },
        output: { value: 'short', truncated: false },
        metadata: { value: '{"agentId":"', truncated: true },
      });
    });

    it('reads a model call as a conversation, and only a model call', async () => {
      const io = {
        input:
          '{"messages":[{"role":"system","content":"Be brief."},{"role":"user","content":"hello"}]}',
        output: '{"role":"assistant","content":[{"type":"text","text":"Hi."}]}',
      };
      const settings = resolveTraceViewerConfig({ enabled: true, showInputOutput: true });
      const { reader } = setup({
        responses: [
          jsonResponse({ data: [observation({ id: 'obs-llm', type: 'GENERATION', ...io })] }),
          jsonResponse({ data: [observation(io)] }),
        ],
      });

      const modelCall = await reader.getRecord({
        ...createQuery({ settings }),
        recordId: 'obs-llm',
        messageId: 'response-1',
      });
      const wrapper = await reader.getRecord({
        ...createQuery({ settings }),
        recordId: 'obs-root',
        messageId: 'response-1',
      });

      expect(modelCall?.prompt).toEqual({
        total: 2,
        omitted: 0,
        messages: [
          { role: 'system', text: { value: 'Be brief.', truncated: false } },
          { role: 'user', text: { value: 'hello', truncated: false } },
        ],
      });
      expect(modelCall?.reply).toEqual({
        role: 'assistant',
        text: { value: 'Hi.', truncated: false },
      });
      expect(modelCall?.input?.value).toBe(io.input);
      expect(wrapper?.prompt).toBeUndefined();
      expect(wrapper?.reply).toBeUndefined();
    });

    it('keeps literal strings that spell an empty object or null', async () => {
      const { reader } = setup({
        responses: [
          jsonResponse({
            data: [observation({ input: '{}', output: 'null', metadata: {} })],
          }),
        ],
      });

      const detail = await reader.getRecord({
        ...createQuery({
          settings: resolveTraceViewerConfig({ enabled: true, showInputOutput: true }),
        }),
        recordId: 'obs-root',
        messageId: 'response-1',
      });

      expect(detail).toMatchObject({
        contentAvailable: true,
        input: { value: '{}', truncated: false },
        output: { value: 'null', truncated: false },
      });
      expect(detail).not.toHaveProperty('metadata');
    });

    it('reads the detail from the project that listed the record', async () => {
      const { reader, fetchMock } = setup({
        refs: createRefs({ sampledMessages: [{ messageId: 'response-1' }] }),
        responses: [
          jsonResponse({ data: [observation()] }),
          jsonResponse({ data: [observation()] }),
        ],
      });

      await reader.getRecord({
        ...createQuery(),
        recordId: 'obs-root',
        messageId: 'response-1',
        sourceId: 'central-id',
      });
      await reader.getRecord({
        ...createQuery(),
        recordId: 'obs-root',
        messageId: 'response-1',
        sourceId: 'retired-id',
      });

      expect(requestedUrl(fetchMock, 0).origin).toBe('https://central.langfuse.test');
      expect(requestedUrl(fetchMock, 1).origin).toBe('https://tenant.langfuse.test');
    });

    it('fails over a detail read when the pinned project fails', async () => {
      const { reader, fetchMock } = setup({
        refs: createRefs({ sampledMessages: [{ messageId: 'response-1' }] }),
        responses: [
          jsonResponse({ message: 'down' }, 503),
          jsonResponse({ data: [observation()] }),
        ],
      });

      const detail = await reader.getRecord({
        ...createQuery(),
        recordId: 'obs-root',
        messageId: 'response-1',
        sourceId: 'connection-id',
      });

      expect(detail?.record.id).toBe('obs-root');
      expect(requestedUrl(fetchMock, 0).origin).toBe('https://tenant.langfuse.test');
      expect(requestedUrl(fetchMock, 1).origin).toBe('https://central.langfuse.test');
    });

    it('keeps probing projects when one answers without the record', async () => {
      const { reader, fetchMock } = setup({
        refs: createRefs({ sampledMessages: [{ messageId: 'response-1' }] }),
        responses: [jsonResponse({ data: [] }), jsonResponse({ data: [observation()] })],
      });

      const detail = await reader.getRecord({
        ...createQuery(),
        recordId: 'obs-root',
        messageId: 'response-1',
        sourceId: 'retired-id',
      });

      expect(detail?.record.id).toBe('obs-root');
      expect(requestedUrl(fetchMock, 0).origin).toBe('https://tenant.langfuse.test');
      expect(requestedUrl(fetchMock, 1).origin).toBe('https://central.langfuse.test');
    });

    it('asks every project for a detail no project has answered with, and reports a failure that could hide it', async () => {
      const fanout = setup({
        refs: createRefs({
          sampledMessages: [
            { messageId: 'response-1', langfuseDestinationIds: ['central-id', 'connection-id'] },
          ],
        }),
        responses: [jsonResponse({ data: [] }), jsonResponse({ data: [] })],
      });
      const legacy = setup({
        refs: createRefs({ sampledMessages: [{ messageId: 'response-1' }] }),
        responses: [jsonResponse({ message: 'down' }, 503), jsonResponse({ data: [] })],
      });

      await expect(
        fanout.reader.getRecord({
          ...createQuery(),
          recordId: 'obs-root',
          messageId: 'response-1',
        }),
      ).resolves.toBeNull();
      expect(fanout.fetchMock).toHaveBeenCalledTimes(2);
      await expect(
        legacy.reader.getRecord({
          ...createQuery(),
          recordId: 'obs-root',
          messageId: 'response-1',
        }),
      ).rejects.toMatchObject({ code: 'upstream_error' });
      expect(legacy.fetchMock).toHaveBeenCalledTimes(2);
    });

    it('authorizes a detail read by the one turn the list attributed it to', async () => {
      const refs = createRefs({
        sampledMessages: [
          { messageId: 'response-0', langfuseDestinationIds: ['connection-id'] },
          { messageId: 'response-1', langfuseDestinationIds: ['connection-id'] },
        ],
      });
      const { reader, fetchMock, getConversationTraceRefs } = setup({
        refs,
        responses: [
          jsonResponse({ data: [observation({ traceId: traceIdForMessage('response-0') })] }),
        ],
      });

      const detail = await reader.getRecord({
        ...createQuery(),
        recordId: 'obs-root',
        messageId: 'response-1',
      });

      expect(getConversationTraceRefs).toHaveBeenCalledWith(
        expect.objectContaining({ messageId: 'response-1' }),
      );
      expect(requestedTraceIds(fetchMock)).toEqual(tracesOf('response-1'));
      expect(detail).toBeNull();
      await expect(
        reader.getRecord({ ...createQuery(), recordId: 'obs-root', messageId: 'not-sampled' }),
      ).resolves.toBeNull();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('reads the record detail of a failed turn from the trace of its run', async () => {
      const { reader } = setup({
        refs: createRefs({
          sampledMessages: [
            {
              messageId: 'user-1_',
              langfuseRunId: 'run-1',
              langfuseDestinationIds: ['central-id'],
            },
          ],
        }),
        responses: [jsonResponse({ data: [observation({ traceId: traceIdForMessage('run-1') })] })],
      });

      const detail = await reader.getRecord({
        ...createQuery(),
        recordId: 'obs-root',
        messageId: 'user-1_',
      });

      expect(detail?.record).toMatchObject({ id: 'obs-root', messageId: 'user-1_' });
    });

    it('returns null for an observation outside the user-owned traces', async () => {
      const { reader } = setup({
        responses: [jsonResponse({ data: [observation({ traceId: FOREIGN_TRACE })] })],
      });

      await expect(
        reader.getRecord({ ...createQuery(), recordId: 'obs-root', messageId: 'response-1' }),
      ).resolves.toBe(null);
    });
  });

  describe('default destinations', () => {
    const envKeys = [
      'LANGFUSE_PUBLIC_KEY',
      'LANGFUSE_SECRET_KEY',
      'LANGFUSE_PROJECT_ID',
      'LANGFUSE_BASE_URL',
      'LANGFUSE_TRACING_ENABLED',
      'LANGFUSE_SAMPLE_RATE',
    ];

    afterEach(() => {
      for (const key of envKeys) {
        delete process.env[key];
      }
    });

    it('reads the central project with the credentials that exported the trace', async () => {
      process.env.LANGFUSE_PUBLIC_KEY = 'pk';
      process.env.LANGFUSE_SECRET_KEY = 'sk';
      process.env.LANGFUSE_PROJECT_ID = 'central-project';
      process.env.LANGFUSE_BASE_URL = 'https://self-hosted.langfuse.test';
      const fetchMock = jest.fn(
        async (_url: string, _init: RequestInit): Promise<Response> => jsonResponse({ data: [] }),
      );
      const reader = createLangfuseTraceReader({
        resolveDestinations: resolveLangfuseReadDestinations,
        hasSampledTraceMessage: async () => true,
        getConversationTraceRefs: async () =>
          createRefs({
            sampledMessages: [
              {
                messageId: 'response-1',
                langfuseDestinationIds: [
                  getLangfuseDestinationId('https://self-hosted.langfuse.test', 'central-project'),
                ],
              },
            ],
          }),
        fetch: fetchMock,
        now: () => NOW,
      });

      await reader.listRecords(createQuery());

      const [url, init] = fetchMock.mock.calls[0];
      expect(new URL(url).origin).toBe('https://self-hosted.langfuse.test');
      expect(new Headers(init.headers).get('Authorization')).toBe(
        `Basic ${Buffer.from('pk:sk').toString('base64')}`,
      );
    });

    it('never waits on the central project lookup, and asks the client to check again', async () => {
      process.env.LANGFUSE_PUBLIC_KEY = 'pk-slow';
      process.env.LANGFUSE_SECRET_KEY = 'sk-slow';
      process.env.LANGFUSE_BASE_URL = 'https://slow.langfuse.test';
      const lookup = jest.spyOn(global, 'fetch').mockImplementation(() => new Promise(() => {}));
      const hasSampledTraceMessage = jest.fn(async () => false);
      const reader = createLangfuseTraceReader({
        getConversationTraceRefs: async () => createRefs(),
        hasSampledTraceMessage,
        resolveDestinations: resolveLangfuseReadDestinations,
        fetch: jest.fn(),
      });

      await expect(reader.isAvailable(createQuery())).resolves.toEqual({
        available: false,
        retryAfterMs: 30_000,
      });

      expect(lookup).toHaveBeenCalledWith(
        'https://slow.langfuse.test/api/public/projects',
        expect.anything(),
      );
      expect(hasSampledTraceMessage).toHaveBeenCalledWith(
        expect.objectContaining({ destinationIds: [] }),
      );
      lookup.mockRestore();
    });

    it('is unavailable while tracing is disabled', async () => {
      process.env.LANGFUSE_PUBLIC_KEY = 'pk';
      process.env.LANGFUSE_SECRET_KEY = 'sk';
      process.env.LANGFUSE_PROJECT_ID = 'central-project';
      process.env.LANGFUSE_TRACING_ENABLED = 'false';
      const hasSampledTraceMessage = jest.fn(async () => true);
      const reader = createLangfuseTraceReader({
        getConversationTraceRefs: async () =>
          createRefs({ sampledMessages: [{ messageId: 'response-1' }] }),
        hasSampledTraceMessage,
        resolveDestinations: resolveLangfuseReadDestinations,
        fetch: jest.fn(),
      });

      await expect(reader.isAvailable(createQuery())).resolves.toEqual({ available: false });
      expect(hasSampledTraceMessage).not.toHaveBeenCalled();
    });
  });
});
