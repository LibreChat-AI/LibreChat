import { detachEditedNativeContent, portableNativeContent, stripSharedFileIds } from './native';

const source = [
  {
    type: 'text',
    text: 'caption',
    native_media: { continuationRef: 'private-text' },
    thoughtSignature: 'private-signature',
  },
  {
    type: 'image_file',
    native_media: { continuationRef: 'private-image' },
    image_file: {
      file_id: 'owned-file',
      filepath: '/api/media/owned-file',
      filename: 'image.png',
      width: 10,
      height: 20,
    },
  },
  { type: 'text', text: 'after', native_media: { continuationRef: 'private-after' } },
];

describe('native transcript portability', () => {
  it('keeps share-scoped render URLs while removing owner file identity from forks', () => {
    const shared = {
      content: [
        {
          type: 'image_file',
          image_file: { file_id: 'owner-file', filepath: '/api/share/link/files/owner-file' },
        },
      ],
      files: [{ file_id: 'owner-file', filename: 'image.png' }],
    };
    expect(stripSharedFileIds(shared)).toEqual({
      content: [
        {
          type: 'image_file',
          image_file: { file_id: '', filepath: '/api/share/link/files/owner-file' },
        },
      ],
      files: [{ filename: 'image.png' }],
    });
    expect(shared.content[0].image_file.file_id).toBe('owner-file');
  });
  it('keeps visible text and explicit image placeholders without private identity or URLs', () => {
    const portable = portableNativeContent(source);
    expect(portable).toEqual([
      { type: 'text', text: 'caption' },
      {
        type: 'image_file',
        image_file: {
          file_id: '',
          filepath: '',
          filename: 'image.png',
          width: 10,
          height: 20,
          unavailable: 'not_transferred',
        },
      },
      { type: 'text', text: 'after' },
    ]);
    expect(JSON.stringify(portable)).not.toMatch(/private|owned-file/);
    expect(source[0].native_media).toBeDefined();
    expect(portableNativeContent(portable)).toEqual(portable);
  });

  it.each([0, 2])(
    'detaches an edited caption at index %s and preserves remaining native sequence',
    (index) => {
      const edited = detachEditedNativeContent(source, [`/content/${index}/text`]);
      expect(edited[index]).not.toHaveProperty('native_media');
      expect(edited[1]).toBe(source[1]);
      expect(edited[index === 0 ? 2 : 0]).toBe(source[index === 0 ? 2 : 0]);
    },
  );

  it('preserves non-native content and rejects malformed provenance matches', () => {
    expect(detachEditedNativeContent(source, ['/content/0/textual', '/content/1/image_file'])).toBe(
      source,
    );
    expect(portableNativeContent(null)).toBeNull();
  });
});
