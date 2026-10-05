import { FileSources, resolveMediaConfig } from 'librechat-data-provider';
import type { Request } from 'express';
import type { MediaContext } from './context';
import { mediaPublicationExpiresAt } from './service';
import { mediaToolContext } from './context';

const context: MediaContext = {
  scope: { ownerId: 'owner', tenantId: null },
  canUse: true,
  canCreate: true,
  config: resolveMediaConfig(),
  appConfig: { config: {}, fileStrategy: FileSources.local, imageOutputType: 'png' },
};
test('retains the original temporary chat deadline on an event-binding resume', () => {
  const deadline = new Date('2099-01-01T00:00:00.000Z');
  const request = {
    body: { isTemporary: false },
    resolvedConversation: { isTemporary: false },
    _agentEventBindingRetention: { isTemporary: true, expiredAt: deadline },
  } as unknown as Request;
  const current = mediaToolContext(request, context, 0);
  expect(current.temporary).toBe(true);
  expect(mediaPublicationExpiresAt(current, true)).toBe(deadline.toISOString());
});
test('an existing saved chat controls temporary state ahead of the submitted body', () => {
  const request = {
    body: { isTemporary: true },
    resolvedConversation: { isTemporary: false },
  } as unknown as Request;
  expect(mediaToolContext(request, context, 0).temporary).toBe(false);
});
test('new temporary chat uses the existing host retention policy', () => {
  const current = mediaToolContext({ body: { isTemporary: true } } as Request, context, 0);
  expect(current.temporary).toBe(true);
  expect(mediaPublicationExpiresAt(current, true)).not.toBeNull();
});
test.each([new Date(0), 'invalid'])(
  'refuses expired or malformed loaded origin deadline %s',
  (expiredAt) => {
    expect(() =>
      mediaToolContext({ resolvedConversation: { expiredAt } } as unknown as Request, context, 1),
    ).toThrow('originating chat has expired');
  },
);
