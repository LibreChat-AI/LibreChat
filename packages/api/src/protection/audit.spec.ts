import { logger } from '@librechat/data-schemas';
import type { FiltersConfig } from 'librechat-data-provider';
import type { ShareContentPreflightMessage } from '../shared-links/protection';
import { assertModelBoundContent } from '../middleware/modelBoundContent';
import { createShareContentPreflight } from '../shared-links/protection';
import { ContentFilterError } from '../middleware/contentFilter';
import { inspectContent } from './runtime';

jest.mock('@librechat/data-schemas', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

const AUDIT_PATTERN = {
  id: 'org-token',
  label: 'organization token',
  regex: 'ORG-[A-Z0-9]+',
};

const BLOCK_PATTERN = {
  id: 'private',
  label: 'private value',
  regex: 'PRIVATE-[A-Z]+',
};

const auditFilters: FiltersConfig = {
  messages: {
    pii: {
      action: 'audit',
      starterPatterns: [],
      customPatterns: [AUDIT_PATTERN],
    },
  },
};

function matchingMessages(count: number): ShareContentPreflightMessage[] {
  const messages: ShareContentPreflightMessage[] = [];
  for (let index = 0; index < count; index++) {
    messages.push({ role: 'user', isCreatedByUser: true, text: `ORG-${index}` });
  }
  return messages;
}

function auditCalls(): unknown[][] {
  return (logger.info as jest.Mock).mock.calls.filter(([message]) =>
    String(message).startsWith('[content-filter] Audit-only finding'),
  );
}

describe('audit finding aggregation', () => {
  beforeEach(() => {
    (logger.info as jest.Mock).mockClear();
  });

  it('reports one audit finding per rule for a snapshot that matches thousands of times', async () => {
    const preflight = createShareContentPreflight(auditFilters);

    await expect(
      preflight?.({ title: 'Safe title', messages: matchingMessages(4_096), shareId: 'share-1' }),
    ).resolves.toBeUndefined();

    expect(auditCalls()).toHaveLength(1);
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('"occurrences":4096'),
      expect.objectContaining({ action: 'audit', ruleId: 'org-token', occurrences: 4_096 }),
    );
  });

  it('bounds a repeated retrieval to one aggregated finding per request', async () => {
    const preflight = createShareContentPreflight(auditFilters);
    const messages = matchingMessages(512);

    await preflight?.({ title: 'Safe title', messages, shareId: 'share-1' });
    await preflight?.({ title: 'Safe title', messages, shareId: 'share-1' });

    const calls = auditCalls();
    expect(calls).toHaveLength(2);
    for (const [, metadata] of calls) {
      expect(metadata).toMatchObject({ ruleId: 'org-token', occurrences: 512 });
    }
  });

  it('counts each configured audit rule separately', async () => {
    const preflight = createShareContentPreflight({
      ...auditFilters,
      conversationTitles: {
        pii: {
          action: 'audit',
          starterPatterns: [],
          customPatterns: [AUDIT_PATTERN],
        },
      },
    });

    await preflight?.({ title: 'ORG-TITLE', messages: matchingMessages(8), shareId: 'share-1' });

    const calls = auditCalls();
    expect(calls).toHaveLength(2);
    expect(calls.map(([, metadata]) => metadata)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: 'message', occurrences: 8 }),
        expect.objectContaining({ source: 'conversation_title', occurrences: 1 }),
      ]),
    );
  });

  it('reports aggregated findings when a later message is blocked', async () => {
    const preflight = createShareContentPreflight(auditFilters, {
      legacyPii: { starterPatterns: [], customPatterns: [BLOCK_PATTERN] },
    });

    await expect(
      preflight?.({
        title: 'Safe title',
        messages: [
          ...matchingMessages(64),
          { role: 'user', isCreatedByUser: true, text: 'PRIVATE-VALUE' },
        ],
        shareId: 'share-1',
      }),
    ).rejects.toBeInstanceOf(ContentFilterError);

    expect(auditCalls()).toHaveLength(1);
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('"occurrences":64'),
      expect.objectContaining({ ruleId: 'org-token', occurrences: 64 }),
    );
  });

  it('aggregates the fragments of one model-bound inspection', () => {
    const content: { type: string; text: string }[] = [];
    for (let index = 0; index < 512; index++) {
      content.push({ type: 'text', text: `ORG-${index}` });
    }

    expect(() =>
      assertModelBoundContent({
        filters: auditFilters,
        storedMessages: [{ isCreatedByUser: true, role: 'user', content }],
      }),
    ).not.toThrow();

    expect(auditCalls().map(([, metadata]) => metadata)).toEqual([
      expect.objectContaining({ source: 'message', field: 'content_part', occurrences: 512 }),
      expect.objectContaining({ source: 'assembled_context', occurrences: 1 }),
    ]);
  });

  it('keeps rules whose ids and labels differ only by spacing separate', async () => {
    const preflight = createShareContentPreflight({
      messages: {
        pii: {
          action: 'audit',
          starterPatterns: [],
          customPatterns: [
            { id: 'a', label: 'b c', regex: 'ALPHA' },
            { id: 'a b', label: 'c', regex: 'BETA' },
          ],
        },
      },
    });

    await preflight?.({
      title: 'Safe title',
      messages: [
        { role: 'user', isCreatedByUser: true, text: 'ALPHA' },
        { role: 'user', isCreatedByUser: true, text: 'BETA' },
      ],
      shareId: 'share-1',
    });

    expect(auditCalls().map(([, metadata]) => metadata)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ruleId: 'a', label: 'b c', occurrences: 1 }),
        expect.objectContaining({ ruleId: 'a b', label: 'c', occurrences: 1 }),
      ]),
    );
  });

  it('reports findings immediately outside an aggregation scope', () => {
    const fragment = {
      id: 'message.text',
      text: 'ORG-SECRET',
      path: '/message/text',
      source: 'message',
      field: 'text',
      format: 'plain',
      treatment: 'replaceable',
      provenance: 'user',
    } as const;

    expect(
      inspectContent([fragment, { ...fragment, text: 'ORG-OTHER' }], { filters: auditFilters }),
    ).toBeNull();

    const calls = auditCalls();
    expect(calls).toHaveLength(2);
    for (const [, metadata] of calls) {
      expect(metadata).toMatchObject({ occurrences: 1 });
    }
  });
});
