import { ContentTypes } from 'librechat-data-provider';
import { describeCreatedTurn } from './turn';

describe('describeCreatedTurn', () => {
  it('names only the reply for a plain new turn', () => {
    expect(describeCreatedTurn({ responseMessageId: 'resp-1' })).toEqual({
      responseMessageId: 'resp-1',
    });
    expect(
      describeCreatedTurn({
        responseMessageId: 'resp-1',
        isRegenerate: false,
        isCompaction: false,
        isContinued: false,
        editedContent: null,
      }),
    ).toEqual({ responseMessageId: 'resp-1' });
  });

  it('says a regeneration is one', () => {
    expect(describeCreatedTurn({ responseMessageId: 'resp-2', isRegenerate: true })).toEqual({
      responseMessageId: 'resp-2',
      isRegenerate: true,
    });
  });

  it('says a compaction is regenerate-shaped as well, which its request does not', () => {
    expect(describeCreatedTurn({ responseMessageId: 'resp-2', isCompaction: true })).toEqual({
      responseMessageId: 'resp-2',
      compact: true,
      isRegenerate: true,
    });
  });

  it('says which reply is continued, and carries the edit an edited one is rerun with', () => {
    expect(describeCreatedTurn({ responseMessageId: 'resp-1', isContinued: true })).toEqual({
      responseMessageId: 'resp-1',
      isContinued: true,
    });
    const editedContent = { index: 1, type: ContentTypes.TEXT, text: 'Edited' } as const;
    expect(describeCreatedTurn({ responseMessageId: 'resp-1', editedContent })).toEqual({
      responseMessageId: 'resp-1',
      editedContent,
    });
  });

  it('leaves out a reply id it was not given', () => {
    expect(describeCreatedTurn({ responseMessageId: null, isRegenerate: true })).toEqual({
      isRegenerate: true,
    });
  });
});
