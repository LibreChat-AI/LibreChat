import { renderHook } from '@testing-library/react';
import { ContentTypes } from 'librechat-data-provider';
import type { TMessage } from 'librechat-data-provider';
import useBuildMessageTree from '../useBuildMessageTree';

const image = {
  type: ContentTypes.IMAGE_FILE as const,
  native_media: { continuationRef: 'owner-continuation' },
  image_file: {
    file_id: 'media_owned-image',
    filepath: '/api/media/assets/media_owned-image/content',
    filename: 'image.png',
    user: 'owner',
    bytes: 32,
    embedded: false,
    object: 'file' as const,
    type: 'image/png',
    usage: 1,
    width: 8,
    height: 8,
  },
};
const message: Partial<TMessage> = {
  messageId: 'native-response',
  content: [image],
};

it.each([false, true])(
  'preserves owner image content when building a message tree (recursive=%s)',
  async (recursive) => {
    const { result } = renderHook(() => useBuildMessageTree());
    const tree = await result.current({
      messageId: message.messageId,
      message,
      messages: [],
      recursive,
    });
    const built = Array.isArray(tree) ? tree[0] : tree;
    expect(built?.content).toEqual(message.content);
  },
);
