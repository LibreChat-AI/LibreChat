import { withoutNearAIReceipts } from './sanitize';

it('removes nested and dotted verification metadata without mutating other message data', () => {
  const message = {
    text: 'Imported reply',
    metadata: { nearai: { receipts: [{ status: 'verified' }] }, source: 'archive' },
    'metadata.nearai': { receipts: [] },
    'metadata.nearai.receipts.0.status': 'verified',
    'metadata.other': 'kept',
  };
  expect(withoutNearAIReceipts(message)).toEqual({
    text: 'Imported reply',
    metadata: { source: 'archive' },
    'metadata.other': 'kept',
  });
  expect(message.metadata.nearai.receipts).toHaveLength(1);
  expect(message).toHaveProperty('metadata.nearai.receipts');
});

it.each([{}, { metadata: null }, { metadata: 'legacy' }, { metadata: { source: 'kept' } }])(
  'preserves messages without verification metadata: %j',
  (message) => expect(withoutNearAIReceipts(message)).toEqual(message),
);
