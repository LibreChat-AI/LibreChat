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

  it('names the reply a continued turn starts from, which keeps its id', () => {
    expect(
      describeCreatedTurn({
        responseMessageId: 'resp-1',
        sourceMessageId: 'resp-1',
        isContinued: true,
      }),
    ).toEqual({ responseMessageId: 'resp-1', sourceMessageId: 'resp-1', isContinued: true });
  });

  it('names the reply an edited rerun starts from beside the new id it is stored under', () => {
    const editedContent = { index: 1, type: ContentTypes.TEXT, text: 'Edited' } as const;
    expect(
      describeCreatedTurn({
        responseMessageId: 'resp-2',
        sourceMessageId: 'resp-1',
        editedContent,
      }),
    ).toEqual({ responseMessageId: 'resp-2', sourceMessageId: 'resp-1', editedContent });
  });

  it('does not name a source for a turn that starts from no reply', () => {
    expect(
      describeCreatedTurn({
        responseMessageId: 'resp-2',
        sourceMessageId: 'resp-1',
        isRegenerate: true,
      }),
    ).toEqual({ responseMessageId: 'resp-2', isRegenerate: true });
  });

  it('leaves out a reply id it was not given', () => {
    expect(describeCreatedTurn({ responseMessageId: null, isRegenerate: true })).toEqual({
      isRegenerate: true,
    });
  });
});
