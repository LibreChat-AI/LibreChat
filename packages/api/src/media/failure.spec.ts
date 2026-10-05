import { preserveNativeErrorResponse } from './failure';

const nativePart = {
  type: 'image_file',
  image_file: { file_id: 'file', filepath: '/images/native.png' },
  native_media: { continuationRef: 'response:0' },
};
function fixture() {
  const metadata = {
    nativeSignatures: { '0': { mimeType: 'image/png', thoughtSignature: 'private' } },
  };
  const saveMessage = jest.fn(async (_context: object, _message: object, _options: object) => ({}));
  const fallback = jest.fn(async () => {});
  const input = {
    client: {
      responseMessageId: 'response',
      contentParts: [nativePart],
      buildResponseMetadata: () => metadata,
    },
    context: { userId: 'owner' },
    conversationId: 'conversation',
    userMessage: { messageId: 'parent', isCreatedByUser: true },
    responseFields: { sender: 'AI', endpoint: 'agents' },
    errorText: 'Provider stream interrupted',
    saveMessage,
  };
  return { input, metadata, saveMessage, fallback };
}

test('persists emitted images and their private metadata after the parent before error publication', async () => {
  const { input, metadata, saveMessage, fallback } = fixture();
  await preserveNativeErrorResponse(input, fallback);
  expect(saveMessage.mock.calls.map((call) => call[1])).toEqual([
    expect.objectContaining({ messageId: 'parent', user: 'owner' }),
    expect.objectContaining({
      messageId: 'response',
      content: [nativePart],
      metadata,
      error: true,
      unfinished: true,
    }),
  ]);
  expect(fallback).not.toHaveBeenCalled();
});

test('leaves ordinary text error persistence with its existing handler', async () => {
  const { input, saveMessage, fallback } = fixture();
  await preserveNativeErrorResponse(
    { ...input, client: { contentParts: [{ type: 'text', text: 'partial' }] } },
    fallback,
  );
  expect(fallback).toHaveBeenCalledTimes(1);
  expect(saveMessage).not.toHaveBeenCalled();
});

test('fails the terminal persistence barrier when an emitted native response cannot be saved', async () => {
  const { input, saveMessage, fallback } = fixture();
  saveMessage.mockRejectedValueOnce(new Error('database unavailable'));
  await expect(preserveNativeErrorResponse(input, fallback)).rejects.toThrow(
    'database unavailable',
  );
  expect(fallback).not.toHaveBeenCalled();
});
